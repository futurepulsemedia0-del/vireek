// supabase/functions/_shared/shadow/runtime.ts
//
// DB-facing half of Shadow Mode (service-role client injected). READ-ONLY with respect to everything
// outside the shadow_* tables: it SELECTs from calls / pbx_calls / pbx_voicemails / business_profile and
// WRITES only shadow_cards, shadow_reports, shadow_events and shadow_trials(last_replay_at/status).
// It imports no SMS / email / dispatch / booking / telephony module. A static test pins that.

import {
  PIPELINE_VERSION, buildShadowCard, evaluateConsent, isAfterHoursIn, purgeAfter, trialDay,
  type BusinessHoursLite, type ConsentConfig, type ShadowCallInput, type ShadowCard, type ShadowPorts,
} from "./logic.ts";
import { buildReportPayload, type ReportPayload, type ReviewRow } from "./report.ts";

// deno-lint-ignore no-explicit-any
export type Admin = any;

export interface TrialRow {
  id: string; user_id: string; status: "active" | "completed" | "cancelled" | "went_live";
  started_at: string; ends_at: string; timezone: string;
  replay_attested: boolean; caller_disclosure_configured: boolean; staff_notified: boolean;
  telephony_supports_fork: boolean; counsel_cleared_states: string[]; retention_days: number;
  avg_ticket_cents_override: number | null; close_rate_override: number | null;
  setup_items: { forwarding: boolean; hours: boolean; emergency_rules: boolean; test_call: boolean };
  digests_sent: number[];
}

const MAX_TRANSCRIPT_IN = 12_000;
const MAX_TRANSCRIPT_STORED = 20_000;
const FETCH_CAP = 500;
const GRACE_MS = 24 * 3_600_000;

export function consentConfigOf(t: TrialRow): ConsentConfig {
  return {
    replayAttested: t.replay_attested,
    callerDisclosureConfigured: t.caller_disclosure_configured,
    staffNotified: t.staff_notified,
    telephonySupportsFork: t.telephony_supports_fork,
    counselClearedStates: t.counsel_cleared_states ?? [],
  };
}

export interface BusinessCtx {
  hours: BusinessHoursLite | null; holidayDates: string[]; avgTicketCents: number | null;
  assistantName: string; facts: string[];
}

export async function loadBusinessCtx(admin: Admin, userId: string): Promise<BusinessCtx> {
  const { data } = await admin.from("business_profile")
    .select("business_hours, holidays, avg_job_value, assistant_name, primary_industry, services_offered, service_area, faqs")
    .eq("user_id", userId).maybeSingle();
  const bp = data ?? {};
  const facts: string[] = [];
  if (typeof bp.primary_industry === "string" && bp.primary_industry) facts.push(`Trade: ${bp.primary_industry.slice(0, 80)}`);
  if (Array.isArray(bp.services_offered) && bp.services_offered.length) facts.push(`Services: ${bp.services_offered.slice(0, 15).map(String).join(", ").slice(0, 400)}`);
  if (typeof bp.service_area === "string" && bp.service_area) facts.push(`Service area: ${bp.service_area.slice(0, 200)}`);
  if (Array.isArray(bp.faqs)) {
    for (const f of bp.faqs.slice(0, 20)) {
      if (f && typeof f.question === "string" && typeof f.answer === "string") facts.push(`FAQ — Q: ${f.question.slice(0, 200)} A: ${f.answer.slice(0, 400)}`);
    }
  }
  const holidayDates = Array.isArray(bp.holidays) ? bp.holidays.map((h: { date?: string }) => h?.date).filter((d: unknown): d is string => typeof d === "string") : [];
  const dollars = typeof bp.avg_job_value === "number" ? bp.avg_job_value : Number(bp.avg_job_value);
  return {
    hours: (bp.business_hours as BusinessHoursLite | null) ?? null,
    holidayDates,
    avgTicketCents: Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null,
    assistantName: typeof bp.assistant_name === "string" && bp.assistant_name.trim() ? bp.assistant_name.trim().slice(0, 40) : "Sarah",
    facts,
  };
}

