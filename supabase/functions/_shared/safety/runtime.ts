// supabase/functions/_shared/safety/runtime.ts
//
// Server side of the lone-worker workflow. The decisions ("what must happen now?") come from the pure,
// unit-tested evaluateSession() in src/lib/safety/core.ts; this file only performs them.
//
// Delivery rules:
//  - Safety alerts to staff go through Twilio via _shared/notify/deliver.ts (same path escalation-tick uses).
//  - Customer notices go through sendCompliantSms (A2P gate, opt-out, quiet hours).
//  - We never claim to contact emergency services; every escalation text says so.
//  - Every action is claimed with a unique dedupe key BEFORE it is sent, and a claim without a result is
//    retried after RETRY_AFTER_MS, so a crash never silently drops an escalation and parallel runs never double-send.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendSms } from "../notify/deliver.ts";
import { sendCompliantSms } from "../messaging/sendSms.ts";
import {
  DEFAULT_CHAIN,
  buildEscalationSms,
  evaluateSession,
  validateChain,
  type ChainStep,
  type EscalationStepKind,
  type SessionAction,
  type SessionState,
  type TimerSettings,
} from "../../../../src/lib/safety/core.ts";

const RETRY_AFTER_MS = 2 * 60_000;

interface SessionRow {
  id: string;
  user_id: string;
  job_id: string;
  team_member_id: string;
  is_drill: boolean;
  status: "active" | "escalating" | "duress" | "ended";
  started_at: string;
  expected_end_at: string;
  next_checkin_due_at: string;
  last_seen_at: string;
  escalation_anchor_at: string | null;
  all_clear_pending: boolean;
  sms_code: string;
}

interface SettingsRow {
  user_id: string;
  checkin_grace_minutes: number;
  overrun_prompt_minutes: number;
  unreachable_minutes: number;
  escalation_chain: unknown;
  dispatcher_phone: string | null;
  company_next_phone: string | null;
  sms_fallback_enabled: boolean;
}

export interface TickResult {
  sessions: number;
  actions: number;
  failures: number;
  all_clear: number;
  decline_notices: number;
  purged?: unknown;
}

const log = (event: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...extra }));

function settingsToTimer(s: SettingsRow): TimerSettings {
  const chain: ChainStep[] = validateChain(s.escalation_chain) ? (s.escalation_chain as ChainStep[]) : DEFAULT_CHAIN;
  return { checkinGraceMin: s.checkin_grace_minutes, overrunPromptMin: s.overrun_prompt_minutes, unreachableMin: s.unreachable_minutes, chain };
}

/** Insert a claim. Returns false when somebody else already holds it (unique violation). */
async function claim(admin: SupabaseClient, row: Record<string, unknown>): Promise<boolean> {
  const { error } = await admin.from("safety_events").insert(row);
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`safety_events insert failed: ${error.message}`);
}

async function recipientPhone(
  admin: SupabaseClient,
  settings: SettingsRow,
  session: SessionRow,
  step: EscalationStepKind,
): Promise<string | null> {
  if (step === "dispatcher") {
    if (settings.dispatcher_phone) return settings.dispatcher_phone;
    const { data } = await admin.from("profiles").select("phone").eq("id", session.user_id).maybeSingle();
    return (data?.phone as string | null) ?? null;
  }
  if (step === "company_next") return settings.company_next_phone;
  const { data } = await admin.from("safety_member_prefs").select("emergency_contact_phone").eq("team_member_id", session.team_member_id).maybeSingle();
  return (data?.emergency_contact_phone as string | null) ?? null;
}

async function techInfo(admin: SupabaseClient, session: SessionRow): Promise<{ name: string; phone: string | null; jobRef: string }> {
  const [{ data: tm }, { data: job }] = await Promise.all([
    admin.from("team_members").select("member_name, member_email, member_phone").eq("id", session.team_member_id).maybeSingle(),
    admin.from("jobs").select("id, customer_name").eq("id", session.job_id).maybeSingle(),
  ]);
  return {
    name: (tm?.member_name as string | null) ?? (tm?.member_email as string | null) ?? "A technician",
    phone: (tm?.member_phone as string | null) ?? null,
    jobRef: job?.id ? String(job.id).slice(0, 8) : session.job_id.slice(0, 8),
  };
}

