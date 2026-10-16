// CSR / phone-desk screen-pop — pure domain logic (no I/O, fully unit-tested).
//
// Everything the desk shows is derived deterministically from the
// `csr_screen_pop` RPC payload. The suggested script NEVER states a fact that
// is not present in that payload: a screen-pop that invents history is worse
// than no screen-pop.

export const LIVE_WINDOW_MS = 45 * 60 * 1000; // a call row with no duration is "live" for at most 45 min
export const ENDED_RETENTION_MS = 10 * 60 * 1000; // keep a finished call visible for wrap-up
export const MAX_LIVE_CALLS = 20;

// ---------------------------------------------------------------- types

export interface LiveCall {
  id: string;
  caller_phone: string | null;
  caller_name: string | null;
  call_datetime: string;
  duration_seconds: number | null;
  is_emergency: boolean;
  is_voicemail: boolean;
  human_transfer_requested: boolean;
  status: string;
  sentiment: string | null;
  summary: string | null;
  intent: string | null;
}

/** A call in the desk queue: a LiveCall plus desk-local state. */
export interface DeskCall extends LiveCall {
  ended: boolean;
  endedAt: number | null;
}

export interface PopCustomer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  customer_type: 'residential' | 'commercial';
  lifecycle_stage: 'lead' | 'active' | 'vip' | 'inactive';
  tags: string[];
  notes: string | null;
}

export interface PopJob {
  id: string;
  service_type: string | null;
  job_status: string;
  scheduled_datetime: string | null;
  address: string | null;
  eta_minutes: number | null;
  warranty_expires_at: string | null;
  completed_at: string | null;
}

export interface PopEquipment {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  expected_lifespan_years: number;
  service_interval_months: number;
  last_service_date: string | null;
}

export interface PopBalance {
  outstanding_cents: number;
  overdue_cents: number;
  open_invoice_count: number;
  oldest_due_date: string | null;
}

export interface PopQuote {
  id: string;
  status: string;
  total_cents: number;
  sent_at: string | null;
  ai_detected_issue: string | null;
}

export interface PopLastConversation {
  call_id: string;
  call_datetime: string;
  summary: string | null;
  sentiment: string | null;
  intent: string | null;
  recommended_follow_up: string | null;
  objections_raised: string[];
  objections_resolved: boolean | null;
  duration_seconds: number | null;
}

export interface ScreenPopData {
  matched: boolean;
  customer: PopCustomer | null;
  open_jobs: PopJob[];
  recent_jobs: PopJob[];
  equipment: PopEquipment[];
  balance: PopBalance;
  open_quotes: PopQuote[];
  last_conversation: PopLastConversation | null;
  memory: { category: string; fact: string }[];
  history: { total_calls: number; last_call_at: string | null };
}

export type SignalSeverity = 'critical' | 'warning' | 'info' | 'positive';
export interface Signal {
  key: string;
  severity: SignalSeverity;
  label: string;
}

export type PrimaryAction = 'book' | 'quote' | 'transfer' | 'none';
export interface SuggestedScript {
  headline: string;
  opener: string;
  steps: string[];
  primaryAction: PrimaryAction;
}

export type WarrantyState = 'none' | 'active' | 'expiring' | 'expired';
export interface EquipmentInsight {
  id: string;
  label: string;
  ageYears: number | null;
  warranty: WarrantyState;
  warrantyDaysLeft: number | null;
  serviceDue: 'unknown' | 'ok' | 'soon' | 'overdue';
  nearEndOfLife: boolean;
}

// ---------------------------------------------------------------- phone

/** Last 10 digits — identical to `public.phone_key()` in SQL. null = unusable. */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return 'Unknown number';
  const key = phoneKey(raw);
  if (key && key.length === 10) return `(${key.slice(0, 3)}) ${key.slice(3, 6)}-${key.slice(6)}`;
  return raw;
}

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------- live queue

export function isLiveCall(
  call: Pick<LiveCall, 'duration_seconds' | 'is_voicemail' | 'status' | 'call_datetime'>,
  now: number
): boolean {
  if (call.duration_seconds != null) return false;
  if (call.is_voicemail || call.status === 'spam') return false;
  const started = Date.parse(call.call_datetime);
  if (Number.isNaN(started)) return false;
  const age = now - started;
  return age >= -60_000 && age <= LIVE_WINDOW_MS; // tolerate 1 min of clock skew
}

export function toDeskCall(row: LiveCall, ended = false, endedAt: number | null = null): DeskCall {
  return { ...row, ended, endedAt };
}

