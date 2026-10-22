/**
 * Vireek Recall & Safety-Alert Matching — pure client logic.
 *
 * The database (supabase/migrations/20271018000000_recall_safety_matching.sql) does the matching,
 * scoring, scoping and status transitions. This file only:
 *   1. normalises RPC payloads defensively (a missing field can never crash the UI),
 *   2. mirrors the DB's evidence rules so the form can validate before a round trip,
 *   3. filters / summarises / labels, and builds customer messages that never invent facts.
 *
 * KEEP IN SYNC with the migration: URGENT_SCORE (80), MIN_ATTEMPTS_FOR_UNREACHABLE (3),
 * TERMINAL_STATUSES, and the action rules in recall_log_outreach().
 */

export type RecallSeverity = 'low' | 'medium' | 'high' | 'critical';
export type RecallSourceKind = 'recall' | 'bulletin';
export type CampaignStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type OutreachStatus = 'pending' | 'contacted' | 'scheduled' | 'completed' | 'declined' | 'unreachable' | 'not_affected';
export type OutreachAction = 'attempt' | 'contacted' | 'scheduled' | 'completed' | 'declined' | 'unreachable' | 'not_affected' | 'reopened' | 'note';
export type OutreachChannel = 'phone' | 'sms' | 'email' | 'in_person' | 'mail';
export type Applicability = 'applies' | 'possible';
export type MatchMethod = 'linked' | 'exact' | 'family' | 'manufacturer';
export type Urgency = 'urgent' | 'high' | 'standard';
export type OutreachFilter = 'open' | 'urgent' | 'overdue' | 'verify' | 'closed' | 'all';

export const URGENT_SCORE = 80;
export const HIGH_SCORE = 60;
export const MIN_ATTEMPTS_FOR_UNREACHABLE = 3;
export const TERMINAL_STATUSES: readonly OutreachStatus[] = ['completed', 'declined', 'unreachable', 'not_affected'];

export interface StatusCounts {
  total: number;
  pending: number;
  contacted: number;
  scheduled: number;
  completed: number;
  declined: number;
  unreachable: number;
  not_affected: number;
}

export interface RecallCampaign {
  id: string;
  source_kind: RecallSourceKind;
  source_id: string | null;
  number: string;
  title: string;
  severity: RecallSeverity;
  status: CampaignStatus;
  auto_created: boolean;
  notes: string | null;
  created_at: string | null;
  completed_at: string | null;
  issued_date: string | null;
  remedy: string | null;
  description: string | null;
  source_url: string | null;
  counts: StatusCounts;
  urgent_open: number;
  overdue: number;
}

export interface OutreachRow {
  id: string;
  campaign_id: string;
  equipment_id: string;
  customer_id: string | null;
  status: OutreachStatus;
  applicability: Applicability;
  match_method: MatchMethod;
  priority_score: number;
  priority_reasons: string[];
  attempts: number;
  last_contacted_at: string | null;
  next_follow_up_at: string | null;
  job_id: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  created_at: string | null;
  equipment: {
    equipment_type: string;
    make: string | null;
    model: string | null;
    serial_number: string | null;
    install_date: string | null;
  };
  customer: {
    name: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    customer_type: string | null;
  };
}

export interface OutreachEvent {
  id: string;
  event_type: OutreachAction | 'created';
  channel: OutreachChannel | null;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  created_at: string | null;
}

export interface ScanResult {
  campaigns: number;
  matched: number;
  created: number;
}

// ---------------------------------------------------------------- labels

