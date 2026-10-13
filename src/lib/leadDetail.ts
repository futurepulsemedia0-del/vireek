/**
 * Pure logic for the Lead Detail page (/dashboard/leads/:id).
 *
 * Kept free of React / Supabase imports so every rule — score reasoning,
 * source attribution, timeline merging, conversion payloads — is unit-testable
 * and the page component stays a thin view over it.
 */

// ============================================================
// TYPES — structural and query-shaped (only the columns the page selects)
// ============================================================

export type LeadStage = 'new' | 'contacted' | 'quoted' | 'won' | 'lost';

export interface LeadLike {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  service_interested: string | null;
  notes: string | null;
  stage: LeadStage;
  customer_id: string | null;
  quote_amount: number | null;
  quote_sent_at: string | null;
  follow_up_count: number;
  last_follow_up_at: string | null;
  created_at: string;
}

export interface CallLike {
  id: string;
  caller_name: string | null;
  call_datetime: string;
  duration_seconds: number | null;
  summary: string | null;
  status: string;
  is_voicemail: boolean;
  is_emergency: boolean;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  lead_source: string | null;
  source_label: string | null;
}

export interface QuoteLike {
  id: string;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';
  line_items: { description: string; quantity: number; unit_price_cents: number }[];
  tax_percent: number;
  sent_at: string | null;
  responded_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  created_at: string;
}

export interface JobLike {
  id: string;
  service_type: string | null;
  job_status: string;
  created_at: string;
}

export interface ActivityEventLike {
  id: number;
  event_type: string;
  occurred_at: string;
  actor_type: string;
}

export interface TouchLike {
  id: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  landing_page: string | null;
  referrer: string | null;
  is_first_touch: boolean;
  occurred_at: string;
}

// ============================================================
// FORMATTERS
// ============================================================

const validTime = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

export function formatTimeAgo(iso: string, now: number = Date.now()): string {
  const t = validTime(iso);
  if (t === null) return '—';
  const diff = Math.max(0, now - t);
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return mins > 0 ? `${mins}m ago` : 'just now';
}