/**
 * Applies one realtime change to the desk queue.
 *  - live row            → upsert (keeps `ended` false)
 *  - finished row we know → mark ended (stays for wrap-up)
 *  - finished row we don't → ignored
 *  - DELETE              → removed
 */
export function applyCallChange(
  list: DeskCall[],
  change: { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; row: LiveCall | null; oldId?: string | null },
  now: number
): DeskCall[] {
  if (change.eventType === 'DELETE') {
    const id = change.oldId ?? change.row?.id;
    return id ? list.filter((c) => c.id !== id) : list;
  }
  const row = change.row;
  if (!row) return list;
  const exists = list.some((c) => c.id === row.id);

  if (isLiveCall(row, now)) {
    const next = exists ? list.map((c) => (c.id === row.id ? toDeskCall(row) : c)) : [toDeskCall(row), ...list];
    return sortQueue(next).slice(0, MAX_LIVE_CALLS);
  }
  if (!exists) return list;
  return list.map((c) => (c.id === row.id ? toDeskCall(row, true, c.endedAt ?? now) : c));
}

export function sortQueue(list: DeskCall[]): DeskCall[] {
  return [...list].sort((a, b) => {
    if (a.ended !== b.ended) return a.ended ? 1 : -1; // live first
    if (a.is_emergency !== b.is_emergency) return a.is_emergency ? -1 : 1;
    return Date.parse(b.call_datetime) - Date.parse(a.call_datetime);
  });
}

export function pruneEnded(list: DeskCall[], now: number): DeskCall[] {
  const next = list.filter((c) => !c.ended || (c.endedAt != null && now - c.endedAt < ENDED_RETENTION_MS));
  return next.length === list.length ? list : next;
}

/** Fields whose change should re-run the (heavier) screen-pop lookup. */
export function needsRepop(prev: LiveCall | undefined, next: LiveCall): boolean {
  if (!prev) return true;
  return (
    prev.caller_phone !== next.caller_phone ||
    prev.caller_name !== next.caller_name ||
    prev.is_emergency !== next.is_emergency ||
    prev.human_transfer_requested !== next.human_transfer_requested ||
    prev.intent !== next.intent ||
    prev.summary !== next.summary
  );
}

// ---------------------------------------------------------------- equipment

const DAY = 86_400_000;
const addMonths = (d: Date, m: number) => {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + m);
  return r;
};

export function analyzeEquipment(eq: PopEquipment, now: number): EquipmentInsight {
  const label = [eq.make, eq.model].filter(Boolean).join(' ') || eq.equipment_type;

  const installed = eq.install_date ? Date.parse(eq.install_date) : NaN;
  const ageYears = Number.isNaN(installed) ? null : Math.max(0, (now - installed) / (365.25 * DAY));
  const nearEndOfLife = ageYears != null && eq.expected_lifespan_years > 0 && ageYears >= eq.expected_lifespan_years * 0.8;

  let warranty: WarrantyState = 'none';
  let warrantyDaysLeft: number | null = null;
  if (eq.warranty_expires_at) {
    const exp = Date.parse(eq.warranty_expires_at);
    if (!Number.isNaN(exp)) {
      warrantyDaysLeft = Math.ceil((exp - now) / DAY);
      warranty = warrantyDaysLeft < 0 ? 'expired' : warrantyDaysLeft <= 60 ? 'expiring' : 'active';
    }
  }

  let serviceDue: EquipmentInsight['serviceDue'] = 'unknown';
  const base = eq.last_service_date ? Date.parse(eq.last_service_date) : installed;
  if (!Number.isNaN(base) && eq.service_interval_months > 0) {
    const due = addMonths(new Date(base), eq.service_interval_months).getTime();
    serviceDue = due < now ? 'overdue' : due - now <= 30 * DAY ? 'soon' : 'ok';
  }

  return { id: eq.id, label, ageYears, warranty, warrantyDaysLeft, serviceDue, nearEndOfLife };
}

// ---------------------------------------------------------------- signals

