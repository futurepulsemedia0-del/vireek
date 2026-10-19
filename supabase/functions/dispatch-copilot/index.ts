// supabase/functions/dispatch-copilot/index.ts
//
// "Ask AI Copilot" on the Dispatch Board (src/pages/DispatchBoardPage.tsx).
//
// Contract (what the page expects):
//   POST {}  ->  { recommendations: [{ priority 1-5, title, description, recommended_action }], source, generated_at }
//   Business-rule failures (no permission, hourly limit) return HTTP 200 with { error } so the page can show
//   the exact message in its toast; supabase-js hides the body of non-2xx responses.
//
// SECURITY MODEL
//   * The caller is authenticated from their own JWT; team members act on behalf of their account owner and
//     need can_view_all_jobs (same rule as the Dispatch Board itself).
//   * All reads are hard-scoped to the owner id resolved HERE, never to a client-supplied value.
//   * The model never touches the database. It only receives a compact, deterministic summary of the board
//     computed below, and its answer is validated and clamped before it is returned.
//   * No customer phone numbers or emails are put in the prompt - only first names/last names and the job type.
//   * If every AI provider fails (or returns nothing usable while the board is on fire), a rules engine
//     built from the same facts answers instead, so the button never dead-ends.
//   * Hourly per-user limit via dispatch_copilot_runs (see migration 20271018000200).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { AiCoreError, askVireekAi } from "../_shared/ai-core/index.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const HOUR_MS = 60 * 60 * 1000;
const RATE_LIMIT_PER_HOUR = 20;
const OPEN_STATUSES = ["scheduled", "en_route", "in_progress"];
const MAX_LIST = 12; // per section sent to the model
const DUE_SOON_MINUTES = 180;

interface Recommendation {
  priority: number;
  title: string;
  description: string;
  recommended_action: string;
}

interface JobRow {
  id: string;
  customer_name: string | null;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  duration_minutes: number | null;
  assigned_technician_id: string | null;
  job_status: string;
  customer_type: string | null;
}

interface TechRow {
  id: string;
  member_name: string | null;
  skills: string[] | null;
  service_area: string | null;
  max_jobs_per_day: number | null;
}

interface BoardFacts {
  nowIso: string;
  overdueUnassigned: JobLine[];
  dueSoonUnassigned: JobLine[];
  laterUnassigned: JobLine[];
  lateStarts: JobLine[]; // assigned, still 'scheduled', start time already passed
  technicians: TechLine[];
  totals: { openJobs: number; unassigned: number; technicians: number };
}

interface JobLine {
  customer: string;
  service: string;
  area: string;
  minutes: number | null; // minutes until start (negative = overdue); null = unscheduled
  commercial: boolean;
  technician?: string;
}

