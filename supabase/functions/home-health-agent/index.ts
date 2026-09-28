// supabase/functions/home-health-agent/index.ts
//
// Autonomous Home Maintenance Agent.
//
//   Detect -> Explain -> Quote -> Schedule -> Dispatch -> Repair -> Verify
//
// One idempotent pass per run (schedule hourly). Every step is a state
// transition on home_health_actions, so a crashed/overlapping run can only
// repeat work that is guarded by an existing row, never duplicate it.
//
// Safety model
//   * Scores/predictions are deterministic (_shared/home-health/scoring.ts).
//   * Customer outreach and dispatch pass through Agent Governance
//     (slugs home_health_outreach / home_health_dispatch). Outreach defaults
//     to owner approval; approve in Dashboard -> Agent Governance.
//   * Prices come ONLY from the owner's price book. No match = no quote,
//     never an invented number.
//   * SMS goes through sendCompliantSms (A2P + DNC/STOP). Max one proactive
//     outreach per customer per 7 days; 90-day cooldown after a decline.
//
// Auth: cron  -> header X-Cron-Secret (CRON_SECRET must be set), all accounts.
//       app   -> Authorization: Bearer <user JWT>, that account only ("Run now").
// Deploy: supabase functions deploy home-health-agent --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { authorizeAgentAction, recordAgentActionOutcome } from "../_shared/governance/agentGovernance.ts";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { assignBestTechnician } from "../_shared/dispatch/assign.ts";
import {
  type EquipmentHealth,
  type EquipmentInput,
  explain,
  scoreEquipment,
  scoreProperty,
} from "../_shared/home-health/scoring.ts";

type Admin = ReturnType<typeof createClient>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MAX_NEW_ACTIONS_PER_ACCOUNT = 25; // onboarding backlog guard
const MAX_OUTREACH_PER_ACCOUNT = 20;
const OUTREACH_COOLDOWN_DAYS = 7; // per customer
const DECLINE_COOLDOWN_DAYS = 90;
const VERIFIED_COOLDOWN_DAYS = 180;
const QUOTE_VALID_DAYS = 30;
const MAINTENANCE_RE = /maint|tune|inspect|install|flush|service plan|membership/i;
const OPEN_STAGES = ["detected", "explained", "awaiting_customer", "scheduled", "dispatched", "repaired"];

interface Counts {
  scored: number; detected: number; quoted: number; awaiting_approval: number;
  accepted: number; scheduled: number; dispatched: number; repaired: number;
  verified: number; declined: number; expired: number; blocked: number;
}
const newCounts = (): Counts => ({
  scored: 0, detected: 0, quoted: 0, awaiting_approval: 0, accepted: 0, scheduled: 0,
  dispatched: 0, repaired: 0, verified: 0, declined: 0, expired: 0, blocked: 0,
});

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function histAppend(hist: unknown, stage: string, note?: string) {
  const arr = Array.isArray(hist) ? hist : [];
  return [...arr, { stage, at: new Date().toISOString(), ...(note ? { note } : {}) }];
}

async function advance(admin: Admin, action: Row, patch: Row, stage?: string, note?: string) {
  const update: Row = { ...patch, updated_at: new Date().toISOString() };
  if (stage && stage !== action.stage) {
    update.stage = stage;
    update.stage_history = histAppend(action.stage_history, stage, note);
    if (["verified", "declined", "dismissed", "expired"].includes(stage)) update.completed_at = new Date().toISOString();
  }
  const { error } = await admin.from("home_health_actions").update(update).eq("id", action.id);
  if (error) console.error(JSON.stringify({ event: "hh_advance_failed", action_id: action.id, error: error.message }));
  Object.assign(action, update);
}

function pickSlot(hours: Row | null, from: Date): Date {
  const keys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  for (let i = 3; i <= 21; i++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + i));
    const cfg = hours ? hours[keys[d.getUTCDay()]] : null;
    let hour = 9;
    if (hours && Object.keys(hours).length > 0) {
      if (!cfg || cfg.closed || !cfg.open) continue;
      const openH = parseInt(String(cfg.open).split(":")[0], 10);
      const closeH = cfg.close ? parseInt(String(cfg.close).split(":")[0], 10) : 24;
      if (Number.isNaN(openH)) continue;
      hour = openH + 1;
      if (hour >= closeH) hour = openH;
    } else if (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      continue;
    }
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  }
  const fallback = new Date(from.getTime() + 3 * 86_400_000);
  fallback.setUTCHours(9, 0, 0, 0);
  return fallback;
}