export function buildSignals(call: LiveCall, data: ScreenPopData, now: number): Signal[] {
  const out: Signal[] = [];
  const push = (key: string, severity: SignalSeverity, label: string) => out.push({ key, severity, label });

  if (call.is_emergency) push('emergency', 'critical', 'Emergency flagged on this call');
  if (call.human_transfer_requested) push('human', 'critical', 'Caller asked for a person');

  if (!data.matched) {
    push('new_caller', 'info', phoneKey(call.caller_phone) ? 'New caller — no record on file' : 'No caller ID');
  } else if (data.customer) {
    if (data.customer.lifecycle_stage === 'vip') push('vip', 'positive', 'VIP customer');
    if (data.customer.lifecycle_stage === 'inactive') push('inactive', 'info', 'Inactive customer — win-back');
  }

  const enRoute = data.open_jobs.find((j) => j.job_status === 'en_route' || j.job_status === 'in_progress');
  if (enRoute) push('job_live', 'info', enRoute.job_status === 'en_route' ? 'Technician is en route' : 'Job in progress now');

  if (data.balance.overdue_cents > 0) push('overdue', 'warning', `${formatMoney(data.balance.overdue_cents)} overdue`);
  else if (data.balance.outstanding_cents > 0) push('balance', 'info', `${formatMoney(data.balance.outstanding_cents)} outstanding`);

  const insights = data.equipment.map((e) => analyzeEquipment(e, now));
  const inWarranty = insights.find((i) => i.warranty === 'active' || i.warranty === 'expiring');
  if (inWarranty) {
    push(
      'warranty',
      inWarranty.warranty === 'expiring' ? 'warning' : 'positive',
      inWarranty.warranty === 'expiring'
        ? `${inWarranty.label}: warranty ends in ${inWarranty.warrantyDaysLeft} days`
        : `${inWarranty.label} is under warranty`
    );
  }
  if (insights.some((i) => i.serviceDue === 'overdue')) push('service_due', 'warning', 'Equipment maintenance overdue');
  if (insights.some((i) => i.nearEndOfLife)) push('eol', 'info', 'Equipment near end of expected life');

  const last = data.last_conversation;
  if (last?.sentiment === 'negative') push('neg_last', 'warning', 'Last conversation ended negatively');
  if (last && last.objections_resolved === false && last.objections_raised.length > 0) {
    push('objection', 'warning', 'Unresolved objection from last call');
  }
  if (data.open_quotes.some((q) => q.status === 'sent')) push('quote_open', 'info', 'Has an open quote awaiting a decision');

  return out;
}

// ---------------------------------------------------------------- script

const firstName = (name: string | null | undefined) => (name ? name.trim().split(/\s+/)[0] : '');

