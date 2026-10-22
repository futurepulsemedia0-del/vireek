/**
 * Rescue Loop — pure domain logic (no I/O, fully unit-tested).
 *
 * One missed / voicemail / abandoned call -> one timeline of every automatic
 * and human step that followed (text-back, callbacks, booking-link clicks,
 * booking, quote, payment) plus a first-response SLA verdict.
 *
 * The SQL side (supabase/migrations/20271011000000_rescue_loop_sla.sql)
 * builds the raw events; this file turns them into something a person can
 * read. evaluateSla() and formatDuration() mirror rescue_classify_sla() and
 * rescue_fmt_seconds() 1:1 — change them together.
 */

import { OUTCOME_META, type QueueOutcome } from '@/lib/callQueue';

/* --------------------------------- types --------------------------------- */

export type RescueCaseType = 'missed' | 'voicemail' | 'abandoned';

export type RescueEventKind =
  | 'call_missed'
  | 'text_sent'
  | 'callback_attempt'
  | 'followup_text'
  | 'followup_call'
  | 'customer_reply'
  | 'manual_text'
  | 'human_followup'
  | 'link_click'
  | 'booked'
  | 'quote_sent'
  | 'quote_accepted'
  | 'quote_declined'
  | 'payment_received'
  | 'loop_stopped'
  | 'closed';

export type RescueEventOutcome = 'ok' | 'pending' | 'failed' | 'skipped' | 'deferred' | 'no_answer' | 'info';
export type RescueChannel = 'sms' | 'call' | 'web' | 'none';
export type SlaStatus = 'pending' | 'met' | 'late' | 'breached' | 'excused' | 'closed';
export type EventTone = 'good' | 'warn' | 'bad' | 'neutral' | 'pending';

export interface RescueEvent {
  callId: string;
  kind: RescueEventKind;
  occurredAt: string;
  outcome: RescueEventOutcome;
  channel: RescueChannel;
  automated: boolean;
  detail: string | null;
  amountCents: number | null;
  refTable: string | null;
  refId: string | null;
}

export interface RescueCase {
  callId: string;
  ledgerId: string;
  caseType: RescueCaseType;
  callAt: string;
  /** SLA clock start: call time, or call end for an abandoned (AI-answered, not booked) call. */
  clockStart: string;
  callerName: string;
  callerPhone: string | null;
  valueCents: number;
  ledgerStatus: string;
  firstResponseAt: string | null;
  firstResponseKind: RescueEventKind | null;
  responseSeconds: number | null;
  limitSeconds: number;
  /** Status as computed by the server at fetch time; use evaluateSla() for a live one. */
  slaStatus: SlaStatus;
  deferred: boolean;
  bookedAt: string | null;
  paidAt: string | null;
  lastEventAt: string | null;
  eventCount: number;
}

export interface RescueSlaSettings {
  firstResponseLimitSeconds: number;
  alertsEnabled: boolean;
  excuseQuietHours: boolean;
}

export const SLA_MIN_SECONDS = 10;
export const SLA_MAX_SECONDS = 86_400;
export const SLA_DEFAULT_SECONDS = 60;
export const SLA_PRESETS = [30, 60, 120, 300, 900] as const;

export const DEFAULT_SLA_SETTINGS: RescueSlaSettings = {
  firstResponseLimitSeconds: SLA_DEFAULT_SECONDS,
  alertsEnabled: true,
  excuseQuietHours: true,
};

/** Events that count as "we responded to the caller" (must match the SQL). */
export const RESPONSE_KINDS: readonly RescueEventKind[] = [
  'text_sent',
  'callback_attempt',
  'followup_text',
  'followup_call',
  'manual_text',
  'human_followup',
];
const RESPONSE_OUTCOMES: readonly RescueEventOutcome[] = ['ok', 'no_answer'];

export function isResponseEvent(e: Pick<RescueEvent, 'kind' | 'outcome'>): boolean {
  return RESPONSE_KINDS.includes(e.kind) && RESPONSE_OUTCOMES.includes(e.outcome);
}

/* ------------------------------ time helpers ------------------------------ */