export const SEVERITY_LABELS: Record<RecallSeverity, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
export const STATUS_LABELS: Record<OutreachStatus, string> = {
  pending: 'Not contacted',
  contacted: 'Contacted',
  scheduled: 'Scheduled',
  completed: 'Completed',
  declined: 'Declined',
  unreachable: 'Unreachable',
  not_affected: 'Not affected',
};
export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
export const ACTION_LABELS: Record<OutreachAction, string> = {
  attempt: 'Contact attempt (no answer)',
  contacted: 'Reached the customer',
  scheduled: 'Visit scheduled',
  completed: 'Remedy completed',
  declined: 'Customer declined',
  unreachable: 'Unreachable after 3+ attempts',
  not_affected: 'Verified not affected',
  reopened: 'Re-open',
  note: 'Add a note',
};
export const CHANNEL_LABELS: Record<OutreachChannel, string> = {
  phone: 'Phone',
  sms: 'Text message',
  email: 'Email',
  in_person: 'In person',
  mail: 'Mail',
};
export const FILTER_LABELS: Record<OutreachFilter, string> = {
  open: 'Open',
  urgent: 'Urgent',
  overdue: 'Overdue',
  verify: 'Needs verification',
  closed: 'Closed',
  all: 'All',
};
export const REASON_LABELS: Record<string, string> = {
  severity_critical: 'Critical severity',
  severity_high: 'High severity',
  severity_medium: 'Medium severity',
  severity_low: 'Low severity',
  confirmed_match: 'Model confirmed',
  needs_verification: 'Needs verification',
  fire_or_co_risk: 'Fire / CO risk equipment',
  electrical_risk: 'Electrical risk equipment',
  commercial_site: 'Commercial site',
  past_lifespan: 'Past expected lifespan',
  no_contact_info: 'No phone or email on file',
};
export const MATCH_LABELS: Record<MatchMethod, string> = {
  linked: 'Linked to OEM model',
  exact: 'Exact model match',
  family: 'Model family match',
  manufacturer: 'Brand match only',
};

const RECALL_ERRORS: Record<string, string> = {
  RECALL_FORBIDDEN: 'You do not have permission to manage recalls.',
  RECALL_UNAUTHORIZED: 'Please sign in again.',
  RECALL_NOT_FOUND: 'That item no longer exists. Refresh and try again.',
  RECALL_INVALID_TRANSITION: 'That change is not allowed from the current status.',
  RECALL_INVALID_ACTION: 'That action is not valid.',
  RECALL_CHANNEL_REQUIRED: 'Choose how you contacted the customer.',
  RECALL_NOTE_REQUIRED: 'A note is required for this outcome.',
  RECALL_MIN_ATTEMPTS: 'Log at least 3 contact attempts before marking a customer unreachable.',
  RECALL_INVALID_FOLLOW_UP: 'The follow-up date cannot be in the past.',
  RECALL_NOTE_TOO_LONG: 'The note is too long.',
  RECALL_JOB_NOT_FOUND: 'That job could not be found.',
};

// ---------------------------------------------------------------- normalisation

const SEVERITIES: readonly RecallSeverity[] = ['low', 'medium', 'high', 'critical'];
const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['active', 'paused', 'completed', 'cancelled'];
const OUTREACH_STATUSES: readonly OutreachStatus[] = ['pending', 'contacted', 'scheduled', 'completed', 'declined', 'unreachable', 'not_affected'];
const CHANNELS: readonly OutreachChannel[] = ['phone', 'sms', 'email', 'in_person', 'mail'];
const METHODS: readonly MatchMethod[] = ['linked', 'exact', 'family', 'manufacturer'];

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function normalizeCounts(raw: unknown): StatusCounts {
  const r = obj(raw);
  return {
    total: num(r.total),
    pending: num(r.pending),
    contacted: num(r.contacted),
    scheduled: num(r.scheduled),
    completed: num(r.completed),
    declined: num(r.declined),
    unreachable: num(r.unreachable),
    not_affected: num(r.not_affected),
  };
}

export function normalizeCampaigns(raw: unknown): RecallCampaign[] {
  if (!Array.isArray(raw)) return [];
  const out: RecallCampaign[] = [];
  for (const item of raw) {
    const r = obj(item);
    const id = str(r.id);
    if (!id) continue;
    out.push({
      id,
      source_kind: r.source_kind === 'bulletin' ? 'bulletin' : 'recall',
      source_id: str(r.source_id),
      number: str(r.number) ?? '—',
      title: str(r.title) ?? 'Untitled notice',
      severity: oneOf(r.severity, SEVERITIES, 'medium'),
      status: oneOf(r.status, CAMPAIGN_STATUSES, 'active'),
      auto_created: r.auto_created === true,
      notes: str(r.notes),
      created_at: str(r.created_at),
      completed_at: str(r.completed_at),
      issued_date: str(r.issued_date),
      remedy: str(r.remedy),
      description: str(r.description),
      source_url: safeHttpsUrl(r.source_url),
      counts: normalizeCounts(r.counts),
      urgent_open: num(r.urgent_open),
      overdue: num(r.overdue),
    });
  }
  return out;
}