export function buildSuggestedScript(call: LiveCall, data: ScreenPopData, now: number): SuggestedScript {
  const name = firstName(data.customer?.name ?? call.caller_name);
  const hi = name ? `Hi ${name}` : 'Hello';
  const last = data.last_conversation;
  const live = data.open_jobs.find((j) => j.job_status === 'en_route' || j.job_status === 'in_progress');
  const sentQuote = data.open_quotes.find((q) => q.status === 'sent');
  const warrantyEq = data.equipment.map((e) => analyzeEquipment(e, now)).find((i) => i.warranty === 'active' || i.warranty === 'expiring');

  // 1 — safety first
  if (call.is_emergency) {
    return {
      headline: 'Emergency — dispatch first, paperwork later',
      opener: `${hi}, this is the office. Is everyone safe right now? Tell me exactly what is happening.`,
      steps: [
        'Confirm nobody is in danger; if there is gas, fire, flooding or smoke, tell them to leave and call 911.',
        'Confirm the service address' + (data.customer?.address ? ` (on file: ${data.customer.address}).` : '.'),
        'Transfer to the on-call technician or dispatcher now — do not discuss price or balance.',
      ],
      primaryAction: 'transfer',
    };
  }

  // 2 — the caller asked for a person
  if (call.human_transfer_requested) {
    return {
      headline: 'Caller asked for a person',
      opener: `${hi}, thanks for holding. I have your details in front of me — how can I help?`,
      steps: [
        'Do not make them repeat what they told the AI; the summary is on this screen.',
        'If you cannot resolve it in two minutes, offer a warm transfer to the owner or dispatcher.',
      ],
      primaryAction: 'transfer',
    };
  }

  // 3 — technician already on the way
  if (live) {
    const eta = live.eta_minutes != null ? ` ETA is about ${live.eta_minutes} minutes.` : '';
    return {
      headline: live.job_status === 'en_route' ? 'Technician is en route' : 'Job in progress',
      opener: `${hi}, I can see your technician ${live.job_status === 'en_route' ? 'is on the way' : 'is on site'}.${eta}`,
      steps: [
        'Give the status and ETA from the job; do not promise a time that is not on the job.',
        'Ask whether the reason for the call is something new or about this visit.',
      ],
      primaryAction: 'none',
    };
  }

  // 4 — repair the relationship before selling
  if (last?.sentiment === 'negative' || (last && last.objections_resolved === false && last.objections_raised.length > 0)) {
    return {
      headline: 'Recover the last conversation',
      opener: `${hi}, thanks for calling back. I have notes from your last call and I want to make sure we get this right.`,
      steps: [
        last?.summary ? `Acknowledge what happened last time: ${last.summary}` : 'Acknowledge that the last call did not go well.',
        last && last.objections_raised.length > 0
          ? `Address the open concern first: ${last.objections_raised.slice(0, 2).join('; ')}.`
          : 'Ask what would make this right before offering anything.',
        'Offer a warm transfer to a manager if they remain unhappy.',
      ],
      primaryAction: 'transfer',
    };
  }

  // 5 — an open quote is the most valuable thing on this call
  if (sentQuote) {
    return {
      headline: 'Open quote — close the loop',
      opener: `${hi}, thanks for calling. I see we sent you a quote for ${formatMoney(sentQuote.total_cents)} — did you have a chance to look at it?`,
      steps: [
        'Answer questions about scope or price; do not discount without approval.',
        'If they are ready, book the work directly from this screen.',
        data.balance.overdue_cents > 0 ? `Mention the ${formatMoney(data.balance.overdue_cents)} overdue balance only after the quote conversation.` : 'Confirm the best time for the visit.',
      ],
      primaryAction: 'book',
    };
  }

  // 6 — warranty visit
  if (warrantyEq) {
    return {
      headline: 'Equipment under warranty',
      opener: `${hi}, thanks for calling. I see your ${warrantyEq.label} is covered by warranty — what is it doing?`,
      steps: [
        'Collect the symptom and when it started.',
        'Book a warranty visit; do not quote labor or parts before the technician confirms coverage.',
      ],
      primaryAction: 'book',
    };
  }

  // 7 — brand-new caller
  if (!data.matched) {
    return {
      headline: 'New caller — capture the basics',
      opener: 'Thanks for calling, you have reached the office. May I have your name and the best number to reach you?',
      steps: [
        'Capture name, service address and a one-line description of the problem.',
        'Ask how they heard about us (source attribution).',
        'Offer the earliest available slot and book it on this screen.',
      ],
      primaryAction: 'book',
    };
  }

  // 8 — returning customer, default
  const steps = [
    last?.summary ? `Last conversation: ${last.summary}` : 'Ask what brings them in today.',
    data.balance.overdue_cents > 0
      ? `They have ${formatMoney(data.balance.overdue_cents)} overdue — raise it politely at the end, never as the opener.`
      : 'Confirm the service address and the best contact number.',
  ];
  if (data.equipment.some((e) => analyzeEquipment(e, now).serviceDue === 'overdue')) {
    steps.push('Equipment maintenance is overdue — offer a tune-up visit.');
  }
  return {
    headline: 'Returning customer',
    opener: `${hi}, welcome back — how can I help today?`,
    steps,
    primaryAction: 'book',
  };
}

// ---------------------------------------------------------------- one-click helpers

/** Next sensible slot: emergencies ASAP, otherwise next business hour (Mon–Fri, 08–17 local). */
export function suggestBookingSlot(now: Date, emergency: boolean): Date {
  const d = new Date(now.getTime());
  if (emergency) {
    d.setMinutes(Math.ceil((d.getMinutes() + 30) / 15) * 15, 0, 0);
    return d;
  }
  d.setHours(d.getHours() + 2, 0, 0, 0);
  const inHours = () => d.getHours() >= 8 && d.getHours() < 17;
  const weekday = () => d.getDay() !== 0 && d.getDay() !== 6;
  if (!inHours() || !weekday()) {
    if (d.getHours() >= 17 || !weekday()) d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    while (!weekday()) d.setDate(d.getDate() + 1);
  }
  return d;
}

export function toLocalInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface QuoteSeed {
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  ai_detected_issue: string | null;
  line_items: { description: string; quantity: number; unit_price_cents: number }[];
}

export function buildQuoteSeed(call: LiveCall, data: ScreenPopData): QuoteSeed {
  const issue = (call.summary ?? call.intent ?? '').trim();
  return {
    customer_name: data.customer?.name ?? call.caller_name ?? 'Unknown caller',
    customer_phone: data.customer?.phone ?? call.caller_phone,
    customer_email: data.customer?.email ?? null,
    ai_detected_issue: issue ? issue.slice(0, 500) : null,
    line_items: [{ description: (call.intent ?? 'Service call').slice(0, 120), quantity: 1, unit_price_cents: 0 }],
  };
}

export function isE164(n: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(n);
}

export function elapsedLabel(startIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(startIso)) / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const EMPTY_BALANCE: PopBalance = { outstanding_cents: 0, overdue_cents: 0, open_invoice_count: 0, oldest_due_date: null };
