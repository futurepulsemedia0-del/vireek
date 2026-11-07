// supabase/functions/results-plan-ingest/index.ts
//
// Cron (X-Cron-Secret = RESULTS_PLAN_CRON_SECRET): for every ACTIVE Results Plan account, qualify recent Sarah-booked jobs,
// append evidence to the hash-chained proof_ledger (idempotent), create pending charges for billable jobs, void charges
// cancelled inside the window, and raise integrity flags. Service role: EVERY query is scoped by user_id.
// Limitation (documented): only voice calls (calls.id via jobs.call_id) count as Sarah's first contact today.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { qualifyJob, RESULTS_PLAN_DEFAULTS, type JobFacts, type PriorJob, type RulesConfig } from "../_shared/results-plan/qualification.ts";
import { detectAnomalies, type WeekStat } from "../_shared/results-plan/anomaly.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const BATCH = 25;
const BUDGET_MS = 100_000;
const LOOKBACK_DAYS = 120;
const PRIOR_DAYS = 400;
const MAX_JOBS = 5000;
const DAY = 86_400_000;
const PERSISTENT_REJECTIONS = new Set<string>(["duplicate", "existing_open_job", "rework", "owner_created", "internal_test"]);

type Admin = SupabaseClient;
interface Account {
  user_id: string; billing_level: RulesConfig["billingLevel"]; existing_work_window_days: number; duplicate_window_hours: number;
  cancel_window_hours: number; confirmed_fallback_days: number | null; rule_version: string; terms_id: string | null; opted_in_at: string;
}
interface JobRow {
  id: string; call_id: string | null; customer_id: string | null; service_type: string | null; address: string | null;
  job_status: JobFacts["status"]; created_at: string; confirmed_at: string | null; completed_at: string | null; cancelled_at: string | null;
  paid_at: string | null; job_source: JobFacts["source"] | null; scheduled_datetime: string | null; is_rework: boolean | null; rework_of_job_id: string | null;
}
interface CallRow { id: string; status: string | null; call_datetime: string; transcript: string | null; recording_url: string | null; is_voicemail: boolean | null }

const normAddr = (a: string | null) => { const s = (a ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); return s.length >= 6 ? s : null; };
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const monday = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };

async function append(admin: Admin, a: Account, jobId: string, event: string, key: string, evidence: Record<string, unknown>) {
  const { error } = await admin.rpc("proof_ledger_append", { p_user: a.user_id, p_job: jobId, p_event: event, p_key: key, p_rule: a.rule_version, p_evidence: evidence });
  if (error) throw new Error(`ledger:${event}:${error.message}`);
}