export function normalizeOutreach(raw: unknown): OutreachRow[] {
  if (!Array.isArray(raw)) return [];
  const out: OutreachRow[] = [];
  for (const item of raw) {
    const r = obj(item);
    const id = str(r.id);
    const equipmentId = str(r.equipment_id);
    if (!id || !equipmentId) continue;
    const e = obj(r.equipment);
    const c = obj(r.customer);
    out.push({
      id,
      campaign_id: str(r.campaign_id) ?? '',
      equipment_id: equipmentId,
      customer_id: str(r.customer_id),
      status: oneOf(r.status, OUTREACH_STATUSES, 'pending'),
      applicability: r.applicability === 'applies' ? 'applies' : 'possible',
      match_method: oneOf(r.match_method, METHODS, 'manufacturer'),
      priority_score: Math.min(100, Math.max(0, Math.round(num(r.priority_score)))),
      priority_reasons: Array.isArray(r.priority_reasons) ? r.priority_reasons.filter((x): x is string => typeof x === 'string') : [],
      attempts: Math.max(0, Math.round(num(r.attempts))),
      last_contacted_at: str(r.last_contacted_at),
      next_follow_up_at: str(r.next_follow_up_at),
      job_id: str(r.job_id),
      resolution_note: str(r.resolution_note),
      resolved_at: str(r.resolved_at),
      created_at: str(r.created_at),
      equipment: {
        equipment_type: str(e.equipment_type) ?? 'equipment',
        make: str(e.make),
        model: str(e.model),
        serial_number: str(e.serial_number),
        install_date: str(e.install_date),
      },
      customer: {
        name: str(c.name) ?? 'Unknown customer',
        phone: str(c.phone),
        email: str(c.email),
        address: str(c.address),
        customer_type: str(c.customer_type),
      },
    });
  }
  return out;
}

export function normalizeEvents(raw: unknown): OutreachEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: OutreachEvent[] = [];
  for (const item of raw) {
    const r = obj(item);
    const id = str(r.id);
    if (!id) continue;
    const type = str(r.event_type);
    out.push({
      id,
      event_type: (type as OutreachEvent['event_type']) ?? 'note',
      channel: oneOf<OutreachChannel | ''>(r.channel, [...CHANNELS, ''], '') || null,
      from_status: str(r.from_status),
      to_status: str(r.to_status),
      note: str(r.note),
      created_at: str(r.created_at),
    });
  }
  return out;
}

export function normalizeScan(raw: unknown): ScanResult {
  const r = obj(raw);
  return { campaigns: num(r.campaigns), matched: num(r.matched), created: num(r.created) };
}

/** Only https links are ever rendered as hrefs. */
export function safeHttpsUrl(v: unknown): string | null {
  const s = str(v);
  return s && /^https:\/\//i.test(s) ? s : null;
}

// ---------------------------------------------------------------- status logic