function matchPriceItem(items: Row[], typeText: string, actionType: string): Row | null {
  const tokens = typeText.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !["unit", "system"].includes(t));
  if (tokens.length === 0) return null;
  const verb = actionType === "replacement_planning" ? /replace|install/i : /maint|tune|flush|service|inspect|clean|check/i;
  for (const item of items) {
    const text = `${item.service_name ?? ""} ${(item.keywords ?? []).join(" ")} ${item.category ?? ""}`.toLowerCase();
    if (tokens.every((t) => text.includes(t)) && verb.test(text)) return item;
  }
  return null;
}

async function processAccount(admin: Admin, userId: string, equipment: Row[], siteUrl: string, counts: Counts) {
  const now = new Date();
  const nowIso = now.toISOString();

  // ---------- 1. DETECT: score every unit + every home --------------------
  const ids = equipment.map((e) => e.id as string);
  const usage = new Map<string, { r12: number; r36: number }>();
  const since36 = new Date(now.getTime() - 3 * 365.25 * 86_400_000);
  const since12 = new Date(now.getTime() - 365.25 * 86_400_000);
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await admin
      .from("job_equipment")
      .select("equipment_id, service_type, jobs!inner(scheduled_datetime, job_status)")
      .in("equipment_id", ids.slice(i, i + 100))
      .gte("jobs.scheduled_datetime", since36.toISOString());
    for (const row of (data ?? []) as Row[]) {
      const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
      if (!job || ["cancelled", "no_show"].includes(job.job_status)) continue;
      if (MAINTENANCE_RE.test(row.service_type ?? "")) continue;
      const u = usage.get(row.equipment_id) ?? { r12: 0, r36: 0 };
      u.r36++;
      if (job.scheduled_datetime && new Date(job.scheduled_datetime) >= since12) u.r12++;
      usage.set(row.equipment_id, u);
    }
  }

  const healthByEq = new Map<string, EquipmentHealth>();
  const byCustomer = new Map<string, EquipmentHealth[]>();
  for (const e of equipment) {
    const u = usage.get(e.id) ?? { r12: 0, r36: 0 };
    const h = scoreEquipment(e as EquipmentInput, { repairs12mo: u.r12, repairs36mo: u.r36 }, now);
    healthByEq.set(e.id, h);
    const list = byCustomer.get(e.customer_id) ?? [];
    list.push(h);
    byCustomer.set(e.customer_id, list);
  }

  const { data: prevScores } = await admin.from("home_health_scores").select("customer_id, score").eq("user_id", userId);
  const prev = new Map<string, number>(((prevScores ?? []) as Row[]).map((r) => [r.customer_id, r.score]));
  for (const [customerId, items] of byCustomer) {
    const prop = scoreProperty(items);
    if (!prop) continue;
    const { error } = await admin.from("home_health_scores").upsert({
      user_id: userId, customer_id: customerId, score: prop.score, grade: prop.grade, confidence: prop.confidence,
      equipment_count: prop.equipment_count, at_risk_count: prop.at_risk_count, breakdown: prop.equipment, computed_at: nowIso,
    }, { onConflict: "customer_id" });
    if (error) { console.error(JSON.stringify({ event: "hh_score_upsert_failed", error: error.message })); continue; }
    counts.scored++;
    if (prev.get(customerId) !== prop.score) {
      await admin.from("home_health_score_history").insert({ user_id: userId, customer_id: customerId, score: prop.score, computed_at: nowIso });
    }
  }

  // ---------- 2. DETECT -> EXPLAIN: open new actions ------------------------
  const { data: existing } = await admin
    .from("home_health_actions")
    .select("equipment_id, action_type, stage, completed_at")
    .eq("user_id", userId);
  const blockedKeys = new Set<string>();
  for (const a of (existing ?? []) as Row[]) {
    const key = `${a.equipment_id}|${a.action_type}`;
    if (OPEN_STAGES.includes(a.stage)) { blockedKeys.add(key); continue; }
    if (!a.completed_at) continue;
    const ageDays = (now.getTime() - new Date(a.completed_at).getTime()) / 86_400_000;
    const cooldown = a.stage === "verified" ? VERIFIED_COOLDOWN_DAYS : DECLINE_COOLDOWN_DAYS;
    if (ageDays < cooldown) blockedKeys.add(key);
  }

  const candidates = [...healthByEq.values()]
    .filter((h) => h.risk !== "low" && h.action_type)
    .sort((a, b) => a.health - b.health);
  let created = 0;
  for (const h of candidates) {
    if (created >= MAX_NEW_ACTIONS_PER_ACCOUNT) break;
    if (blockedKeys.has(`${h.equipment_id}|${h.action_type}`)) continue;
    const { error } = await admin.from("home_health_actions").insert({
      user_id: userId, customer_id: h.customer_id, equipment_id: h.equipment_id, action_type: h.action_type,
      stage: "explained", urgency: h.risk === "high" ? "high" : "medium", health_score: h.health,
      window_min_months: h.window_min_months, window_max_months: h.window_max_months, confidence: h.confidence,
      drivers: h.drivers, explanation: explain(h),
      stage_history: [{ stage: "detected", at: nowIso }, { stage: "explained", at: nowIso }],
    });
    if (error) { if (error.code !== "23505") console.error(JSON.stringify({ event: "hh_insert_failed", error: error.message })); continue; }
    created++; counts.detected++;
  }

  // ---------- load context for the transition steps -------------------------
  const { data: openActions } = await admin
    .from("home_health_actions").select("*").eq("user_id", userId).in("stage", ["explained", "awaiting_customer", "scheduled", "dispatched", "repaired"]);
  const actions = (openActions ?? []) as Row[];
  if (actions.length === 0) return;

  const customerIds = [...new Set(actions.map((a) => a.customer_id as string))];
  const { data: custRows } = await admin.from("customers").select("id, name, phone, email, address").in("id", customerIds);
  const customers = new Map<string, Row>(((custRows ?? []) as Row[]).map((c) => [c.id, c]));
  const eqById = new Map<string, Row>(equipment.map((e) => [e.id as string, e]));
  const { data: profile } = await admin.from("profiles").select("company_name").eq("id", userId).maybeSingle();
  const business = (profile?.company_name as string | undefined) || "Your service team";
  const { data: bp } = await admin.from("business_profile").select("business_hours").eq("user_id", userId).maybeSingle();
  const { data: priceRows } = await admin.from("price_book_items").select("service_name, category, keywords, price_cents, sort_order").eq("user_id", userId).eq("active", true).order("sort_order");
  const priceItems = (priceRows ?? []) as Row[];

  const recentOutreach = new Set<string>();
  const cutoff = new Date(now.getTime() - OUTREACH_COOLDOWN_DAYS * 86_400_000).toISOString();
  const { data: recent } = await admin.from("home_health_actions").select("customer_id").eq("user_id", userId).gte("quoted_at", cutoff);
  for (const r of (recent ?? []) as Row[]) recentOutreach.add(r.customer_id);

  let outreachSent = 0;

  for (const action of actions) {
    try {
      const customer = customers.get(action.customer_id);
      const eq = eqById.get(action.equipment_id);
      const h = healthByEq.get(action.equipment_id);
      if (!customer || !eq) continue;
      const typeText = eq.equipment_type as string;
      const friendly = h?.friendly_type ?? typeText.toLowerCase();

      // ---------- 3. QUOTE (+ outreach) -------------------------------------
      if (action.stage === "explained") {
        if (outreachSent >= MAX_OUTREACH_PER_ACCOUNT) continue;
        if (recentOutreach.has(action.customer_id)) continue;
        if (!customer.phone && !customer.email) {
          await advance(admin, action, { blocked_reason: "Customer has no phone or email on file." });
          counts.blocked++; continue;
        }
        const item = matchPriceItem(priceItems, typeText, action.action_type);
        if (!item) {
          await advance(admin, action, { blocked_reason: `Add a price book item for "${friendly} ${action.action_type === "replacement_planning" ? "replacement" : "maintenance"}" so the agent can quote it.` });
          counts.blocked++; continue;
        }

        const auth = await authorizeAgentAction(admin, {
          userId, actionSlug: "home_health_outreach", agentSource: "home-health-agent",
          targetTable: "home_health_actions", targetId: action.id,
          reasoning: `Proactive ${action.action_type.replace("_", " ")} offer: ${action.explanation}`,
          payload: { customer_id: action.customer_id, equipment_id: action.equipment_id, price_cents: item.price_cents },
        });
        if (auth.decision === "pending_approval") {
          if (action.blocked_reason !== "Waiting for your approval in Agent Governance.") {
            await advance(admin, action, { blocked_reason: "Waiting for your approval in Agent Governance." });
          }
          counts.awaiting_approval++; continue;
        }
        if (auth.decision === "rejected") {
          await advance(admin, action, { blocked_reason: "Rejected in Agent Governance." }, "dismissed", "governance rejected");
          continue;
        }

        let quote: Row | null = null;
        if (action.quote_id) {
          const { data } = await admin.from("quotes").select("id, quote_token, status").eq("id", action.quote_id).maybeSingle();
          quote = data as Row | null;
        }
        if (!quote) {
          const label = `${action.action_type === "replacement_planning" ? "Replacement planning" : "Proactive maintenance"} — ${eq.make ? `${eq.make} ` : ""}${typeText}`;
          const validUntil = new Date(now.getTime() + QUOTE_VALID_DAYS * 86_400_000).toISOString().slice(0, 10);
          const { data: inserted, error } = await admin.from("quotes").insert({
            user_id: userId, customer_id: customer.id, customer_name: customer.name, customer_phone: customer.phone,
            customer_email: customer.email, status: "draft", source: "home_health_agent", valid_until: validUntil,
            line_items: [{ description: item.service_name || label, quantity: 1, unit_price_cents: item.price_cents }],
            notes: action.explanation,
          }).select("id, quote_token, status").single();
          if (error || !inserted) { await recordAgentActionOutcome(admin, auth.logId, { status: "failed", error: error?.message ?? "quote insert failed" }); continue; }
          quote = inserted as Row;
          await advance(admin, action, { quote_id: quote.id });
        }

        const link = `${siteUrl}/quote/${quote.quote_token}`;
        const first = String(customer.name ?? "there").split(" ")[0];
        const window = action.window_min_months && action.window_max_months ? `in about ${action.window_min_months}–${action.window_max_months} months` : "soon";
        const need = action.action_type === "replacement_planning" ? "replacement" : "service";
        const sms = `${business}: Hi ${first}, our system estimates your ${friendly} may need ${need} ${window}. See your proactive quote: ${link} Reply STOP to opt out.`;

        let delivered = false; let failure = "";
        if (customer.phone) {
          const res = await sendCompliantSms(admin, userId, customer.phone, sms);
          delivered = res.ok; if (!res.ok) failure = `${res.reason}${res.detail ? `: ${res.detail}` : ""}`;
        }
        if (!delivered && customer.email) {
          const html = `<p>Hi ${first},</p><p>${action.explanation}</p><p><a href="${link}">View your proactive quote</a> — valid ${QUOTE_VALID_DAYS} days.</p><p>${business}</p>`;
          const res = await sendEmail(customer.email, `${business}: your ${friendly} health check`, html, `${action.explanation}\n\nView your quote: ${link}\n\n${business}`);
          delivered = res.ok; if (!res.ok) failure = res.error ?? failure;
        }

        if (!delivered) {
          await recordAgentActionOutcome(admin, auth.logId, { status: "failed", error: failure || "delivery failed" });
          await advance(admin, action, { blocked_reason: `Could not reach customer (${failure || "no channel"}). Will retry.` });
          counts.blocked++; continue;
        }
        await admin.from("quotes").update({ status: "sent", sent_at: nowIso, updated_at: nowIso }).eq("id", quote.id);
        await recordAgentActionOutcome(admin, auth.logId, { status: "executed", afterState: { quote_id: quote.id } });
        await advance(admin, action, { blocked_reason: null, quoted_at: nowIso }, "awaiting_customer", "quote sent");
        recentOutreach.add(action.customer_id); outreachSent++; counts.quoted++;
        continue;
      }

      // ---------- 4. AWAITING CUSTOMER -> SCHEDULE --------------------------
      if (action.stage === "awaiting_customer") {
        if (!action.quote_id) continue;
        const { data: q } = await admin.from("quotes").select("id, status, valid_until, line_items, tax_percent").eq("id", action.quote_id).maybeSingle();
        if (!q) continue;
        if (q.status === "declined") { await advance(admin, action, {}, "declined", "customer declined"); counts.declined++; continue; }
        if (q.status !== "accepted") {
          if (q.valid_until && new Date(q.valid_until) < now) {
            await admin.from("quotes").update({ status: "expired", updated_at: nowIso }).eq("id", q.id).eq("status", "sent");
            await advance(admin, action, {}, "expired", "quote expired"); counts.expired++;
          }
          continue;
        }
        counts.accepted++;

        const auth = await authorizeAgentAction(admin, {
          userId, actionSlug: "home_health_dispatch", agentSource: "home-health-agent",
          targetTable: "home_health_actions", targetId: action.id,
          reasoning: "Customer accepted the proactive quote — create the job and dispatch the best available technician.",
        });
        if (auth.decision === "pending_approval") { counts.awaiting_approval++; continue; }
        if (auth.decision === "rejected") { await advance(admin, action, { blocked_reason: "Dispatch rejected in Agent Governance." }, "dismissed"); continue; }

        const { data: existingJob } = await admin.from("jobs").select("id, reschedule_token, scheduled_datetime").eq("home_health_action_id", action.id).maybeSingle();
        let job = existingJob as Row | null;
        if (!job) {
          const items = (q.line_items ?? []) as Row[];
          const subtotal = items.reduce((s, li) => s + (li.quantity || 0) * (li.unit_price_cents || 0), 0);
          const total = Math.round(subtotal * (1 + (Number(q.tax_percent) || 0) / 100)) / 100;
          const slot = pickSlot((bp?.business_hours as Row | null) ?? null, now);
          const service = action.action_type === "replacement_planning" ? `${typeText} replacement (proactive)` : `${typeText} maintenance (proactive)`;
          const { data: created, error } = await admin.from("jobs").insert({
            user_id: userId, customer_id: customer.id, customer_name: customer.name, customer_phone: customer.phone,
            service_type: service, address: customer.address, scheduled_datetime: slot.toISOString(),
            duration_minutes: action.action_type === "replacement_planning" ? 240 : 90, job_status: "scheduled",
            invoice_amount: total, quote_id: q.id, home_health_action_id: action.id, tags: ["home-health"],
            dispatch_note: `Created by Home Health Agent. ${action.explanation ?? ""}`.trim(),
          }).select("id, reschedule_token, scheduled_datetime").single();
          if (error || !created) { await recordAgentActionOutcome(admin, auth.logId, { status: "failed", error: error?.message ?? "job insert failed" }); continue; }
          job = created as Row;
          await admin.from("job_equipment").upsert({ job_id: job.id, equipment_id: action.equipment_id, service_type: action.action_type === "replacement_planning" ? "replacement" : "maintenance" });
          await advance(admin, action, { job_id: job.id, blocked_reason: null }, "scheduled", "job created");
          counts.scheduled++;

          if (customer.phone) {
            const when = new Date(job.scheduled_datetime).toUTCString().replace(/:\d\d GMT$/, " UTC");
            await sendCompliantSms(admin, userId, customer.phone,
              `${business}: You're booked for your ${friendly} ${action.action_type === "replacement_planning" ? "replacement visit" : "maintenance visit"} — ${when}. Need another time? ${siteUrl}/reschedule/${job.reschedule_token}`);
          }
        } else if (action.job_id !== job.id) {
          await advance(admin, action, { job_id: job.id }, "scheduled");
        }

        // ---------- 5. DISPATCH ---------------------------------------------
        const assignment = await assignBestTechnician(admin, userId, {
          id: job.id, service_type: null, address: customer.address ?? null, scheduled_datetime: job.scheduled_datetime,
        });
        if (assignment.technicianId) {
          await advance(admin, action, { blocked_reason: null }, "dispatched", `assigned ${assignment.technicianName ?? assignment.technicianId}`);
          counts.dispatched++;
          await recordAgentActionOutcome(admin, auth.logId, { status: "executed", afterState: { job_id: job.id, technician_id: assignment.technicianId } });
        } else {
          await advance(admin, action, { blocked_reason: `No technician assigned yet: ${assignment.reason}` });
        }
        continue;
      }

      // ---------- retry dispatch / track field progress ----------------------
      if (["scheduled", "dispatched", "repaired"].includes(action.stage) && action.job_id) {
        const { data: job } = await admin.from("jobs")
          .select("id, job_status, assigned_technician_id, quality_check_passed, after_photos, scheduled_datetime")
          .eq("id", action.job_id).maybeSingle();
        if (!job) continue;

        if (["cancelled", "no_show"].includes(job.job_status)) {
          await advance(admin, action, { blocked_reason: `Job ${job.job_status}.` }, "dismissed", `job ${job.job_status}`);
          continue;
        }
        if (action.stage === "scheduled" && job.job_status !== "completed") {
          if (job.assigned_technician_id) { await advance(admin, action, { blocked_reason: null }, "dispatched"); counts.dispatched++; }
          else {
            const r = await assignBestTechnician(admin, userId, { id: job.id, service_type: null, address: customer.address ?? null, scheduled_datetime: job.scheduled_datetime });
            if (r.technicianId) { await advance(admin, action, { blocked_reason: null }, "dispatched"); counts.dispatched++; }
          }
          continue;
        }

        // ---------- 6. REPAIR ------------------------------------------------
        if (job.job_status === "completed" && ["scheduled", "dispatched"].includes(action.stage)) {
          if (action.action_type === "maintenance") {
            await admin.from("equipment").update({ last_service_date: nowIso.slice(0, 10) }).eq("id", action.equipment_id);
          }
          await advance(admin, action, { blocked_reason: null }, "repaired", "job completed");
          counts.repaired++;
        }

        // ---------- 7. VERIFY ------------------------------------------------
        if (action.stage === "repaired") {
          const photos = Array.isArray(job.after_photos) ? job.after_photos.length : 0;
          const verified = job.quality_check_passed === true || (job.quality_check_passed !== false && photos > 0);
          if (verified) { await advance(admin, action, { blocked_reason: null }, "verified", "quality gate / after-photos confirmed"); counts.verified++; }
          else { await advance(admin, action, { blocked_reason: "Awaiting quality check or after-photos to verify the repair." }); }
        }
      }
    } catch (err) {
      console.error(JSON.stringify({ event: "hh_action_failed", action_id: action.id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

  const cronSecret = Deno.env.get("CRON_SECRET");
  const isCron = Boolean(cronSecret) && req.headers.get("X-Cron-Secret") === cronSecret;
  let onlyUser: string | null = null;

  if (!isCron) {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Unauthorized" }, 401);
    const { data: u, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !u?.user) return json({ error: "Invalid or expired session." }, 401);
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false },
    });
    const { data: ownerId, error: oErr } = await userClient.rpc("get_account_owner_id");
    if (oErr || !ownerId) return json({ error: "Could not resolve account." }, 403);
    onlyUser = ownerId as string;
  }

  // Load active equipment (paged) grouped per account.
  const byUser = new Map<string, Row[]>();
  for (let from = 0; ; from += 1000) {
    let q = admin.from("equipment")
      .select("id, user_id, customer_id, equipment_type, make, model, install_date, last_service_date, expected_lifespan_years, service_interval_months")
      .eq("status", "active").order("id").range(from, from + 999);
    if (onlyUser) q = q.eq("user_id", onlyUser);
    const { data, error } = await q;
    if (error) return json({ error: error.message }, 500);
    for (const e of (data ?? []) as Row[]) {
      const list = byUser.get(e.user_id) ?? [];
      list.push(e); byUser.set(e.user_id, list);
    }
    if (!data || data.length < 1000) break;
  }

  const counts = newCounts();
  for (const [userId, equipment] of byUser) {
    try { await processAccount(admin, userId, equipment, siteUrl, counts); }
    catch (err) { console.error(JSON.stringify({ event: "hh_account_failed", user_id: userId, error: err instanceof Error ? err.message : String(err) })); }
  }
  return json({ accounts: byUser.size, ...counts });
});