function toMs(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return new Date(iso).getTime();
}

/** "45s", "3m 05s", "1h 10m", "2d 4h" — identical to rescue_fmt_seconds() in SQL. */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return '–';
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

/** Offset from the SLA clock: "0s", "+42s", "−3m 05s". */
export function formatOffset(seconds: number): string {
  const s = Math.round(seconds);
  if (s === 0) return '0s';
  return `${s > 0 ? '+' : '−'}${formatDuration(Math.abs(s))}`;
}

/** Clamp a user-entered limit into the range the database accepts. */
export function normalizeSlaLimit(value: number): number {
  if (!Number.isFinite(value)) return SLA_DEFAULT_SECONDS;
  return Math.min(SLA_MAX_SECONDS, Math.max(SLA_MIN_SECONDS, Math.round(value)));
}

/** Parse "90", "90s", "2m", "1h" (also "1.5h") into seconds; null when unusable. */
export function parseSlaLimitInput(raw: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const factor = unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1;
  const seconds = Math.round(n * factor);
  if (seconds < SLA_MIN_SECONDS || seconds > SLA_MAX_SECONDS) return null;
  return seconds;
}

/* ---------------------------------- SLA ---------------------------------- */

export interface SlaInput {
  clockStart: string;
  firstResponseAt: string | null;
  /** A text exists but was queued for quiet hours. */
  deferred: boolean;
  ledgerStatus: string;
  limitSeconds: number;
  excuseQuietHours: boolean;
  now: number;
}

export interface SlaEvaluation {
  status: SlaStatus;
  /** Seconds from clock start to the first response (null when none yet). */
  responseSeconds: number | null;
  /** pending only: seconds left before the limit is breached. */
  remainingSeconds: number | null;
  /** breached only: how long past the limit the caller has been waiting. */
  overdueSeconds: number | null;
}

/** Mirrors rescue_classify_sla() in the migration. */
export function evaluateSla(input: SlaInput): SlaEvaluation {
  const start = toMs(input.clockStart);
  const first = toMs(input.firstResponseAt);
  const limitMs = input.limitSeconds * 1000;
  const none = { remainingSeconds: null, overdueSeconds: null };

  if (Number.isFinite(first)) {
    const responseSeconds = Math.max(0, Math.round((first - start) / 1000));
    return { status: first - start <= limitMs ? 'met' : 'late', responseSeconds, ...none };
  }
  if (input.ledgerStatus === 'written_off' || input.ledgerStatus === 'recovered') {
    return { status: 'closed', responseSeconds: null, ...none };
  }
  if (input.excuseQuietHours && input.deferred) {
    return { status: 'excused', responseSeconds: null, ...none };
  }
  const waitedMs = input.now - start;
  if (waitedMs > limitMs) {
    return { status: 'breached', responseSeconds: null, remainingSeconds: null, overdueSeconds: Math.round((waitedMs - limitMs) / 1000) };
  }
  return { status: 'pending', responseSeconds: null, remainingSeconds: Math.max(0, Math.ceil((limitMs - waitedMs) / 1000)), overdueSeconds: null };
}

export function evaluateCase(c: RescueCase, settings: RescueSlaSettings, now: number): SlaEvaluation {
  return evaluateSla({
    clockStart: c.clockStart,
    firstResponseAt: c.firstResponseAt,
    deferred: c.deferred,
    ledgerStatus: c.ledgerStatus,
    limitSeconds: c.limitSeconds,
    excuseQuietHours: settings.excuseQuietHours,
    now,
  });
}

export const SLA_META: Record<SlaStatus, { label: string; className: string }> = {
  met: { label: 'On time', className: 'bg-success-500/10 text-success-500' },
  late: { label: 'Late', className: 'bg-warning-500/10 text-warning-500' },
  breached: { label: 'No response', className: 'bg-danger-500/10 text-danger-500' },
  pending: { label: 'Clock running', className: 'bg-accent/10 text-accent' },
  excused: { label: 'Quiet hours', className: 'bg-bg-tertiary text-text-secondary' },
  closed: { label: 'Closed', className: 'bg-bg-tertiary text-text-secondary' },
};