async function performAction(
  admin: SupabaseClient,
  session: SessionRow,
  settings: SettingsRow,
  action: SessionAction,
  retry: boolean,
): Promise<boolean> {
  const base = { user_id: session.user_id, session_id: session.id };
  const tech = await techInfo(admin, session);
  const drillTag = session.is_drill ? "[DRILL] " : "";

  if (action.kind === "missed_checkin") {
    if (!retry) {
      await claim(admin, { ...base, kind: "missed_checkin", dedupe_key: action.key, channel: "app", detail: { anchor: action.anchor.toISOString() } });
      await admin.from("safety_sessions").update({ status: "escalating", escalation_anchor_at: action.anchor.toISOString() }).eq("id", session.id).eq("status", "active");
    }
    return true;
  }

  if (action.kind === "prompt_checkin" || action.kind === "overrun_prompt" || action.kind === "unreachable_prompt") {
    if (!retry && !(await claim(admin, { ...base, kind: action.kind, dedupe_key: action.key, channel: settings.sms_fallback_enabled ? "sms" : "none" }))) return true;
    if (!settings.sms_fallback_enabled || !tech.phone) return true;
    const text = action.kind === "overrun_prompt"
      ? `${drillTag}Vireek safety: your job is running over the expected time. Reply OK ${session.sms_code} if you are fine, or HELP if you need help.`
      : `${drillTag}Vireek safety check-in for job ${tech.jobRef}: reply OK ${session.sms_code} if you are fine, or HELP if you need help.`;
    const r = await sendSms(tech.phone, text);
    if (!r.ok) log("safety_prompt_sms_failed", { session: session.id, kind: action.kind, error: r.error });
    return r.ok;
  }

  // escalate
  const resultKey = `${action.key}:r`;
  if (!retry && !(await claim(admin, { ...base, kind: "escalation_step", dedupe_key: action.key, step: action.step, channel: "none", detail: { index: action.index, phase: "claimed" } }))) return true;

  let delivery: "sent" | "failed" | "simulated" | "skipped_no_contact" = "simulated";
  let channel: "sms" | "none" | "in_app" = "none";
  let error: string | undefined;

  if (!action.simulated) {
    const to = await recipientPhone(admin, settings, session, action.step);
    const reason = session.status === "duress" ? "duress" : "missed_checkin";
    if (action.step === "dispatcher") {
      // The dispatcher always also gets an in-app notification, whatever the SMS does.
      await admin.from("notifications").insert({
        user_id: session.user_id,
        type: "safety_escalation",
        title: `${drillTag}Safety escalation`,
        message: `${tech.name} ${reason === "duress" ? "pressed the safety alert" : "missed a safety check-in"}. Open the safety board.`,
        action_url: "/dashboard/site-safety?tab=live",
      });
      channel = "in_app";
      delivery = "sent";
    }
    if (to) {
      const body = buildEscalationSms({ step: action.step, techName: tech.name, drill: session.is_drill, reason, jobRef: tech.jobRef });
      const r = await sendSms(to, body);
      channel = "sms";
      delivery = r.ok ? "sent" : "failed";
      error = r.error;
    } else if (action.step !== "dispatcher") {
      delivery = "skipped_no_contact";
    }
  }
  const { error: insErr } = await admin.from("safety_events").insert({
    ...base, kind: "escalation_step", dedupe_key: resultKey, step: action.step, channel, delivery,
    detail: { index: action.index, phase: "result", error: error ? error.slice(0, 200) : null },
  });
  if (insErr && insErr.code !== "23505") throw new Error(insErr.message);
  return delivery !== "failed";
}

async function processSession(admin: SupabaseClient, session: SessionRow, settings: SettingsRow, now: Date): Promise<{ actions: number; failures: number }> {
  const { data: events } = await admin.from("safety_events").select("dedupe_key, created_at").eq("session_id", session.id).not("dedupe_key", "is", null);
  const done = new Map<string, number>();
  for (const e of events ?? []) done.set(e.dedupe_key as string, Date.parse(e.created_at as string));

  const state: SessionState = {
    status: session.status,
    isDrill: session.is_drill,
    startedAt: new Date(session.started_at),
    expectedEndAt: new Date(session.expected_end_at),
    nextCheckinDueAt: new Date(session.next_checkin_due_at),
    lastSeenAt: new Date(session.last_seen_at),
    escalationAnchorAt: session.escalation_anchor_at ? new Date(session.escalation_anchor_at) : null,
    doneKeys: new Set<string>(),                  // evaluate against nothing, then apply the claim/result logic below
  };
  const cfg = settingsToTimer(settings);
  const actions = evaluateSession(state, cfg, now);
  let performed = 0;
  let failures = 0;

  for (const a of actions) {
    const claimedAt = done.get(a.key);
    const needsResult = a.kind === "escalate";
    const hasResult = needsResult ? done.has(`${a.key}:r`) : true;
    if (claimedAt !== undefined && hasResult) continue;                         // fully handled
    if (claimedAt !== undefined && now.getTime() - claimedAt < RETRY_AFTER_MS) continue;   // someone is on it
    try {
      const ok = await performAction(admin, session, settings, a, claimedAt !== undefined);
      performed += 1;
      if (!ok) failures += 1;
    } catch (err) {
      failures += 1;
      log("safety_action_failed", { session: session.id, key: a.key, error: String(err) });
    }
  }
  return { actions: performed, failures };
}