/** Pull every observable call in the trial window. Read-only. */
export async function collectCandidates(admin: Admin, t: TrialRow, biz: BusinessCtx): Promise<ShadowCallInput[]> {
  const out: ShadowCallInput[] = [];
  const mk = (o: Omit<ShadowCallInput, "accountId" | "isAfterHours"> & { startedAt: string }): ShadowCallInput => ({
    ...o, accountId: t.user_id, isAfterHours: isAfterHoursIn(biz.hours, biz.holidayDates, o.startedAt, t.timezone),
  });

  const { data: pbx } = await admin.from("pbx_calls")
    .select("id, from_number, status, started_at, answered_at, duration_seconds, calls_id")
    .eq("account_owner_id", t.user_id).eq("direction", "inbound")
    .gte("started_at", t.started_at).lte("started_at", t.ends_at)
    .order("started_at", { ascending: true }).limit(FETCH_CAP);
  const pbxRows: Array<Record<string, unknown>> = (pbx ?? []).filter((r: { status?: string }) => r.status !== "ai_handled");
  const callIds = pbxRows.map((r) => r.calls_id).filter((x): x is string => typeof x === "string");
  const pbxIds = pbxRows.map((r) => r.id as string);

  const transcriptByCall = new Map<string, string>();
  if (callIds.length) {
    const { data } = await admin.from("calls").select("id, transcript").eq("user_id", t.user_id).in("id", callIds);
    for (const r of data ?? []) if (r.transcript) transcriptByCall.set(r.id, r.transcript);
  }
  const vmByPbx = new Map<string, string>();
  if (pbxIds.length) {
    const { data } = await admin.from("pbx_voicemails").select("call_id, transcript").eq("account_owner_id", t.user_id).is("deleted_at", null).in("call_id", pbxIds);
    for (const r of data ?? []) if (r.transcript && r.call_id) vmByPbx.set(r.call_id, r.transcript);
  }
  for (const r of pbxRows) {
    const transcript = (typeof r.calls_id === "string" ? transcriptByCall.get(r.calls_id) : undefined) ?? vmByPbx.get(r.id as string) ?? null;
    out.push(mk({
      source: "pbx_call", sourceId: r.id as string, callerPhone: (r.from_number as string) ?? null,
      startedAt: r.started_at as string, answeredAt: (r.answered_at as string) ?? null, status: String(r.status ?? ""),
      durationSeconds: (r.duration_seconds as number) ?? null, transcript,
    }));
  }

  // Standalone voicemails (no pbx call row)
  const { data: vms } = await admin.from("pbx_voicemails")
    .select("id, caller_phone, transcript, duration_seconds, created_at")
    .eq("account_owner_id", t.user_id).is("deleted_at", null).is("call_id", null)
    .gte("created_at", t.started_at).lte("created_at", t.ends_at).order("created_at", { ascending: true }).limit(FETCH_CAP);
  for (const v of vms ?? []) {
    out.push(mk({
      source: "voicemail", sourceId: v.id, callerPhone: v.caller_phone ?? null, startedAt: v.created_at, answeredAt: null,
      status: "voicemail", durationSeconds: v.duration_seconds ?? null, transcript: v.transcript ?? null,
    }));
  }

  // Plain calls rows that are not mirrored from pbx_calls
  const { data: calls } = await admin.from("calls")
    .select("id, caller_phone, call_datetime, duration_seconds, transcript, status")
    .eq("user_id", t.user_id).gte("call_datetime", t.started_at).lte("call_datetime", t.ends_at)
    .order("call_datetime", { ascending: true }).limit(FETCH_CAP);
  const mirrored = new Set(callIds);
  for (const c of calls ?? []) {
    if (mirrored.has(c.id)) continue;
    const unanswered = !c.duration_seconds || c.duration_seconds <= 0;
    out.push(mk({
      source: "call_row", sourceId: c.id, callerPhone: c.caller_phone ?? null, startedAt: c.call_datetime, answeredAt: null,
      status: unanswered ? "missed" : "completed", durationSeconds: c.duration_seconds ?? null, transcript: c.transcript ?? null,
    }));
  }
  return out.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

export function cardRow(t: TrialRow, card: ShadowCard, input: ShadowCallInput, nowIso: string) {
  const digits = (input.callerPhone ?? "").replace(/\D/g, "");
  return {
    user_id: t.user_id, trial_id: t.id, source: card.source, source_id: card.sourceId,
    idempotency_key: card.idempotencyKey, pipeline_version: card.pipelineVersion, call_started_at: card.startedAt,
    caller_last4: digits.length >= 4 ? digits.slice(-4) : null, status: card.status, block_reason: card.blockReason,
    intent: card.status === "ready" ? card.analysis.intent : null, emergency: card.analysis.emergency,
    would_book: card.analysis.would_book, capturable: card.capturable,
    transcript_redacted: card.transcriptRedacted ? card.transcriptRedacted.slice(0, MAX_TRANSCRIPT_STORED) : null,
    analysis: card.analysis, actions: card.actions, diff: card.diff, purge_after: purgeAfter(nowIso, t.retention_days),
  };
}

export interface ReplayResult { processed: number; blocked: number; failed: number; pending: number; skipped?: string }

export async function replayTrial(admin: Admin, t: TrialRow, ports: ShadowPorts, nowIso: string, limit = 20): Promise<ReplayResult> {
  if (t.status !== "active") return { processed: 0, blocked: 0, failed: 0, pending: 0, skipped: "trial_not_active" };
  const biz = await loadBusinessCtx(admin, t.user_id);
  const all = await collectCandidates(admin, t, biz);

  const { data: done } = await admin.from("shadow_cards").select("source, source_id").eq("trial_id", t.id).limit(10_000);
  const seen = new Set((done ?? []).map((r: { source: string; source_id: string }) => `${r.source}:${r.source_id}`));
  const todo = all.filter((c) => !seen.has(`${c.source}:${c.sourceId}`));
  const batch = todo.slice(0, Math.max(1, Math.min(limit, 50)));

  const cfg = consentConfigOf(t);
  const rows: ReturnType<typeof cardRow>[] = [];
  let blocked = 0, failed = 0;
  for (const input of batch) {
    const decision = evaluateConsent("replay", input.callerPhone, cfg);
    const trimmed = { ...input, transcript: input.transcript ? input.transcript.slice(0, MAX_TRANSCRIPT_IN) : null };
    const card = await buildShadowCard(trimmed, ports, decision.allowed ? undefined : { blocked: decision.reason });
    if (card.status === "blocked_consent") blocked++;
    if (card.status === "analysis_failed") failed++;
    rows.push(cardRow(t, card, input, nowIso));
  }
  if (rows.length) {
    const { error } = await admin.from("shadow_cards").upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true });
    if (error) throw new Error(`shadow_cards upsert failed: ${error.message}`);
  }
  await admin.from("shadow_trials").update({ last_replay_at: nowIso }).eq("id", t.id);
  if (rows.length) {
    await admin.from("shadow_events").insert({
      user_id: t.user_id, trial_id: t.id, kind: "replay_run",
      detail: { processed: rows.length, blocked, failed, pipeline: PIPELINE_VERSION, day: trialDay(t.started_at, nowIso) },
    });
  }
  return { processed: rows.length, blocked, failed, pending: Math.max(0, todo.length - batch.length) };
}