/** Cases that need a person (late or still unanswered past the limit). */
export function needsAttention(status: SlaStatus): boolean {
  return status === 'breached' || status === 'late';
}

/* -------------------------------- summaries ------------------------------- */

export interface RescueSummary {
  total: number;
  met: number;
  late: number;
  breached: number;
  pending: number;
  excused: number;
  closed: number;
  /** met / (met + late + breached); null when nothing was measurable. */
  complianceRate: number | null;
  medianResponseSeconds: number | null;
  /** Estimated value of callers who are still unanswered past the limit. */
  atRiskValueCents: number;
  /** Cases that ended in a booking. */
  bookedCount: number;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function summarizeCases(cases: RescueCase[], settings: RescueSlaSettings, now: number): RescueSummary {
  const s: RescueSummary = {
    total: cases.length,
    met: 0,
    late: 0,
    breached: 0,
    pending: 0,
    excused: 0,
    closed: 0,
    complianceRate: null,
    medianResponseSeconds: null,
    atRiskValueCents: 0,
    bookedCount: 0,
  };
  const responses: number[] = [];
  for (const c of cases) {
    const ev = evaluateCase(c, settings, now);
    s[ev.status] += 1;
    if (ev.responseSeconds !== null) responses.push(ev.responseSeconds);
    if (ev.status === 'breached') s.atRiskValueCents += c.valueCents;
    if (c.bookedAt) s.bookedCount += 1;
  }
  const measurable = s.met + s.late + s.breached;
  s.complianceRate = measurable > 0 ? s.met / measurable : null;
  s.medianResponseSeconds = median(responses);
  return s;
}

export type RescueFilter = 'all' | 'attention' | 'pending' | 'met' | 'excused';

export function filterCases(cases: RescueCase[], filter: RescueFilter, settings: RescueSlaSettings, now: number): RescueCase[] {
  if (filter === 'all') return cases;
  return cases.filter((c) => {
    const status = evaluateCase(c, settings, now).status;
    switch (filter) {
      case 'attention':
        return needsAttention(status);
      case 'pending':
        return status === 'pending';
      case 'met':
        return status === 'met';
      case 'excused':
        return status === 'excused' || status === 'closed';
      default:
        return true;
    }
  });
}

/* ------------------------------ event wording ----------------------------- */

export const KIND_LABEL: Record<RescueEventKind, string> = {
  call_missed: 'Missed call',
  text_sent: 'Text-back',
  callback_attempt: 'Callback attempt',
  followup_text: 'Follow-up text',
  followup_call: 'Follow-up call',
  customer_reply: 'Customer replied',
  manual_text: 'Text from inbox',
  human_followup: 'Team follow-up',
  link_click: 'Booking link opened',
  booked: 'Booked',
  quote_sent: 'Quote sent',
  quote_accepted: 'Quote accepted',
  quote_declined: 'Quote declined',
  payment_received: 'Payment received',
  loop_stopped: 'Automation stopped',
  closed: 'Closed out',
};

export const OUTCOME_LABEL: Record<RescueEventOutcome, string> = {
  ok: 'Done',
  pending: 'Scheduled',
  failed: 'Failed',
  skipped: 'Skipped',
  deferred: 'Queued',
  no_answer: 'No answer',
  info: '',
};

const CASE_TYPE_LABEL: Record<RescueCaseType, string> = {
  missed: 'Missed call',
  voicemail: 'Voicemail',
  abandoned: 'Not booked',
};
export function caseTypeLabel(t: RescueCaseType): string {
  return CASE_TYPE_LABEL[t];
}

/** Human wording for workflow_runs.stop_reason values the engine can write. */
export function describeStopReason(reason: string | null): string {
  if (!reason) return 'The automation stopped.';
  if (reason === 'customer_opted_out') return 'Stopped: the customer opted out of texts and calls.';
  const stepFailed = /^step_(\d+)_failed$/.exec(reason);
  if (stepFailed) return `Stopped: automation step ${stepFailed[1]} failed.`;
  if (reason.startsWith('condition_failed:')) {
    const check = reason.slice('condition_failed:'.length);
    if (check === 'lead_not_progressed') return 'Stopped: the caller already moved forward, so no more nudges were needed.';
    if (check === 'quote_still_pending') return 'Stopped: the quote is no longer pending.';
    return `Stopped: the condition “${check.replace(/_/g, ' ')}” was no longer true.`;
  }
  return `Stopped: ${reason.replace(/_/g, ' ')}.`;
}

export function toneFor(e: Pick<RescueEvent, 'kind' | 'outcome'>): EventTone {
  if (e.outcome === 'failed') return 'bad';
  if (e.outcome === 'pending') return 'pending';
  if (e.outcome === 'no_answer' || e.outcome === 'deferred') return 'warn';
  if (e.kind === 'booked' || e.kind === 'quote_accepted' || e.kind === 'payment_received') return 'good';
  if (e.kind === 'customer_reply' || e.kind === 'link_click') return 'good';
  if (e.outcome === 'ok') return 'neutral';
  return 'neutral';
}

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function describeEvent(e: RescueEvent): { title: string; detail: string; tone: EventTone } {
  let detail = e.detail ?? '';
  if (e.kind === 'loop_stopped') detail = describeStopReason(e.detail);
  if (e.kind === 'human_followup') {
    const meta = e.detail ? OUTCOME_META[e.detail as QueueOutcome] : undefined;
    detail = meta ? meta.label : 'Attempt logged in the Call Queue';
  }
  if (e.kind === 'payment_received' && e.amountCents !== null) detail = `${detail} · ${formatMoney(e.amountCents)}`;
  return { title: KIND_LABEL[e.kind], detail, tone: toneFor(e) };
}

/* -------------------------------- timeline -------------------------------- */

export interface TimelineItem {
  key: string;
  type: 'event' | 'sla_marker';
  at: number;
  /** Seconds from the SLA clock start. */
  offsetSeconds: number;
  offsetLabel: string;
  title: string;
  detail: string;
  tone: EventTone;
  automated: boolean;
  channel: RescueChannel;
  kind: RescueEventKind | 'sla_limit';
  outcomeLabel: string;
  /** A step that was scheduled for a time that has already passed and still has not run. */
  overdue: boolean;
  /** sla_marker only: whether the limit has already passed. */
  passed: boolean;
}

const OVERDUE_GRACE_MS = 2 * 60_000;

export function buildTimeline(
  events: RescueEvent[],
  opts: { clockStart: string; limitSeconds: number; now: number },
): TimelineItem[] {
  const start = toMs(opts.clockStart);
  const items: TimelineItem[] = events
    .filter((e) => Number.isFinite(toMs(e.occurredAt)))
    .map((e, i) => {
      const at = toMs(e.occurredAt);
      const d = describeEvent(e);
      const offsetSeconds = Number.isFinite(start) ? Math.round((at - start) / 1000) : 0;
      return {
        key: `${e.refTable ?? 'ev'}:${e.refId ?? i}:${e.kind}`,
        type: 'event' as const,
        at,
        offsetSeconds,
        offsetLabel: formatOffset(offsetSeconds),
        title: d.title,
        detail: d.detail,
        tone: d.tone,
        automated: e.automated,
        channel: e.channel,
        kind: e.kind,
        outcomeLabel: OUTCOME_LABEL[e.outcome],
        overdue: e.outcome === 'pending' && at < opts.now - OVERDUE_GRACE_MS,
        passed: false,
      };
    });

  if (Number.isFinite(start)) {
    const markerAt = start + opts.limitSeconds * 1000;
    items.push({
      key: 'sla-limit',
      type: 'sla_marker',
      at: markerAt,
      offsetSeconds: opts.limitSeconds,
      offsetLabel: formatOffset(opts.limitSeconds),
      title: `Response limit · ${formatDuration(opts.limitSeconds)}`,
      detail: '',
      tone: 'neutral',
      automated: false,
      channel: 'none',
      kind: 'sla_limit',
      outcomeLabel: '',
      overdue: false,
      passed: opts.now >= markerAt,
    });
  }

  // Stable order: time, then "the miss" first, SLA marker after real events at the same instant.
  const rank = (i: TimelineItem) => (i.kind === 'call_missed' ? 0 : i.type === 'sla_marker' ? 2 : 1);
  return items.sort((a, b) => a.at - b.at || rank(a) - rank(b) || a.key.localeCompare(b.key));
}

/* ------------------------------- row mappers ------------------------------ */

type Row = Record<string, unknown>;

const EVENT_KINDS = new Set<string>(Object.keys(KIND_LABEL));
const OUTCOMES = new Set<string>(Object.keys(OUTCOME_LABEL));
const CHANNELS = new Set<string>(['sms', 'call', 'web', 'none']);
const SLA_STATUSES = new Set<string>(Object.keys(SLA_META));
const CASE_TYPES = new Set<string>(['missed', 'voicemail', 'abandoned']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** Returns null for a row that is not a valid event (unknown kind etc.) so one bad row never breaks the timeline. */
export function mapEventRow(r: Row): RescueEvent | null {
  const kind = str(r.ev_kind);
  const callId = str(r.ev_call_id);
  const at = str(r.ev_at);
  if (!kind || !EVENT_KINDS.has(kind) || !callId || !at || !Number.isFinite(toMs(at))) return null;
  const outcome = str(r.ev_outcome);
  const channel = str(r.ev_channel);
  return {
    callId,
    kind: kind as RescueEventKind,
    occurredAt: at,
    outcome: outcome && OUTCOMES.has(outcome) ? (outcome as RescueEventOutcome) : 'info',
    channel: channel && CHANNELS.has(channel) ? (channel as RescueChannel) : 'none',
    automated: r.ev_automated === true,
    detail: str(r.ev_detail),
    amountCents: r.ev_amount_cents === null || r.ev_amount_cents === undefined ? null : num(r.ev_amount_cents),
    refTable: str(r.ev_ref_table),
    refId: str(r.ev_ref_id),
  };
}

export function mapCaseRow(r: Row): RescueCase | null {
  const callId = str(r.rc_call_id);
  const callAt = str(r.rc_call_at);
  const clockStart = str(r.rc_clock_start);
  if (!callId || !callAt || !clockStart) return null;
  const type = str(r.rc_case_type);
  const status = str(r.rc_sla_status);
  const kind = str(r.rc_first_response_kind);
  return {
    callId,
    ledgerId: str(r.rc_ledger_id) ?? '',
    caseType: type && CASE_TYPES.has(type) ? (type as RescueCaseType) : 'missed',
    callAt,
    clockStart,
    callerName: str(r.rc_caller_name) ?? 'Unknown caller',
    callerPhone: str(r.rc_caller_phone),
    valueCents: Math.max(0, num(r.rc_value_cents)),
    ledgerStatus: str(r.rc_ledger_status) ?? 'open',
    firstResponseAt: str(r.rc_first_response_at),
    firstResponseKind: kind && EVENT_KINDS.has(kind) ? (kind as RescueEventKind) : null,
    responseSeconds: r.rc_response_seconds === null || r.rc_response_seconds === undefined ? null : num(r.rc_response_seconds),
    limitSeconds: normalizeSlaLimit(num(r.rc_limit_seconds, SLA_DEFAULT_SECONDS)),
    slaStatus: status && SLA_STATUSES.has(status) ? (status as SlaStatus) : 'pending',
    deferred: r.rc_deferred === true,
    bookedAt: str(r.rc_booked_at),
    paidAt: str(r.rc_paid_at),
    lastEventAt: str(r.rc_last_event_at),
    eventCount: Math.max(0, Math.round(num(r.rc_event_count))),
  };
}

export function mapSettingsRow(r: Row | null | undefined): RescueSlaSettings {
  if (!r) return DEFAULT_SLA_SETTINGS;
  return {
    firstResponseLimitSeconds: normalizeSlaLimit(num(r.first_response_limit_seconds, SLA_DEFAULT_SECONDS)),
    alertsEnabled: r.alerts_enabled !== false,
    excuseQuietHours: r.excuse_quiet_hours !== false,
  };
}