export function formatDateTime(iso: string): string {
  const t = validTime(iso);
  if (t === null) return '—';
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function quoteTotalCents(q: Pick<QuoteLike, 'line_items' | 'tax_percent'>): number {
  const subtotal = (q.line_items ?? []).reduce((sum, li) => sum + (li.quantity || 0) * (li.unit_price_cents || 0), 0);
  return Math.round(subtotal * (1 + (q.tax_percent || 0) / 100));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Guards the route param so a mangled URL shows "not found" instead of a Postgres cast error. */
export const isUuid = (value: string | undefined): value is string => !!value && UUID_RE.test(value);

// ============================================================
// AI SCORE REASONING
// ============================================================

export type ScoreGrade = 'hot' | 'warm' | 'cold';

export const GRADE_META: Record<ScoreGrade, { label: string; tone: string; hint: string }> = {
  hot: { label: 'Hot', tone: 'text-success-500', hint: 'High buying intent — contact immediately.' },
  warm: { label: 'Warm', tone: 'text-warning-500', hint: 'Engaged but not committed — follow up soon.' },
  cold: { label: 'Cold', tone: 'text-text-secondary', hint: 'Low engagement — nurture or deprioritise.' },
};

export interface ScoreFactorRow {
  key: string;
  label: string;
  points: number;
  max: number;
  explanation: string;
}

interface FactorMeta {
  label: string;
  max: number;
  explain: (points: number) => string;
}

/** Mirrors the scoring rubric in supabase/functions/_shared/marketing/scoring.ts. */
const FACTOR_META: Record<string, FactorMeta> = {
  stage_bonus: {
    label: 'Pipeline progress',
    max: 25,
    explain: (p) =>
      p >= 25 ? 'A quote has been sent — strong buying signal.' : p >= 10 ? 'First contact has been made.' : 'Not contacted yet.',
  },
  calls: {
    label: 'Call engagement',
    max: 30,
    explain: (p) => (p > 0 ? `${Math.round(p / 10)}${p >= 30 ? '+' : ''} call(s) linked to this lead.` : 'No calls linked yet.'),
  },
  jobs_started: {
    label: 'Work booked',
    max: 20,
    explain: (p) => (p > 0 ? 'A job has been created from this lead.' : 'No job created yet.'),
  },
  recency: {
    label: 'Recency',
    max: 15,
    explain: (p) =>
      p >= 15 ? 'Created within the last 3 days.' : p >= 5 ? 'Created within the last 2 weeks.' : 'Older than 2 weeks — urgency has faded.',
  },
};

const humanize = (key: string) => key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Turns the raw `lead_scores.factors` JSON into rows a human can read. Unknown keys degrade gracefully. */
export function buildScoreBreakdown(factors: unknown): ScoreFactorRow[] {
  if (!factors || typeof factors !== 'object' || Array.isArray(factors)) return [];
  const rows: ScoreFactorRow[] = [];
  for (const [key, raw] of Object.entries(factors as Record<string, unknown>)) {
    const points = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    if (points === null) continue;
    const meta = FACTOR_META[key];
    rows.push({
      key,
      label: meta?.label ?? humanize(key),
      points,
      max: meta?.max ?? Math.max(10, Math.abs(points)),
      explanation: meta?.explain(points) ?? (points >= 0 ? `Adds ${points} points.` : `Removes ${Math.abs(points)} points.`),
    });
  }
  return rows.sort((a, b) => b.points - a.points);
}

export const isScoreGrade = (v: unknown): v is ScoreGrade => v === 'hot' || v === 'warm' || v === 'cold';

// ============================================================
// SOURCE ATTRIBUTION
// ============================================================

const CHANNEL_LABELS: Record<string, string> = {
  google_ads: 'Google Ads',
  facebook_ads: 'Facebook Ads',
  referral: 'Referral',
  organic: 'Organic search',
  direct: 'Direct',
  other: 'Other',
};

export const CHANNEL_OPTIONS = Object.entries(CHANNEL_LABELS).map(([value, label]) => ({ value, label }));

export type SourceProvenance = 'owner_tagged' | 'first_touch' | 'call_label' | 'unknown';

export interface SourceEvidence {
  kind: 'owner_tagged' | 'first_touch' | 'last_touch' | 'call_label';
  label: string;
  detail: string | null;
  at: string | null;
}

export interface ResolvedSource {
  label: string;
  provenance: SourceProvenance;
  evidence: SourceEvidence[];
}

const touchLabel = (t: TouchLike) => [t.source, t.medium].filter(Boolean).join(' / ') || 'Unknown touch';
const touchDetail = (t: TouchLike) => [t.campaign && `Campaign: ${t.campaign}`, t.landing_page && `Landing: ${t.landing_page}`, t.referrer && `Referrer: ${t.referrer}`].filter(Boolean).join(' · ') || null;

/**
 * Priority: a human-tagged channel on the originating call is the most
 * trustworthy, then the machine-recorded first marketing touch, then the
 * call's free-text source label. Every piece of evidence is still surfaced.
 */
export function resolveSource(call: CallLike | null, touches: TouchLike[]): ResolvedSource {
  const evidence: SourceEvidence[] = [];
  const sorted = [...touches].sort((a, b) => (validTime(a.occurred_at) ?? 0) - (validTime(b.occurred_at) ?? 0));
  const first = sorted.find((t) => t.is_first_touch) ?? sorted[0];
  const last = sorted.length > 1 ? sorted[sorted.length - 1] : undefined;

  const tagged = call?.lead_source ? (CHANNEL_LABELS[call.lead_source] ?? humanize(call.lead_source)) : null;
  if (tagged) evidence.push({ kind: 'owner_tagged', label: tagged, detail: 'Tagged on the originating call', at: call?.call_datetime ?? null });
  if (first) evidence.push({ kind: 'first_touch', label: touchLabel(first), detail: touchDetail(first), at: first.occurred_at });
  if (last && last.id !== first?.id) evidence.push({ kind: 'last_touch', label: touchLabel(last), detail: touchDetail(last), at: last.occurred_at });
  if (call?.source_label) evidence.push({ kind: 'call_label', label: call.source_label, detail: 'Label recorded with the call', at: call.call_datetime });

  if (tagged) return { label: tagged, provenance: 'owner_tagged', evidence };
  if (first) return { label: touchLabel(first), provenance: 'first_touch', evidence };
  if (call?.source_label) return { label: call.source_label, provenance: 'call_label', evidence };
  return { label: 'Unattributed', provenance: 'unknown', evidence };
}

// ============================================================
// CONTACT HISTORY TIMELINE
// ============================================================

export type TimelineKind = 'lead' | 'call' | 'quote' | 'job' | 'follow_up' | 'activity';
export type TimelineTone = 'neutral' | 'positive' | 'negative' | 'attention';

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  at: string;
  title: string;
  detail: string | null;
  tone: TimelineTone;
}

/** Activity-ledger events already represented by a first-class row below — skipped to avoid duplicate entries. */
const COVERED_EVENT_TYPES = new Set(['lead.created', 'call.created', 'job.created', 'quote.sent', 'quote.accepted']);

const EVENT_TITLES: Record<string, string> = {
  'job.completed': 'Job completed',
  'payment.received': 'Payment received',
  'review.completed': 'Review submitted',
};

const clip = (s: string | null, n = 160) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function buildTimeline(input: {
  lead: LeadLike;
  calls: CallLike[];
  quotes: QuoteLike[];
  jobs: JobLike[];
  history: ActivityEventLike[];
}): TimelineItem[] {
  const { lead, calls, quotes, jobs, history } = input;
  const items: TimelineItem[] = [{ id: 'lead-created', kind: 'lead', at: lead.created_at, title: 'Lead created', detail: lead.service_interested, tone: 'neutral' }];

  for (const c of calls) {
    const title = c.is_voicemail ? 'Voicemail left' : c.status === 'missed' ? 'Missed call' : c.is_emergency ? 'Emergency call' : 'Call answered';
    const dur = formatDuration(c.duration_seconds);
    items.push({
      id: `call-${c.id}`,
      kind: 'call',
      at: c.call_datetime,
      title,
      detail: [clip(c.summary), dur && `Duration ${dur}`].filter(Boolean).join(' · ') || null,
      tone: c.status === 'missed' || c.sentiment === 'negative' ? 'negative' : c.is_emergency ? 'attention' : 'neutral',
    });
  }

  for (const q of quotes) {
    const total = formatCents(quoteTotalCents(q));
    items.push({ id: `quote-${q.id}-created`, kind: 'quote', at: q.created_at, title: 'Quote drafted', detail: total, tone: 'neutral' });
    if (q.sent_at) items.push({ id: `quote-${q.id}-sent`, kind: 'quote', at: q.sent_at, title: 'Quote sent', detail: total, tone: 'neutral' });
    if (q.last_viewed_at) {
      items.push({ id: `quote-${q.id}-viewed`, kind: 'quote', at: q.last_viewed_at, title: 'Quote viewed by customer', detail: `${q.view_count} view${q.view_count === 1 ? '' : 's'}`, tone: 'attention' });
    }
    if (q.responded_at && (q.status === 'accepted' || q.status === 'declined')) {
      items.push({ id: `quote-${q.id}-resp`, kind: 'quote', at: q.responded_at, title: q.status === 'accepted' ? 'Quote accepted' : 'Quote declined', detail: total, tone: q.status === 'accepted' ? 'positive' : 'negative' });
    }
  }
  // Legacy leads carry the quote on the lead row itself, with no quote record.
  if (lead.quote_sent_at && !quotes.some((q) => q.sent_at)) {
    items.push({ id: 'lead-quote-sent', kind: 'quote', at: lead.quote_sent_at, title: 'Quote sent', detail: lead.quote_amount !== null ? formatCents(Math.round(lead.quote_amount * 100)) : null, tone: 'neutral' });
  }

  for (const j of jobs) {
    items.push({ id: `job-${j.id}`, kind: 'job', at: j.created_at, title: 'Job created', detail: [j.service_type, j.job_status.replace(/_/g, ' ')].filter(Boolean).join(' · ') || null, tone: 'positive' });
  }

  if (lead.last_follow_up_at && lead.follow_up_count > 0) {
    items.push({ id: 'follow-up', kind: 'follow_up', at: lead.last_follow_up_at, title: 'Automated follow-up sent', detail: `${lead.follow_up_count} follow-up${lead.follow_up_count === 1 ? '' : 's'} so far`, tone: 'neutral' });
  }

  for (const e of history) {
    if (COVERED_EVENT_TYPES.has(e.event_type)) continue;
    items.push({ id: `event-${e.id}`, kind: 'activity', at: e.occurred_at, title: EVENT_TITLES[e.event_type] ?? humanize(e.event_type.replace('.', ' ')), detail: e.actor_type === 'ai' ? 'By Vireek AI' : null, tone: 'neutral' });
  }

  return items
    .filter((i) => validTime(i.at) !== null)
    .sort((a, b) => (validTime(b.at) as number) - (validTime(a.at) as number));
}

// ============================================================
// CONVERT TO CUSTOMER + QUOTE
// ============================================================

export function buildCustomerPayload(lead: LeadLike, ownerId: string) {
  return {
    user_id: ownerId,
    name: lead.name.trim(),
    phone: lead.phone?.trim() || null,
    email: lead.email?.trim() || null,
    customer_type: 'residential' as const,
    lifecycle_stage: 'lead' as const,
    tags: [] as string[],
    notes: lead.notes?.trim() || null,
    source: 'lead' as const,
  };
}

export function buildDraftQuotePayload(lead: LeadLike, ownerId: string) {
  const service = lead.service_interested?.trim();
  return {
    user_id: ownerId,
    lead_id: lead.id,
    customer_name: lead.name.trim(),
    customer_phone: lead.phone?.trim() || null,
    customer_email: lead.email?.trim() || null,
    line_items: service ? [{ description: service, quantity: 1, unit_price_cents: 0 }] : [],
    tax_percent: 0,
    status: 'draft' as const,
    ai_generated: false,
  };
}

export interface ConversionState {
  customerLinked: boolean;
  hasDraftQuote: boolean;
  hasOpenQuote: boolean;
  hasJob: boolean;
  complete: boolean;
}

export function getConversionState(lead: LeadLike, quotes: QuoteLike[], jobs: JobLike[]): ConversionState {
  const customerLinked = !!lead.customer_id;
  const hasDraftQuote = quotes.some((q) => q.status === 'draft');
  const hasOpenQuote = quotes.some((q) => q.status === 'draft' || q.status === 'sent');
  const hasJob = jobs.length > 0;
  return { customerLinked, hasDraftQuote, hasOpenQuote, hasJob, complete: customerLinked && quotes.length > 0 };
}