/** Builds the report payload from the database (used for the stored Day-7 report and live previews). */
export async function computeReportPayload(admin: Admin, t: TrialRow, nowIso: string): Promise<ReportPayload> {
  const biz = await loadBusinessCtx(admin, t.user_id);
  const { data: s } = await admin.rpc("shadow_trial_stats", { p_trial_id: t.id });
  const st = (s ?? {}) as Record<string, number>;
  const n = (k: string) => (typeof st[k] === "number" ? st[k] : 0);

  const { data: revs } = await admin.from("shadow_reviews")
    .select("verdict, severity, category, proposal_target, proposal_status, mistake_resolved, corrected_text")
    .eq("trial_id", t.id).limit(5000);
  const reviews: ReviewRow[] = (revs ?? []).map((r: Record<string, unknown>) => ({
    verdict: r.verdict as ReviewRow["verdict"], severity: r.severity as ReviewRow["severity"], category: String(r.category),
    proposalTarget: r.proposal_target as ReviewRow["proposalTarget"], proposalStatus: r.proposal_status as ReviewRow["proposalStatus"],
    mistakeResolved: r.mistake_resolved === true, correctedText: (r.corrected_text as string) ?? null,
  }));
  const { data: cards } = await admin.from("shadow_cards").select("would_book, capturable").eq("trial_id", t.id).eq("status", "ready").limit(10_000);

  return buildReportPayload({
    nowIso,
    trial: { startedAt: t.started_at, endsAt: t.ends_at, timezone: t.timezone, setup: t.setup_items },
    counts: {
      callsSeen: n("calls_seen"), analyzed: n("analyzed"), unanswered: n("unanswered"), slowAnswers: n("slow_answers"),
      afterHours: n("after_hours"), emergencies: n("emergencies"), capturable: n("capturable"), reviewed: n("reviewed"),
      approved: n("approved"), blockedConsent: n("blocked_consent"), noTranscript: n("no_transcript"),
    },
    avgTicketCents: t.avg_ticket_cents_override ?? biz.avgTicketCents,
    closeRate: t.close_rate_override,
    capturableCards: (cards ?? []).map((c: { would_book: boolean; capturable: boolean }) => ({ wouldBook: c.would_book, capturable: c.capturable })),
    emergencyCardsReviewed: n("emergency_cards_reviewed"), emergencyCardsApproved: n("emergency_cards_approved"),
    reviews, openCritical: n("open_critical"),
  });
}

/** Day-7 finalisation: store the report, close the trial. Idempotent. */
export async function finalizeTrial(admin: Admin, t: TrialRow, nowIso: string): Promise<{ finalized: boolean; reason?: string }> {
  if (t.status !== "active") return { finalized: false, reason: "not_active" };
  if (Date.parse(nowIso) < Date.parse(t.ends_at)) return { finalized: false, reason: "not_expired" };
  const payload = await computeReportPayload(admin, t, nowIso);
  const purge = new Date(Date.parse(t.ends_at) + t.retention_days * 86_400_000).toISOString();
  const { error } = await admin.from("shadow_reports").upsert({
    user_id: t.user_id, trial_id: t.id, generated_at: nowIso, payload,
    readiness_score: payload.readiness.score, readiness_band: payload.readiness.band, purge_after: purge,
  }, { onConflict: "trial_id" });
  if (error) throw new Error(`shadow_reports upsert failed: ${error.message}`);
  await admin.from("shadow_trials").update({ status: "completed" }).eq("id", t.id).eq("status", "active");
  await admin.from("shadow_events").insert({ user_id: t.user_id, trial_id: t.id, kind: "report_generated", detail: { readiness: payload.readiness.score } });
  return { finalized: true };
}

export function shouldFinalize(t: TrialRow, pending: number, nowIso: string): boolean {
  const now = Date.parse(nowIso), end = Date.parse(t.ends_at);
  return t.status === "active" && now >= end && (pending === 0 || now >= end + GRACE_MS);
}
