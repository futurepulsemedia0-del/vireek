// Technician Retention Engine - weekly, rule-based, explainable.
//
// Scores every technician from the trailing 8 weeks of EXISTING operational
// data (schedule changes, timesheets, on-call rotation, pay, callbacks, office
// threads), stores the top-3 plain-language drivers, suggests one concrete fix
// per driver for the owner to approve, and measures whether approved fixes
// actually lowered the score a week later.
//
// Auth: cron -> header X-Cron-Secret (CRON_SECRET must be set), all accounts.
//       app  -> Authorization: Bearer <user JWT>; owner/admin/manager only,
//               that account only ("Recalculate" button).
// Deploy: supabase functions deploy technician-retention-engine --no-verify-jwt
// Schedule: weekly (see the cron snippet in the migration notes / README).
//
// Reads ONLY operational tables. No protected attribute is ever selected.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  computeScore, evaluateOutcome, MODEL_VERSION, OUTCOME_MIN_DAYS, planActions, WINDOW_WEEKS,
  type PlannedAction, type ScoreResult, type TechSignalInputs,
} from "../_shared/technician-retention/scoring.ts";
import {
  hourlyPayCents, isSameDayChange, isUnanswered, onCallDaysByTech, splitEarnings, summarizeRequests,
  weekStartUtc, type EarningEvent, type OnCallSchedule, type ThreadMessage,
} from "../_shared/technician-retention/signals.ts";

type Admin = ReturnType<typeof createClient>;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const DAY = 86_400_000;
const PAGE = 1000;
const CHUNK = 100;
const COOLDOWN_MS = 28 * DAY;
const DEMO_EMAIL = /@demo\.vireek\.invalid$/i;