export function isTerminal(status: OutreachStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function urgencyOf(score: number): Urgency {
  if (score >= URGENT_SCORE) return 'urgent';
  if (score >= HIGH_SCORE) return 'high';
  return 'standard';
}

export function reasonLabel(code: string): string {
  return REASON_LABELS[code] ?? code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Rows that are still open count as "overdue" when their follow-up date has passed. */
export function isOverdue(row: Pick<OutreachRow, 'status' | 'next_follow_up_at'>, now: Date): boolean {
  if (isTerminal(row.status) || !row.next_follow_up_at) return false;
  const t = Date.parse(row.next_follow_up_at);
  return Number.isFinite(t) && t < now.getTime();
}

export function campaignProgress(counts: StatusCounts): { closed: number; open: number; percent: number } {
  const closed = counts.completed + counts.declined + counts.unreachable + counts.not_affected;
  const open = Math.max(0, counts.total - closed);
  const percent = counts.total > 0 ? Math.round((closed / counts.total) * 100) : 0;
  return { closed, open, percent };
}

/** Actions the UI may offer; mirrors recall_log_outreach(). */
export function allowedActions(status: OutreachStatus, attempts: number): OutreachAction[] {
  if (isTerminal(status)) return ['reopened', 'note'];
  const base: OutreachAction[] = ['attempt', 'contacted', 'scheduled', 'completed', 'declined'];
  if (attempts >= MIN_ATTEMPTS_FOR_UNREACHABLE) base.push('unreachable');
  base.push('not_affected', 'note');
  return base;
}

export function actionRequirements(action: OutreachAction): { channel: boolean; note: boolean; followUp: boolean } {
  return {
    channel: action === 'attempt' || action === 'contacted',
    note: action === 'declined' || action === 'not_affected' || action === 'note',
    followUp: action === 'attempt' || action === 'contacted' || action === 'scheduled' || action === 'note',
  };
}

/** Client-side mirror of the DB evidence rules. Returns an error message or null. */
export function validateAction(
  row: Pick<OutreachRow, 'status' | 'attempts'>,
  input: { action: OutreachAction; channel: OutreachChannel | null; note: string },
): string | null {
  if (!allowedActions(row.status, row.attempts).includes(input.action)) return RECALL_ERRORS.RECALL_INVALID_TRANSITION;
  const req = actionRequirements(input.action);
  if (req.channel && !input.channel) return RECALL_ERRORS.RECALL_CHANNEL_REQUIRED;
  if (req.note && input.note.trim() === '') return RECALL_ERRORS.RECALL_NOTE_REQUIRED;
  if (input.note.length > 1000) return RECALL_ERRORS.RECALL_NOTE_TOO_LONG;
  return null;
}

/** Turns a Postgres/PostgREST error into a friendly sentence. */
export function friendlyRecallError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const message = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : '';
  for (const code of Object.keys(RECALL_ERRORS)) {
    if (message.includes(code)) return RECALL_ERRORS[code];
  }
  return fallback;
}

// ---------------------------------------------------------------- list helpers

export function equipmentLabel(e: Pick<OutreachRow['equipment'], 'make' | 'model' | 'equipment_type'>): string {
  const name = [e.make, e.model].filter(Boolean).join(' ');
  return name || e.equipment_type;
}

export function filterOutreach(rows: OutreachRow[], filter: OutreachFilter, query: string, now: Date): OutreachRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === 'open' && isTerminal(r.status)) return false;
    if (filter === 'closed' && !isTerminal(r.status)) return false;
    if (filter === 'urgent' && (isTerminal(r.status) || r.priority_score < URGENT_SCORE)) return false;
    if (filter === 'overdue' && !isOverdue(r, now)) return false;
    if (filter === 'verify' && (isTerminal(r.status) || r.applicability !== 'possible')) return false;
    if (!q) return true;
    const hay = [r.customer.name, r.customer.address, r.customer.phone, r.customer.email, r.equipment.make, r.equipment.model, r.equipment.serial_number, r.equipment.equipment_type]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

export function countByFilter(rows: OutreachRow[], now: Date): Record<OutreachFilter, number> {
  const base = { open: 0, urgent: 0, overdue: 0, verify: 0, closed: 0, all: rows.length };
  for (const r of rows) {
    if (isTerminal(r.status)) {
      base.closed += 1;
      continue;
    }
    base.open += 1;
    if (r.priority_score >= URGENT_SCORE) base.urgent += 1;
    if (isOverdue(r, now)) base.overdue += 1;
    if (r.applicability === 'possible') base.verify += 1;
  }
  return base;
}

export function summarizeCampaigns(campaigns: RecallCampaign[]): {
  activeCampaigns: number;
  openUnits: number;
  urgentOpen: number;
  overdue: number;
} {
  let activeCampaigns = 0;
  let openUnits = 0;
  let urgentOpen = 0;
  let overdue = 0;
  for (const c of campaigns) {
    if (c.status === 'active') activeCampaigns += 1;
    if (c.status === 'cancelled') continue;
    openUnits += campaignProgress(c.counts).open;
    urgentOpen += c.urgent_open;
    overdue += c.overdue;
  }
  return { activeCampaigns, openUnits, urgentOpen, overdue };
}