interface TechLine {
  name: string;
  jobsNext24h: number;
  max: number;
  skills: string[];
  area: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clean(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  // deno-lint-ignore no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** City/ZIP-level only: drop the street number + street from the address before it reaches a model. */
function areaOf(address: string | null): string {
  if (!address) return "unknown area";
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  return clean(parts.length > 1 ? parts.slice(-2).join(", ") : parts[0] ?? "", 60) || "unknown area";
}

function describeWhen(minutes: number | null): string {
  if (minutes === null) return "unscheduled";
  const abs = Math.abs(minutes);
  const span = abs >= 120 ? `${Math.round(abs / 60)}h` : `${abs}m`;
  return minutes < 0 ? `${span} overdue` : `starts in ${span}`;
}

function lineText(j: JobLine): string {
  const who = j.technician ? ` [tech: ${j.technician}]` : "";
  return `${j.customer} - ${j.service} (${j.area})${j.commercial ? " [commercial]" : ""} - ${describeWhen(j.minutes)}${who}`;
}

function jobLine(j: JobRow, nowMs: number, techNames: Map<string, string>): JobLine {
  const t = j.scheduled_datetime ? new Date(j.scheduled_datetime).getTime() : NaN;
  return {
    customer: clean(j.customer_name, 60) || "Unknown customer",
    service: clean(j.service_type, 40) || "service call",
    area: areaOf(j.address),
    minutes: Number.isFinite(t) ? Math.round((t - nowMs) / 60000) : null,
    commercial: j.customer_type === "commercial",
    technician: j.assigned_technician_id ? techNames.get(j.assigned_technician_id) : undefined,
  };
}

const byUrgency = (a: JobLine, b: JobLine) => (a.minutes ?? Number.MAX_SAFE_INTEGER) - (b.minutes ?? Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------
// Board facts (deterministic - the model only phrases these)
// ---------------------------------------------------------------------------

function buildFacts(jobs: JobRow[], techs: TechRow[], nowMs: number): BoardFacts {
  const techNames = new Map(techs.map((t) => [t.id, clean(t.member_name, 40) || "Technician"]));
  const horizon = nowMs + 24 * HOUR_MS;

  const overdueUnassigned: JobLine[] = [];
  const dueSoonUnassigned: JobLine[] = [];
  const laterUnassigned: JobLine[] = [];
  const lateStarts: JobLine[] = [];
  const load = new Map<string, number>();
  let unassigned = 0;

  for (const j of jobs) {
    const line = jobLine(j, nowMs, techNames);
    if (!j.assigned_technician_id) {
      if (j.job_status !== "scheduled") continue; // an unassigned job already 'in_progress' is a data issue, not a dispatch action
      unassigned++;
      if (line.minutes !== null && line.minutes < 0) overdueUnassigned.push(line);
      else if (line.minutes !== null && line.minutes <= DUE_SOON_MINUTES) dueSoonUnassigned.push(line);
      else laterUnassigned.push(line);
      continue;
    }
    if (j.job_status === "scheduled" && line.minutes !== null && line.minutes < -15) lateStarts.push(line);
    const t = j.scheduled_datetime ? new Date(j.scheduled_datetime).getTime() : NaN;
    if (j.job_status === "in_progress" || (Number.isFinite(t) && t <= horizon)) {
      load.set(j.assigned_technician_id, (load.get(j.assigned_technician_id) ?? 0) + 1);
    }
  }

  overdueUnassigned.sort(byUrgency);
  dueSoonUnassigned.sort(byUrgency);
  laterUnassigned.sort(byUrgency);
  lateStarts.sort(byUrgency);

  const technicians: TechLine[] = techs.map((t) => ({
    name: techNames.get(t.id) ?? "Technician",
    jobsNext24h: load.get(t.id) ?? 0,
    max: t.max_jobs_per_day && t.max_jobs_per_day > 0 ? t.max_jobs_per_day : 8,
    skills: (t.skills ?? []).slice(0, 6).map((s) => clean(s, 24)).filter(Boolean),
    area: clean(t.service_area, 40),
  }));

  return {
    nowIso: new Date(nowMs).toISOString(),
    overdueUnassigned,
    dueSoonUnassigned,
    laterUnassigned,
    lateStarts,
    technicians,
    totals: { openJobs: jobs.length, unassigned, technicians: techs.length },
  };
}

function boardPrompt(f: BoardFacts): string {
  const section = (title: string, rows: JobLine[]) =>
    rows.length
      ? `${title} (${rows.length}):\n${rows.slice(0, MAX_LIST).map((r) => `- ${lineText(r)}`).join("\n")}${rows.length > MAX_LIST ? `\n- ...and ${rows.length - MAX_LIST} more` : ""}`
      : `${title}: none`;
  const techs = f.technicians.length
    ? f.technicians
        .slice(0, 25)
        .map((t) => `- ${t.name}: ${t.jobsNext24h}/${t.max} jobs in the next 24h${t.skills.length ? `, skills: ${t.skills.join(", ")}` : ""}${t.area ? `, area: ${t.area}` : ""}`)
        .join("\n")
    : "- no active technicians";
  return [
    `Dispatch board snapshot at ${f.nowIso} (UTC). Every number below is computed from the database - treat it as ground truth.`,
    `Open jobs: ${f.totals.openJobs}. Unassigned: ${f.totals.unassigned}. Active technicians: ${f.totals.technicians}.`,
    section("OVERDUE and unassigned", f.overdueUnassigned),
    section("Unassigned and starting within 3 hours", f.dueSoonUnassigned),
    section("Assigned but start time already passed (technician has not left)", f.lateStarts),
    section("Unassigned, later", f.laterUnassigned),
    `Technician load:\n${techs}`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Rules engine (fallback + safety net)
// ---------------------------------------------------------------------------

function names(rows: JobLine[], n = 3): string {
  const list = rows.slice(0, n).map((r) => r.customer);
  return list.join(", ") + (rows.length > n ? ` and ${rows.length - n} more` : "");
}

function rulesRecommendations(f: BoardFacts): Recommendation[] {
  const out: Recommendation[] = [];
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  if (f.overdueUnassigned.length) {
    out.push({
      priority: 5,
      title: `${plural(f.overdueUnassigned.length, "overdue job")} with no technician`,
      description: `${names(f.overdueUnassigned)} ${f.overdueUnassigned.length === 1 ? "is" : "are"} past the scheduled start and still unassigned.`,
      recommended_action: "Assign a technician now, or call the customer with a new arrival window before they cancel.",
    });
  }
  if (f.dueSoonUnassigned.length) {
    out.push({
      priority: 4,
      title: `${plural(f.dueSoonUnassigned.length, "job")} start within 3 hours, unassigned`,
      description: `${names(f.dueSoonUnassigned)} ${f.dueSoonUnassigned.length === 1 ? "has" : "have"} no technician yet.`,
      recommended_action: "Assign the closest available technician with the matching skill now.",
    });
  }
  if (f.lateStarts.length) {
    out.push({
      priority: 4,
      title: `${plural(f.lateStarts.length, "assigned job")} running late to start`,
      description: `${names(f.lateStarts)} ${f.lateStarts.length === 1 ? "is" : "are"} past the start time and still marked scheduled.`,
      recommended_action: "Check in with the assigned technician and send the customer an updated ETA.",
    });
  }
  const over = f.technicians.filter((t) => t.jobsNext24h > t.max);
  if (over.length) {
    out.push({
      priority: 3,
      title: `${plural(over.length, "technician")} over daily capacity`,
      description: over.slice(0, 3).map((t) => `${t.name} has ${t.jobsNext24h} jobs against a limit of ${t.max}`).join("; ") + ".",
      recommended_action: "Move the lowest-priority job to a technician with open capacity.",
    });
  }
  const free = f.technicians.filter((t) => t.jobsNext24h === 0);
  if (free.length && f.totals.unassigned > 0) {
    out.push({
      priority: 3,
      title: "Idle technicians while jobs wait",
      description: `${free.slice(0, 3).map((t) => t.name).join(", ")} ${free.length === 1 ? "has" : "have"} nothing booked in the next 24h, but ${plural(f.totals.unassigned, "job")} ${f.totals.unassigned === 1 ? "is" : "are"} unassigned.`,
      recommended_action: "Assign the waiting jobs to the idle technicians.",
    });
  }
  if (f.laterUnassigned.length && !out.some((r) => r.priority >= 4)) {
    out.push({
      priority: 2,
      title: `${plural(f.laterUnassigned.length, "upcoming job")} still unassigned`,
      description: `${names(f.laterUnassigned)} ${f.laterUnassigned.length === 1 ? "is" : "are"} not yet assigned.`,
      recommended_action: "Assign these now while there is plenty of lead time.",
    });
  }
  return out.sort((a, b) => b.priority - a.priority).slice(0, 5);
}

// ---------------------------------------------------------------------------
// Model output validation
// ---------------------------------------------------------------------------

function parseRecommendations(raw: string): Recommendation[] {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  let parsed: unknown;
  const a = cleaned.indexOf("[");
  const b = cleaned.lastIndexOf("]");
  if (a !== -1 && b > a) {
    try {
      parsed = JSON.parse(cleaned.slice(a, b + 1));
    } catch {
      parsed = undefined;
    }
  }
  if (parsed === undefined) {
    const c = cleaned.indexOf("{");
    const d = cleaned.lastIndexOf("}");
    if (c === -1 || d <= c) throw new Error("No JSON in model output");
    const obj = JSON.parse(cleaned.slice(c, d + 1)) as { recommendations?: unknown };
    parsed = obj.recommendations;
  }
  if (!Array.isArray(parsed)) throw new Error("Model output is not an array");

  const out: Recommendation[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const title = clean(r.title, 120);
    const description = clean(r.description, 400);
    const action = clean(r.recommended_action, 300);
    const p = Math.round(Number(r.priority));
    if (!title || !description || !action || !Number.isFinite(p)) continue;
    out.push({ priority: Math.min(5, Math.max(1, p)), title, description, recommended_action: action });
  }
  return out.sort((x, y) => y.priority - x.priority).slice(0, 5);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    // ---- authenticate -------------------------------------------------
    const accessToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!accessToken) return json({ error: "Missing Authorization header" }, 401);
    const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
    if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
    const userId = userData.user.id;

    // ---- resolve tenant + permission ---------------------------------
    const { data: tm, error: tmError } = await admin
      .from("team_members")
      .select("account_owner_id, permissions, custom_role:custom_roles(permissions)")
      .eq("user_id", userId)
      .eq("invite_status", "active")
      .maybeSingle();
    if (tmError) {
      console.error("[dispatch-copilot] team lookup failed:", tmError.message);
      return json({ error: "Could not verify your permissions. Please try again." }, 500);
    }
    const ownerId: string = tm?.account_owner_id ?? userId;
    if (tm) {
      const custom = (tm as { custom_role?: { permissions?: Record<string, boolean> } | null }).custom_role?.permissions ?? {};
      const effective = { ...((tm.permissions as Record<string, boolean> | null) ?? {}), ...custom };
      if (!effective.can_view_all_jobs) return json({ error: "You don't have permission to use the dispatch copilot." });
    }

    // ---- per-user hourly limit (fails open only if the table itself is unavailable) ----
    const since = new Date(Date.now() - HOUR_MS).toISOString();
    const { count, error: countError } = await admin
      .from("dispatch_copilot_runs")
      .select("id", { count: "exact", head: true })
      .eq("actor_id", userId)
      .gte("created_at", since);
    if (countError) {
      console.error("[dispatch-copilot] rate-limit lookup failed (apply migration 20271018000200?):", countError.message);
    } else if ((count ?? 0) >= RATE_LIMIT_PER_HOUR) {
      return json({ error: "You've reached the AI Copilot's hourly limit. Try again in a bit." });
    }
    await admin.from("dispatch_copilot_runs").insert({ user_id: ownerId, actor_id: userId });
    // Housekeeping: keep only a week of history per user.
    await admin
      .from("dispatch_copilot_runs")
      .delete()
      .eq("actor_id", userId)
      .lt("created_at", new Date(Date.now() - 7 * 24 * HOUR_MS).toISOString());

    // ---- read the board (owner-scoped) -------------------------------
    const nowMs = Date.now();
    const lowerBound = new Date(nowMs - 14 * 24 * HOUR_MS).toISOString();
    const upperBound = new Date(nowMs + 36 * HOUR_MS).toISOString();
    const jobColumns =
      "id, customer_name, service_type, address, scheduled_datetime, duration_minutes, assigned_technician_id, job_status, customer_type";

    const loadJobs = (excludeTrashed: boolean) => {
      let q = admin
        .from("jobs")
        .select(jobColumns)
        .eq("user_id", ownerId)
        .in("job_status", OPEN_STATUSES)
        .or(`scheduled_datetime.is.null,and(scheduled_datetime.gte.${lowerBound},scheduled_datetime.lte.${upperBound})`)
        .order("scheduled_datetime", { ascending: true, nullsFirst: true })
        .limit(300);
      if (excludeTrashed) q = q.is("deleted_at", null);
      return q;
    };

    let jobsRes = await loadJobs(true);
    // Projects that have not added soft-delete (jobs.deleted_at) yet: retry without the filter.
    if (jobsRes.error && /deleted_at/i.test(jobsRes.error.message)) jobsRes = await loadJobs(false);

    const techRes = await admin
      .from("team_members")
      .select("id, member_name, skills, service_area, max_jobs_per_day")
      .eq("account_owner_id", ownerId)
      .eq("role", "technician")
      .eq("invite_status", "active")
      .limit(100);

    if (jobsRes.error || techRes.error) {
      console.error("[dispatch-copilot] board read failed:", jobsRes.error?.message ?? techRes.error?.message);
      return json({ error: "Could not read the dispatch board right now." }, 500);
    }

    const facts = buildFacts((jobsRes.data ?? []) as JobRow[], (techRes.data ?? []) as TechRow[], nowMs);
    const generatedAt = new Date().toISOString();

    // Nothing open at all: no reason to spend a model call.
    if (facts.totals.openJobs === 0) {
      return json({ recommendations: [], source: "rules", generated_at: generatedAt });
    }

    const rules = rulesRecommendations(facts);

    // ---- ask the model -----------------------------------------------
    try {
      const result = await askVireekAi({
        task: "dispatch_copilot",
        jsonMode: true,
        maxTokens: 900,
        temperature: 0.2,
        timeoutMs: 25_000,
        messages: [{ role: "user", content: boardPrompt(facts) }],
        security: {
          userId: ownerId,
          agentSource: "dispatch-copilot",
          dataDomains: ["customers", "location"],
          externalSend: false,
          writes: false,
          admin,
        },
      });
      console.log(
        `[dispatch-copilot] provider=${result.meta.provider} model=${result.meta.model} fallback=${result.meta.wasFallback} latencyMs=${result.meta.latencyMs}`,
      );

      const ai = parseRecommendations(result.text);
      // Safety net: never let an empty/soft answer hide an urgent board.
      if (ai.length === 0 && rules.some((r) => r.priority >= 4)) {
        return json({ recommendations: rules, source: "rules", generated_at: generatedAt });
      }
      return json({ recommendations: ai, source: "ai", generated_at: generatedAt });
    } catch (err) {
      const kind = err instanceof AiCoreError ? "AiCoreError" : "error";
      console.error(`[dispatch-copilot] model step failed (${kind}); answering from rules:`, err);
      return json({ recommendations: rules, source: "rules", generated_at: generatedAt });
    }
  } catch (err) {
    console.error("[dispatch-copilot] unexpected error:", err);
    return json({ error: "AI Copilot could not analyze the board right now." }, 500);
  }
});