async function sendAllClear(admin: SupabaseClient, session: SessionRow, settings: SettingsRow): Promise<boolean> {
  // Atomic claim: only one runner flips the flag.
  const { data: claimed } = await admin.from("safety_sessions").update({ all_clear_pending: false }).eq("id", session.id).eq("all_clear_pending", true).select("id");
  if (!claimed?.length) return false;
  const { data: steps } = await admin.from("safety_events").select("step, delivery").eq("session_id", session.id).eq("kind", "escalation_step").eq("delivery", "sent");
  const tech = await techInfo(admin, session);
  const notified = new Set<EscalationStepKind>((steps ?? []).map((s: { step: string }) => s.step as EscalationStepKind));
  for (const step of notified) {
    if (session.is_drill && step !== "dispatcher") continue;
    const to = await recipientPhone(admin, settings, session, step);
    if (to) await sendSms(to, `${session.is_drill ? "[DRILL] " : ""}All clear: ${tech.name.slice(0, 60)} has checked in and is safe. Thank you.`);
  }
  await admin.from("safety_events").insert({ user_id: session.user_id, session_id: session.id, kind: "all_clear_sent", channel: "sms" });
  return true;
}

export async function processDeclineNotices(admin: SupabaseClient): Promise<number> {
  const { data: rows } = await admin.from("safety_decline_requests").select("id, user_id, job_id, action").eq("customer_notice_status", "pending").limit(50);
  let n = 0;
  for (const r of rows ?? []) {
    const { data: claimed } = await admin.from("safety_decline_requests").update({ customer_notice_status: "skipped" }).eq("id", r.id).eq("customer_notice_status", "pending").select("id");
    if (!claimed?.length) continue;
    const [{ data: job }, { data: settings }, { data: profile }] = await Promise.all([
      admin.from("jobs").select("customer_id, customer_name").eq("id", r.job_id).maybeSingle(),
      admin.from("safety_settings").select("decline_customer_message").eq("user_id", r.user_id).maybeSingle(),
      admin.from("profiles").select("company_name").eq("id", r.user_id).maybeSingle(),
    ]);
    let phone: string | null = null;
    if (job?.customer_id) {
      const { data: c } = await admin.from("customers").select("phone").eq("id", job.customer_id).maybeSingle();
      phone = (c?.phone as string | null) ?? null;
    }
    let status: "sent" | "skipped" | "failed" = "skipped";
    let err: string | null = null;
    if (phone) {
      const biz = (profile?.company_name as string | null) ?? "our team";
      const text = (settings?.decline_customer_message as string | null)
        ?? `Hello, this is ${biz}. We need to reschedule your visit for a scheduling reason on our side. We will contact you shortly with a new time. Sorry for the inconvenience.`;
      const res = await sendCompliantSms(admin, r.user_id as string, phone, text, { purpose: "service", customerId: job?.customer_id as string, source: "safety_decline", dedupeKey: `safety_decline:${r.id}` });
      status = res.ok ? "sent" : "failed";
      if (!res.ok) err = `${res.reason}${res.detail ? `: ${res.detail}` : ""}`.slice(0, 200);
    }
    // The wording deliberately names no safety reason: the customer is told the visit moves, not why.
    await admin.from("safety_decline_requests").update({ customer_notice_status: status, customer_notice_error: err }).eq("id", r.id);
    n += 1;
  }
  return n;
}

export async function runTick(admin: SupabaseClient, now: Date = new Date(), onlySession?: string): Promise<TickResult> {
  const result: TickResult = { sessions: 0, actions: 0, failures: 0, all_clear: 0, decline_notices: 0 };
  let q = admin.from("safety_sessions").select("id, user_id, job_id, team_member_id, is_drill, status, started_at, expected_end_at, next_checkin_due_at, last_seen_at, escalation_anchor_at, all_clear_pending, sms_code");
  q = onlySession ? q.eq("id", onlySession) : q.or("status.neq.ended,all_clear_pending.eq.true").limit(500);
  const { data: sessions, error } = await q;
  if (error) throw new Error(error.message);

  const cache = new Map<string, SettingsRow | null>();
  for (const s of (sessions ?? []) as SessionRow[]) {
    if (!cache.has(s.user_id)) {
      const { data } = await admin.from("safety_settings").select("user_id, checkin_grace_minutes, overrun_prompt_minutes, unreachable_minutes, escalation_chain, dispatcher_phone, company_next_phone, sms_fallback_enabled").eq("user_id", s.user_id).maybeSingle();
      cache.set(s.user_id, (data as SettingsRow | null) ?? null);
    }
    const settings = cache.get(s.user_id);
    if (!settings) continue;
    result.sessions += 1;
    try {
      if (s.status !== "ended") {
        const r = await processSession(admin, s, settings, now);
        result.actions += r.actions;
        result.failures += r.failures;
      }
      if (s.all_clear_pending && (await sendAllClear(admin, s, settings))) result.all_clear += 1;
    } catch (err) {
      result.failures += 1;
      log("safety_session_failed", { session: s.id, error: String(err) });
    }
  }
  if (!onlySession) {
    result.decline_notices = await processDeclineNotices(admin);
    const { data: purged } = await admin.rpc("safety_purge_expired");
    result.purged = purged;
  }
  return result;
}