/** Page through a query (stable order is the caller's job). */
async function fetchAll(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function fetchIn(ids: string[], build: (chunk: string[], from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    out.push(...await fetchAll((from, to) => build(chunk, from, to)));
  }
  return out;
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
const inc = (m: Map<string, number>, k: string | null | undefined, by = 1) => { if (k) m.set(k, (m.get(k) ?? 0) + by); };

interface AccountResult { technicians: number; scored: number; suggested: number; expired: number; outcomes: number }

async function runAccount(admin: Admin, owner: string, now: Date): Promise<AccountResult> {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - WINDOW_WEEKS * 7 * DAY;
  const windowStart = new Date(windowStartMs).toISOString();
  const nowIso = now.toISOString();
  const week = weekStartUtc(now);

  // ---- technicians (demo seed rows are never recomputed)
  const allTechs = await fetchAll((f, t) => admin.from("team_members")
    .select("id, member_name, member_email, created_at")
    .eq("account_owner_id", owner).eq("role", "technician").order("id").range(f, t));
  const techs = allTechs.filter((t) => !DEMO_EMAIL.test(String(t.member_email ?? "")));
  const result: AccountResult = { technicians: techs.length, scored: 0, suggested: 0, expired: 0, outcomes: 0 };
  if (techs.length === 0) return result;
  const techIds = techs.map((t) => String(t.id));
  const techSet = new Set(techIds);

  // ---- jobs in the window (scheduled + completed counts)
  const jobs = await fetchIn(techIds, (ids, f, t) => admin.from("jobs")
    .select("id, assigned_technician_id, job_status")
    .eq("user_id", owner).in("assigned_technician_id", ids)
    .gte("scheduled_datetime", windowStart).lte("scheduled_datetime", nowIso).order("id").range(f, t));
  const scheduled = new Map<string, number>();
  const completed = new Map<string, number>();
  for (const j of jobs) {
    const st = String(j.job_status ?? "");
    if (st === "cancelled" || st === "canceled") continue;
    inc(scheduled, j.assigned_technician_id);
    if (st === "completed") inc(completed, j.assigned_technician_id);
  }

  // ---- same-day schedule changes (attributed to the job's current technician)
  const changes = await fetchAll((f, t) => admin.from("job_schedule_changes")
    .select("id, job_id, previous_scheduled_datetime, changed_at")
    .eq("user_id", owner).gte("changed_at", windowStart).order("id").range(f, t));
  const sameDay = changes.filter((c) => isSameDayChange(String(c.previous_scheduled_datetime), String(c.changed_at)));
  const sameDayJobIds = [...new Set(sameDay.map((c) => String(c.job_id)))];
  const sdJobs = await fetchIn(sameDayJobIds, (ids, f, t) => admin.from("jobs")
    .select("id, assigned_technician_id").eq("user_id", owner).in("id", ids).order("id").range(f, t));
  const jobTech = new Map(sdJobs.map((j) => [String(j.id), j.assigned_technician_id as string | null]));
  const sameDayByTech = new Map<string, number>();
  for (const c of sameDay) {
    const tech = jobTech.get(String(c.job_id));
    if (tech && techSet.has(tech)) inc(sameDayByTech, tech);
  }

  // ---- callbacks: rework jobs point back at the original technician
  const rework = await fetchAll((f, t) => admin.from("jobs")
    .select("id, rework_of_job_id").eq("user_id", owner).eq("is_rework", true)
    .not("rework_of_job_id", "is", null)
    .gte("scheduled_datetime", windowStart).lte("scheduled_datetime", nowIso).order("id").range(f, t));
  const originalIds = [...new Set(rework.map((r) => String(r.rework_of_job_id)))];
  const originals = await fetchIn(originalIds, (ids, f, t) => admin.from("jobs")
    .select("id, assigned_technician_id").eq("user_id", owner).in("id", ids).order("id").range(f, t));
  const originalTech = new Map(originals.map((j) => [String(j.id), j.assigned_technician_id as string | null]));
  const callbacksByTech = new Map<string, number>();
  for (const r of rework) {
    const tech = originalTech.get(String(r.rework_of_job_id));
    if (tech && techSet.has(tech)) inc(callbacksByTech, tech);
  }

  // ---- pay: employees, timesheets, commissions, tips
  const employees = await fetchIn(techIds, (ids, f, t) => admin.from("employees")
    .select("id, team_member_id, pay_type, hourly_rate_cents, annual_salary_cents, overtime_multiplier")
    .eq("user_id", owner).in("team_member_id", ids).order("id").range(f, t));
  const empByTech = new Map<string, Row>();
  for (const e of employees) if (!empByTech.has(String(e.team_member_id))) empByTech.set(String(e.team_member_id), e);
  const techByEmp = new Map(employees.filter((e) => empByTech.get(String(e.team_member_id)) === e).map((e) => [String(e.id), String(e.team_member_id)]));
  const empIds = [...techByEmp.keys()];

  const sheets = await fetchIn(empIds, (ids, f, t) => admin.from("timesheets")
    .select("id, employee_id, work_date, regular_hours, overtime_hours, status")
    .eq("user_id", owner).in("employee_id", ids).gte("work_date", windowStart.slice(0, 10)).order("id").range(f, t));
  const commissions = await fetchIn(empIds, (ids, f, t) => admin.from("commission_records")
    .select("id, employee_id, commission_cents, created_at")
    .eq("user_id", owner).in("employee_id", ids).gte("created_at", windowStart).order("id").range(f, t));
  const tips = await fetchIn(techIds, (ids, f, t) => admin.from("job_tips")
    .select("id, technician_id, amount_cents, received_at")
    .eq("user_id", owner).in("technician_id", ids).gte("received_at", windowStart).order("id").range(f, t));

  const overtime = new Map<string, number>();
  const rejected = new Map<string, number>();
  const hasSheets = new Set<string>();
  const events = new Map<string, EarningEvent[]>();
  const addEvent = (tech: string, at: number, cents: number) => {
    const list = events.get(tech);
    if (list) list.push({ at, cents }); else events.set(tech, [{ at, cents }]);
  };
  for (const s of sheets) {
    const tech = techByEmp.get(String(s.employee_id));
    if (!tech) continue;
    hasSheets.add(tech);
    const reg = num(s.regular_hours);
    const ot = num(s.overtime_hours);
    if (s.status === "rejected") { inc(rejected, tech, reg + ot); continue; }
    inc(overtime, tech, ot);
    const emp = empByTech.get(tech);
    if (emp?.pay_type === "hourly" && emp.hourly_rate_cents != null) {
      addEvent(tech, Date.parse(`${s.work_date}T12:00:00Z`), hourlyPayCents(num(emp.hourly_rate_cents), num(emp.overtime_multiplier) || 1.5, reg, ot));
    }
  }
  for (const c of commissions) {
    const tech = techByEmp.get(String(c.employee_id));
    if (tech) addEvent(tech, Date.parse(String(c.created_at)), num(c.commission_cents));
  }
  for (const tp of tips) addEvent(String(tp.technician_id), Date.parse(String(tp.received_at)), num(tp.amount_cents));
  for (const [tech, emp] of empByTech) {
    if ((emp.pay_type === "salary" || emp.pay_type === "salary_plus_commission") && emp.annual_salary_cents != null) {
      const weekly = Math.round(num(emp.annual_salary_cents) / 52);
      addEvent(tech, nowMs - 14 * DAY, weekly * 4);
      addEvent(tech, nowMs - 42 * DAY, weekly * 4);
    }
  }

  // ---- on-call rotation load vs the team average
  const schedRows = await fetchAll((f, t) => admin.from("on_call_schedules")
    .select("id, rotation_type, timezone, rotation_start_date, handoff_hour")
    .eq("user_id", owner).eq("is_active", true).order("id").range(f, t));
  const schedIds = schedRows.map((s) => String(s.id));
  const memberRows = await fetchIn(schedIds, (ids, f, t) => admin.from("on_call_schedule_members")
    .select("id, schedule_id, team_member_id, position").in("schedule_id", ids).order("id").range(f, t));
  const schedules: OnCallSchedule[] = schedRows.map((s) => ({
    rotation_type: s.rotation_type === "daily" ? "daily" : "weekly",
    timezone: String(s.timezone || "UTC"),
    rotation_start_date: String(s.rotation_start_date),
    handoff_hour: num(s.handoff_hour),
    members: memberRows.filter((m) => m.schedule_id === s.id).map((m) => ({ position: num(m.position), team_member_id: String(m.team_member_id) })),
  }));
  const onCall = onCallDaysByTech(schedules, windowStartMs, nowMs);
  const rotationMembers = new Set(schedules.flatMap((s) => s.members.map((m) => m.team_member_id)));
  const teamAvgOnCall = rotationMembers.size >= 2
    ? [...rotationMembers].reduce((sum, id) => sum + (onCall.get(id) ?? 0), 0) / rotationMembers.size
    : null;

  // ---- unanswered office requests
  const msgRows = await fetchAll((f, t) => admin.from("job_messages")
    .select("id, job_id, sender_role, sender_team_member_id, created_at")
    .eq("user_id", owner).gte("created_at", windowStart).order("id").range(f, t));
  const thread: ThreadMessage[] = msgRows.map((m) => ({
    job_id: String(m.job_id),
    sender_role: m.sender_role === "office" ? "office" : "technician",
    tech_id: m.sender_team_member_id ? String(m.sender_team_member_id) : null,
    at: Date.parse(String(m.created_at)),
  }));
  const requests = summarizeRequests(thread).filter((r) => techSet.has(r.tech_id));
  const requestsByTech = new Map<string, number>();
  const unansweredByTech = new Map<string, number>();
  for (const r of requests) {
    inc(requestsByTech, r.tech_id);
    if (isUnanswered(r, nowMs)) inc(unansweredByTech, r.tech_id);
  }

  // ---- previous score (for the trend arrow)
  const prevRows = await fetchAll((f, t) => admin.from("tech_risk_scores")
    .select("id, tech_id, score, week").eq("user_id", owner).lt("week", week).order("week", { ascending: false }).order("id").range(f, t));
  const prevScore = new Map<string, number>();
  for (const p of prevRows) if (!prevScore.has(String(p.tech_id))) prevScore.set(String(p.tech_id), num(p.score));

  // ---- score every technician
  const results = new Map<string, { score: ScoreResult; name: string }>();
  const scoreRows: Row[] = [];
  for (const t of techs) {
    const id = String(t.id);
    const tenureDays = Math.max(0, Math.floor((nowMs - Date.parse(String(t.created_at))) / DAY));
    const { recent, prior } = splitEarnings(events.get(id) ?? [], nowMs);
    const input: TechSignalInputs = {
      tenureDays,
      scheduledJobs: scheduled.get(id) ?? 0,
      completedJobs: completed.get(id) ?? 0,
      sameDayChanges: sameDayByTech.get(id) ?? 0,
      hasTimesheets: hasSheets.has(id),
      overtimeHours: overtime.get(id) ?? 0,
      rejectedHours: rejected.get(id) ?? 0,
      onCallDays: rotationMembers.has(id) ? (onCall.get(id) ?? 0) : null,
      teamAvgOnCallDays: teamAvgOnCall,
      earningsRecent: recent,
      earningsPrior: prior,
      callbacks: callbacksByTech.get(id) ?? 0,
      techRequests: requestsByTech.get(id) ?? 0,
      unansweredRequests: unansweredByTech.get(id) ?? 0,
    };
    const score = computeScore(input);
    const name = String(t.member_name ?? t.member_email ?? "").trim();
    results.set(id, { score, name });
    const prev = prevScore.get(id);
    scoreRows.push({
      user_id: owner, tech_id: id, week, score: score.score, risk_band: score.band,
      data_quality: score.dataQuality, confidence: score.confidence,
      top_drivers: score.topDrivers, signals: { ...score.signals, _meta: { weeksObserved: score.weeksObserved, newHire: score.newHire, input } },
      attrition_probability: score.attritionProbability, est_replacement_cost: score.replacementCost,
      expected_annual_cost: score.expectedAnnualCost,
      score_delta: prev !== undefined && score.band !== "insufficient" ? score.score - prev : null,
      model_version: MODEL_VERSION, is_demo: false, computed_at: nowIso,
    });
  }
  const { data: saved, error: saveErr } = await admin.from("tech_risk_scores")
    .upsert(scoreRows, { onConflict: "user_id,tech_id,week" }).select("id, tech_id");
  if (saveErr) throw new Error(`save scores: ${saveErr.message}`);
  const scoreIdByTech = new Map((saved ?? []).map((r: Row) => [String(r.tech_id), String(r.id)]));
  result.scored = scoreRows.length;

  // ---- actions: refresh / expire / create, then measure outcomes
  const actionRows = await fetchAll((f, t) => admin.from("retention_actions")
    .select("id, tech_id, action_type, status, decided_at, created_at, baseline_score, outcome")
    .eq("user_id", owner).eq("is_demo", false).order("id").range(f, t));

  const wanted = new Map<string, PlannedAction>(); // key tech|type
  for (const [techId, { score, name }] of results) {
    for (const a of planActions(score, name)) wanted.set(`${techId}|${a.action_type}`, a);
  }

  const openByKey = new Map<string, Row>();
  const recentDecisions = new Set<string>();
  for (const a of actionRows) {
    const key = `${a.tech_id}|${a.action_type}`;
    if (a.status === "suggested") openByKey.set(key, a);
    else if ((a.status === "approved" || a.status === "dismissed") && a.decided_at && nowMs - Date.parse(String(a.decided_at)) < COOLDOWN_MS) recentDecisions.add(key);
  }

  for (const [key, open] of openByKey) {
    const plan = wanted.get(key);
    if (!plan) {
      const { error } = await admin.from("retention_actions").update({ status: "expired" }).eq("id", open.id).eq("status", "suggested");
      if (!error) result.expired += 1;
    } else {
      await admin.from("retention_actions").update({
        title: plan.title, detail: plan.detail, params: plan.params, driver_key: plan.driver_key,
        score_id: scoreIdByTech.get(String(open.tech_id)) ?? null,
      }).eq("id", open.id).eq("status", "suggested");
    }
  }
  for (const [key, plan] of wanted) {
    if (openByKey.has(key) || recentDecisions.has(key)) continue;
    const techId = key.split("|")[0];
    const { error } = await admin.from("retention_actions").insert({
      user_id: owner, tech_id: techId, score_id: scoreIdByTech.get(techId) ?? null,
      action_type: plan.action_type, driver_key: plan.driver_key, title: plan.title, detail: plan.detail,
      params: plan.params, status: "suggested", is_demo: false,
    });
    if (!error) result.suggested += 1;
    else if (error.code !== "23505") console.error("[retention] insert action failed:", error.message);
  }

  for (const a of actionRows) {
    if (a.status !== "approved" || a.outcome || a.baseline_score == null || !a.decided_at) continue;
    if (nowMs - Date.parse(String(a.decided_at)) < OUTCOME_MIN_DAYS * DAY) continue;
    const cur = results.get(String(a.tech_id))?.score;
    if (!cur || cur.band === "insufficient") continue;
    const { error } = await admin.from("retention_actions").update({
      outcome: evaluateOutcome(num(a.baseline_score), cur.score), score_after: cur.score, outcome_checked_at: nowIso,
    }).eq("id", a.id).is("outcome", null);
    if (!error) result.outcomes += 1;
  }

  return result;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const cronSecret = Deno.env.get("CRON_SECRET");
  const isCron = Boolean(cronSecret) && req.headers.get("X-Cron-Secret") === cronSecret;
  let onlyOwner: string | null = null;

  if (!isCron) {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Unauthorized" }, 401);
    const { data: u, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !u?.user) return json({ error: "Invalid or expired session." }, 401);
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false },
    });
    const { data: allowed, error: aErr } = await userClient.rpc("retention_can_manage");
    if (aErr || allowed !== true) return json({ error: "Only owners and managers can run the retention engine." }, 403);
    const { data: ownerId, error: oErr } = await userClient.rpc("get_account_owner_id");
    if (oErr || !ownerId) return json({ error: "Could not resolve account." }, 403);
    onlyOwner = String(ownerId);
  }

  try {
    let owners: string[];
    if (onlyOwner) {
      owners = [onlyOwner];
    } else {
      const rows = await fetchAll((f, t) => admin.from("team_members").select("id, account_owner_id").eq("role", "technician").order("id").range(f, t));
      owners = [...new Set(rows.map((r) => String(r.account_owner_id)))];
    }

    const now = new Date();
    const totals = { accounts: 0, technicians: 0, scored: 0, suggested: 0, expired: 0, outcomes: 0 };
    const errors: { account: string; error: string }[] = [];
    for (const owner of owners) {
      try {
        const r = await runAccount(admin, owner, now);
        totals.accounts += 1;
        totals.technicians += r.technicians;
        totals.scored += r.scored;
        totals.suggested += r.suggested;
        totals.expired += r.expired;
        totals.outcomes += r.outcomes;
      } catch (e) {
        errors.push({ account: owner, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (onlyOwner && errors.length > 0) return json({ error: errors[0].error }, 500);
    return json({ ok: true, week: weekStartUtc(now), ...totals, errors });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