/** "Overdue by 2 days" / "Due today" / "In 3 days"; null when there is no follow-up. */
export function formatFollowUp(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date(t)) - startOf(now)) / 86_400_000);
  if (days === 0) return 'Due today';
  if (days > 0) return `In ${days} day${days === 1 ? '' : 's'}`;
  return `Overdue by ${-days} day${days === -1 ? '' : 's'}`;
}

/** A yyyy-mm-dd date input -> ISO at 09:00 local; null for empty / invalid input. */
export function followUpFromDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T09:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------- customer contact + messages

export function contactLinks(c: Pick<OutreachRow['customer'], 'phone' | 'email'>, subject = '', body = ''): { tel: string | null; sms: string | null; mailto: string | null } {
  const digits = (c.phone ?? '').replace(/[^\d+]/g, '');
  const phone = digits.replace(/(?!^)\+/g, '');
  const hasPhone = phone.replace(/\D/g, '').length >= 7;
  const email = (c.email ?? '').trim();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return {
    tel: hasPhone ? `tel:${phone}` : null,
    sms: hasPhone ? `sms:${phone}${body ? `?body=${encodeURIComponent(body)}` : ''}` : null,
    mailto: validEmail ? `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : null,
  };
}

export interface MessageContext {
  campaign: Pick<RecallCampaign, 'source_kind' | 'number' | 'title' | 'severity' | 'remedy'>;
  row: Pick<OutreachRow, 'applicability' | 'equipment' | 'customer'>;
  businessName?: string | null;
}

function firstName(name: string): string {
  const f = name.trim().split(/\s+/)[0];
  return f && f !== 'Unknown' ? f : 'there';
}

/**
 * Factual customer message. It states only what the notice says, flags uncertainty when the match is
 * not confirmed, and never promises a price, a free repair or an outcome.
 */
export function buildOutreachMessage(channel: 'sms' | 'email' | 'phone', ctx: MessageContext): { subject: string; body: string } {
  const { campaign: c, row } = ctx;
  const kind = c.source_kind === 'recall' ? 'recall' : 'service bulletin';
  const unit = equipmentLabel(row.equipment);
  const who = firstName(row.customer.name);
  const sign = ctx.businessName?.trim() || 'Your service team';
  const urgent = c.severity === 'critical' || c.severity === 'high';
  const confirm = row.applicability === 'possible' ? ' We are confirming whether your exact unit is affected.' : '';
  const remedy = c.remedy ? ` The manufacturer's stated remedy: ${c.remedy.trim()}` : '';
  const subject = c.source_kind === 'recall' ? `Important safety notice for your ${unit}` : `Service notice for your ${unit}`;

  if (channel === 'sms') {
    const short = `Hi ${who}, ${sign} here. The manufacturer issued ${kind} ${c.number} that may affect your ${unit}.${confirm} ${urgent ? 'Please reply or call to schedule a prompt inspection.' : 'Reply or call and we will arrange a visit.'}`;
    return { subject, body: short.replace(/\s+/g, ' ').trim() };
  }
  if (channel === 'email') {
    const body = [
      `Hello ${who},`,
      '',
      `The manufacturer has issued ${kind} ${c.number} ("${c.title}") that may affect the ${unit} at your property.${confirm}${remedy}`,
      '',
      urgent
        ? 'Because this notice is rated ' + c.severity + ', we recommend scheduling an inspection as soon as possible and following the manufacturer\'s safety guidance in the meantime.'
        : 'We recommend scheduling a visit so we can check your unit and take any action the manufacturer requires.',
      '',
      'Reply to this email or call us and we will arrange a convenient time.',
      '',
      sign,
    ].join('\n');
    return { subject, body };
  }
  const body = [
    `Call script — ${who}`,
    `1. Introduce yourself (${sign}) and confirm you are speaking with the account holder.`,
    `2. Explain: the manufacturer issued ${kind} ${c.number} ("${c.title}") that may affect the ${unit}.${confirm}`,
    remedy ? `3.${remedy}` : '3. Explain that the manufacturer\'s remedy will be confirmed at the visit.',
    urgent ? '4. Stress the notice is rated ' + c.severity + ' and offer the earliest available inspection.' : '4. Offer to schedule a visit.',
    '5. Log the outcome (reached, scheduled, declined, or no answer) right after the call.',
  ].join('\n');
  return { subject, body };
}