async function ingestAccount(admin: Admin, a: Account): Promise<{ qualified: number; charges: number; voided: number; flags: number }> {
  const now = Date.now();
  const since = new Date(Math.max(Date.parse(a.opted_in_at), now - LOOKBACK_DAYS * DAY)).toISOString();
  const priorSince = new Date(now - PRIOR_DAYS * DAY).toISOString();
  const cols = "id,call_id,customer_id,service_type,address,job_status,created_at,confirmed_at,completed_at,cancelled_at,paid_at,job_source,scheduled_datetime,is_rework,rework_of_job_id";
  const { data: jobsData, error: jobsErr } = await admin.from("jobs").select(cols).eq("user_id", a.user_id).gte("created_at", priorSince).order("created_at", { ascending: true }).limit(MAX_JOBS);
  if (jobsErr) throw new Error(`jobs:${jobsErr.message}`);
  const jobs = (jobsData ?? []) as JobRow[];
  const optedAt = Date.parse(a.opted_in_at);
  const candidates = jobs.filter((j) => Date.parse(j.created_at) >= Date.parse(since) && Date.parse(j.created_at) >= optedAt);

  const callIds = [...new Set(candidates.map((j) => j.call_id).filter((x): x is string => !!x))];
  const calls = new Map<string, CallRow>();
  for (let i = 0; i < callIds.length; i += 200) {
    const { data } = await admin.from("calls").select("id,status,call_datetime,transcript,recording_url,is_voicemail").eq("user_id", a.user_id).in("id", callIds.slice(i, i + 200));
    for (const c of (data ?? []) as CallRow[]) calls.set(c.id, c);
  }
  const jobIds = candidates.map((j) => j.id);
  const flagsMap = new Map<string, Set<string>>();
  const charges = new Map<string, { id: string; status: string }>();
  const rejected = new Set<string>(); // deterministic rejections are final (see PERSISTENT_REJECTIONS)
  for (let i = 0; i < jobIds.length; i += 200) {
    const slice = jobIds.slice(i, i + 200);
    const { data: fl } = await admin.from("results_plan_job_flags").select("job_id,flag,source,accepted_at").eq("user_id", a.user_id).in("job_id", slice);
    for (const f of (fl ?? []) as Array<{ job_id: string; flag: string; source: string; accepted_at: string | null }>) {
      if (f.source !== "owner" || f.accepted_at) { const s = flagsMap.get(f.job_id) ?? new Set(); s.add(f.flag); flagsMap.set(f.job_id, s); }
    }
    const { data: ch } = await admin.from("results_plan_charges").select("id,job_id,status").eq("user_id", a.user_id).in("job_id", slice);
    for (const c of (ch ?? []) as Array<{ id: string; job_id: string; status: string }>) charges.set(c.job_id, { id: c.id, status: c.status });
    const { data: rj } = await admin.from("proof_ledger").select("job_id").eq("user_id", a.user_id).eq("event_type", "rejected").in("job_id", slice);
    for (const r of (rj ?? []) as Array<{ job_id: string }>) rejected.add(r.job_id);
  }

  const cfg: RulesConfig = { billingLevel: a.billing_level, existingWorkWindowDays: a.existing_work_window_days, duplicateWindowHours: a.duplicate_window_hours, cancelWindowHours: a.cancel_window_hours, confirmedFallbackDays: a.confirmed_fallback_days ?? null };
  const priorOf = (j: JobRow): PriorJob[] => jobs.filter((p) => p.id !== j.id).map((p) => ({ id: p.id, customerKey: p.customer_id, addressKey: normAddr(p.address), createdAt: p.created_at, status: p.job_status }));
  const out = { qualified: 0, charges: 0, voided: 0, flags: 0 };
  let relabeled = 0;

  for (const j of candidates) {
    if (rejected.has(j.id)) continue;
    const existing = charges.get(j.id);
    if (existing && (existing.status === "voided" || existing.status === "credited")) continue; // terminal
    const call = j.call_id ? calls.get(j.call_id) ?? null : null;
    const fl = flagsMap.get(j.id) ?? new Set<string>();
    const source: JobFacts["source"] = fl.has("test") ? "test" : j.job_source ?? (call ? "sarah" : "unknown");
    const facts: JobFacts = {
      id: j.id, customerKey: j.customer_id, addressKey: normAddr(j.address), createdAt: j.created_at, source, status: j.job_status,
      isRework: !!j.is_rework || !!j.rework_of_job_id,
      confirmedAt: j.confirmed_at, completedAt: j.completed_at, paidAt: j.paid_at, cancelledAt: j.cancelled_at,
    };
    const res = qualifyJob(facts, {
      handledBySarah: !!call && !call.is_voicemail, channel: call ? "call" : null,
      isSpam: call?.status === "spam" || fl.has("spam"), isWrongNumber: fl.has("wrong_number"),
    }, priorOf(j), cfg, new Date(now).toISOString());

    // Re-labelling: a posted charge whose completion mark has since disappeared.
    if (existing?.status === "posted" && (cfg.billingLevel === "completed" || cfg.billingLevel === "paid") && !j.completed_at) relabeled++;
    if (!res.qualified) {
      // Final rejections are written once. Spam / wrong-number / first-contact can still change later, so they are NOT persisted.
      if (!existing && res.reasons.some((r) => PERSISTENT_REJECTIONS.has(r))) {
        await append(admin, a, j.id, "rejected", `rejected:${j.id}`, { reasons: res.reasons.filter((r) => PERSISTENT_REJECTIONS.has(r)), job_created_at: j.created_at });
      }
      continue;
    }

    const excerpt = (call?.transcript ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
    const base = {
      job_created_at: j.created_at, call_id: call?.id ?? null, call_at: call?.call_datetime ?? null, channel: "call",
      transcript_excerpt_sha256: excerpt ? await sha256Hex(excerpt) : null, recording_available: !!call?.recording_url,
      job_type: (j.service_type ?? "").trim().toLowerCase() || null, billing_level: cfg.billingLevel, billed_at_level: res.billedAtLevel, via_fallback: res.viaFallback, level: res.level,
      reasons: [] as string[], crm_job_id: null,
    };
    await append(admin, a, j.id, "qualified", `qualified:${j.id}`, base); out.qualified++;
    if (j.confirmed_at) await append(admin, a, j.id, "confirmed", `confirmed:${j.id}`, { at: j.confirmed_at });
    if (j.completed_at) await append(admin, a, j.id, "completed", `completed:${j.id}`, { at: j.completed_at });
    if (j.paid_at) await append(admin, a, j.id, "paid", `paid:${j.id}`, { at: j.paid_at });

    if (res.voided) {
      await append(admin, a, j.id, "voided", `voided:${j.id}`, { cancelled_at: j.cancelled_at, window_hours: cfg.cancelWindowHours });
      if (existing && (existing.status === "pending" || existing.status === "posted")) {
        const next = existing.status === "posted" ? "credited" : "voided";
        await admin.from("results_plan_charges").update({ status: next, updated_at: new Date().toISOString() }).eq("id", existing.id).eq("user_id", a.user_id).in("status", ["pending", "posted"]);
        if (next === "credited") await append(admin, a, j.id, "credited", `credit:${existing.id}`, { charge_id: existing.id, auto: true, why: "cancelled inside window" });
        out.voided++;
      }
      continue;
    }
    if (res.billable && !existing && res.billableAt) {
      const { error } = await admin.from("results_plan_charges").upsert({
        user_id: a.user_id, job_id: j.id, status: "pending", job_type: base.job_type, verified_at: res.billableAt,
        month: res.billableAt.slice(0, 7), terms_id: a.terms_id, billed_at_level: res.billedAtLevel, via_fallback: res.viaFallback,
      }, { onConflict: "user_id,job_id", ignoreDuplicates: true });
      if (error) throw new Error(`charge:${error.message}`);
      out.charges++;
    }
  }

  // Integrity flags (both directions) from the last 6 ISO weeks.
  const weeks: WeekStat[] = [];
  const thisMonday = monday(new Date(now));
  for (let w = 5; w >= 0; w--) {
    const start = new Date(thisMonday.getTime() - w * 7 * DAY), end = new Date(start.getTime() + 7 * DAY);
    const due = jobs.filter((j) => j.job_source !== "owner" && !!j.call_id && j.scheduled_datetime && Date.parse(j.scheduled_datetime) >= start.getTime() && Date.parse(j.scheduled_datetime) < Math.min(end.getTime(), now));
    const marked = due.filter((j) => !!j.completed_at).length;
    weeks.push({ weekStart: start.toISOString().slice(0, 10), due: due.length, marked, relabeledAfterCharge: w === 0 ? relabeled : 0, qualified: 0 });
  }
  const { data: wc } = await admin.from("results_plan_charges").select("created_at").eq("user_id", a.user_id).gte("created_at", new Date(thisMonday.getTime() - 5 * 7 * DAY).toISOString());
  for (const c of (wc ?? []) as Array<{ created_at: string }>) {
    const idx = 5 - Math.floor((thisMonday.getTime() - monday(new Date(c.created_at)).getTime()) / (7 * DAY));
    if (idx >= 0 && idx < 6) weeks[idx].qualified++;
  }
  for (const f of detectAnomalies(weeks)) {
    await admin.from("results_plan_flags").upsert({ user_id: a.user_id, code: f.code, severity: f.severity, detail: f.detail, week_start: weeks[5].weekStart }, { onConflict: "user_id,code,week_start", ignoreDuplicates: true });
    out.flags++;
  }
  await admin.from("results_plan_accounts").update({ last_ingest_at: new Date().toISOString() }).eq("user_id", a.user_id);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("RESULTS_PLAN_CRON_SECRET") ?? "";
  const given = req.headers.get("X-Cron-Secret") ?? "";
  if (!secret || !safeEqual(given, secret)) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: accounts, error } = await admin.from("results_plan_accounts")
    .select("user_id,billing_level,existing_work_window_days,duplicate_window_hours,cancel_window_hours,confirmed_fallback_days,rule_version,terms_id,opted_in_at")
    .eq("status", "active").not("opted_in_at", "is", null).order("last_ingest_at", { ascending: true, nullsFirst: true }).limit(BATCH);
  if (error) return json({ error: error.message }, 500);

  const started = Date.now();
  const results: Array<Record<string, unknown>> = [];
  for (const a of (accounts ?? []) as Account[]) {
    if (Date.now() - started > BUDGET_MS) break;
    try { results.push({ user_id: a.user_id, ...(await ingestAccount(admin, { ...a, billing_level: a.billing_level ?? RESULTS_PLAN_DEFAULTS.billingLevel })) }); }
    catch (e) { console.error("results-plan-ingest account failed", a.user_id, e instanceof Error ? e.message : e); results.push({ user_id: a.user_id, error: true }); }
  }
  return json({ processed: results.length, results });
});
