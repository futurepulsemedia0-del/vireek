/**
 * Quote detail workspace — pure domain logic for /dashboard/quotes/:id.
 *
 * No network, no React, no Supabase here: everything is deterministic and
 * unit-tested (quoteWorkspace.test.ts). The data comes from the
 * `get_quote_workspace` RPC (see quoteWorkspaceApi.ts) as untyped jsonb, so
 * the first job of this module is to parse it defensively — a malformed row
 * must degrade to an empty list, never crash the page.
 *
 * Money is integer cents everywhere. The helpers below mirror
 * `quote_option_total_cents()` / `quote_headline_total_cents()` in
 * supabase/migrations/20270301000000_quote_detail_workspace.sql — change one,
 * change the other.
 */

// ============================================================
// TYPES
// ============================================================

export interface LineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface SnapshotOption {
  id: string;
  tier: string;
  name: string;
  summary: string;
  warranty_label: string | null;
  recommended: boolean;
  line_items: LineItem[];
}

export interface QuoteSnapshot {
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  line_items: LineItem[];
  options: SnapshotOption[];
  recommended_option_id: string | null;
  tax_percent: number;
  deposit_percent: number;
  valid_until: string | null;
  presentation_note: string | null;
}

export interface QuoteVersion {
  id: string;
  version_number: number;
  snapshot: QuoteSnapshot;
  total_cents: number;
  created_at: string;
}

export type FollowUpChannel = 'call' | 'sms' | 'email' | 'visit';
export type FollowUpStatus = 'pending' | 'done' | 'skipped' | 'cancelled';

export interface QuoteFollowUp {
  id: string;
  step_number: number;
  channel: FollowUpChannel;
  due_at: string;
  status: FollowUpStatus;
  suggested_message: string | null;
  outcome: string | null;
  completed_at: string | null;
}

export type QuoteEventType = 'viewed' | 'option_selected' | 'accepted' | 'declined';

export interface QuoteEventRow {
  id: string;
  event_type: QuoteEventType;
  option_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';

export interface WorkspaceQuote {
  id: string;
  user_id: string;
  lead_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  line_items: LineItem[];
  options: SnapshotOption[];
  recommended_option_id: string | null;
  selected_option_id: string | null;
  accepted_total_cents: number | null;
  presentation_note: string | null;
  deposit_percent: number;
  tax_percent: number;
  status: QuoteStatus;
  quote_token: string;
  valid_until: string | null;
  sent_at: string | null;
  responded_at: string | null;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceJob {
  id: string;
  job_status: string;
  scheduled_datetime: string | null;
  created_at: string;
}

export interface WorkspaceLead {
  id: string;
  stage: string;
  follow_up_count: number;
  last_follow_up_at: string | null;
}

export interface QuoteWorkspace {
  quote: WorkspaceQuote;
  versions: QuoteVersion[]; // newest first
  events: QuoteEventRow[]; // newest first
  followups: QuoteFollowUp[]; // by step_number
  job: WorkspaceJob | null;
  lead: WorkspaceLead | null;
}

// ============================================================
// DEFENSIVE PARSING (jsonb arrives as `unknown`)
// ============================================================

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function parseLineItems(raw: unknown): LineItem[] {
  return arr(raw)
    .filter(isRec)
    .map((li) => ({
      description: str(li.description).trim(),
      quantity: Math.max(0, num(li.quantity)),
      unit_price_cents: Math.max(0, num(li.unit_price_cents)),
    }));
}

export function parseOptions(raw: unknown): SnapshotOption[] {
  return arr(raw)
    .filter(isRec)
    .map((o, i) => ({
      id: str(o.id, `option-${i}`),
      tier: str(o.tier, 'good'),
      name: str(o.name).trim(),
      summary: str(o.summary).trim(),
      warranty_label: strOrNull(o.warranty_label),
      recommended: o.recommended === true,
      line_items: parseLineItems(o.line_items),
    }));
}

export function parseSnapshot(raw: unknown): QuoteSnapshot {
  const s: Rec = isRec(raw) ? raw : {};
  return {
    customer_name: str(s.customer_name),
    customer_phone: strOrNull(s.customer_phone),
    customer_email: strOrNull(s.customer_email),
    line_items: parseLineItems(s.line_items),
    options: parseOptions(s.options),
    recommended_option_id: strOrNull(s.recommended_option_id),
    tax_percent: num(s.tax_percent),
    deposit_percent: num(s.deposit_percent),
    valid_until: strOrNull(s.valid_until),
    presentation_note: strOrNull(s.presentation_note),
  };
}

const STATUSES: QuoteStatus[] = ['draft', 'sent', 'accepted', 'declined', 'expired'];
const CHANNELS: FollowUpChannel[] = ['call', 'sms', 'email', 'visit'];
const FOLLOWUP_STATUSES: FollowUpStatus[] = ['pending', 'done', 'skipped', 'cancelled'];
const EVENT_TYPES: QuoteEventType[] = ['viewed', 'option_selected', 'accepted', 'declined'];

function parseQuote(raw: unknown): WorkspaceQuote | null {
  if (!isRec(raw) || typeof raw.id !== 'string' || typeof raw.user_id !== 'string') return null;
  const status = STATUSES.includes(raw.status as QuoteStatus) ? (raw.status as QuoteStatus) : 'draft';
  return {
    id: raw.id,
    user_id: raw.user_id,
    lead_id: strOrNull(raw.lead_id),
    customer_name: str(raw.customer_name),
    customer_phone: strOrNull(raw.customer_phone),
    customer_email: strOrNull(raw.customer_email),
    line_items: parseLineItems(raw.line_items),
    options: parseOptions(raw.options),
    recommended_option_id: strOrNull(raw.recommended_option_id),
    selected_option_id: strOrNull(raw.selected_option_id),
    accepted_total_cents: raw.accepted_total_cents == null ? null : num(raw.accepted_total_cents),
    presentation_note: strOrNull(raw.presentation_note),
    deposit_percent: num(raw.deposit_percent),
    tax_percent: num(raw.tax_percent),
    status,
    quote_token: str(raw.quote_token),
    valid_until: strOrNull(raw.valid_until),
    sent_at: strOrNull(raw.sent_at),
    responded_at: strOrNull(raw.responded_at),
    first_viewed_at: strOrNull(raw.first_viewed_at),
    last_viewed_at: strOrNull(raw.last_viewed_at),
    view_count: Math.max(0, Math.round(num(raw.view_count))),
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
  };
}

/** Parses the RPC payload. Returns null when the quote itself is unusable. */
export function parseWorkspace(raw: unknown): QuoteWorkspace | null {
  if (!isRec(raw)) return null;
  const quote = parseQuote(raw.quote);
  if (!quote) return null;

  const versions: QuoteVersion[] = arr(raw.versions)
    .filter(isRec)
    .filter((v) => typeof v.id === 'string' && num(v.version_number) >= 1)
    .map((v) => ({
      id: str(v.id),
      version_number: Math.round(num(v.version_number)),
      snapshot: parseSnapshot(v.snapshot),
      total_cents: Math.round(num(v.total_cents)),
      created_at: str(v.created_at),
    }))
    .sort((a, b) => b.version_number - a.version_number);

  const events: QuoteEventRow[] = arr(raw.events)
    .filter(isRec)
    .filter((e) => typeof e.id === 'string' && EVENT_TYPES.includes(e.event_type as QuoteEventType))
    .map((e) => ({
      id: str(e.id),
      event_type: e.event_type as QuoteEventType,
      option_id: strOrNull(e.option_id),
      metadata: isRec(e.metadata) ? e.metadata : {},
      created_at: str(e.created_at),
    }));

  const followups: QuoteFollowUp[] = arr(raw.followups)
    .filter(isRec)
    .filter((f) => typeof f.id === 'string' && CHANNELS.includes(f.channel as FollowUpChannel))
    .map((f) => ({
      id: str(f.id),
      step_number: Math.round(num(f.step_number)),
      channel: f.channel as FollowUpChannel,
      due_at: str(f.due_at),
      status: FOLLOWUP_STATUSES.includes(f.status as FollowUpStatus) ? (f.status as FollowUpStatus) : 'pending',
      suggested_message: strOrNull(f.suggested_message),
      outcome: strOrNull(f.outcome),
      completed_at: strOrNull(f.completed_at),
    }))
    .sort((a, b) => a.step_number - b.step_number);

  const job =
    isRec(raw.job) && typeof raw.job.id === 'string'
      ? {
          id: raw.job.id,
          job_status: str(raw.job.job_status, 'scheduled'),
          scheduled_datetime: strOrNull(raw.job.scheduled_datetime),
          created_at: str(raw.job.created_at),
        }
      : null;

  const lead =
    isRec(raw.lead) && typeof raw.lead.id === 'string'
      ? {
          id: raw.lead.id,
          stage: str(raw.lead.stage),
          follow_up_count: Math.max(0, Math.round(num(raw.lead.follow_up_count))),
          last_follow_up_at: strOrNull(raw.lead.last_follow_up_at),
        }
      : null;

  return { quote, versions, events, followups, job, lead };
}

// ============================================================
// MONEY
// ============================================================

export function lineItemsSubtotalCents(items: LineItem[]): number {
  return items.reduce((sum, li) => sum + Math.max(0, li.quantity) * Math.max(0, li.unit_price_cents), 0);
}

export function withTaxCents(subtotalCents: number, taxPercent: number): number {
  return subtotalCents + Math.round((subtotalCents * Math.max(0, taxPercent || 0)) / 100);
}

export function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatSignedUsd(cents: number): string {
  if (cents === 0) return formatUsd(0);
  return `${cents > 0 ? '+' : '\u2212'}${formatUsd(Math.abs(cents))}`;
}

interface PricingInput {
  line_items: LineItem[];
  options: SnapshotOption[];
  recommended_option_id: string | null;
  tax_percent: number;
}

export function optionTotalCents(option: Pick<SnapshotOption, 'line_items'>, taxPercent: number): number {
  return withTaxCents(lineItemsSubtotalCents(option.line_items), taxPercent);
}

export function isTiered(p: Pick<PricingInput, 'options'>): boolean {
  return p.options.length > 0;
}

/** Recommended option -> flagged option -> first option. */
export function headlineOption(p: Pick<PricingInput, 'options' | 'recommended_option_id'>): SnapshotOption | null {
  if (p.options.length === 0) return null;
  return (
    p.options.find((o) => o.id === p.recommended_option_id) ??
    p.options.find((o) => o.recommended) ??
    p.options[0]
  );
}

export function headlineTotalCents(p: PricingInput): number {
  const opt = headlineOption(p);
  if (opt) return optionTotalCents(opt, p.tax_percent);
  return withTaxCents(lineItemsSubtotalCents(p.line_items), p.tax_percent);
}

export function depositCentsFor(totalCents: number, depositPercent: number): number {
  if (!depositPercent || depositPercent <= 0) return 0;
  return Math.round((totalCents * Math.min(100, depositPercent)) / 100);
}

// ============================================================
// VERSION DIFF
// ============================================================

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface DiffChange {
  id: string;
  kind: ChangeKind;
  /** "Quote", "Items", or the option name. */
  scope: string;
  label: string;
  before: string | null;
  after: string | null;
  /** Change in that line's amount (pre-tax), when it is a priced line. */
  deltaCents: number | null;
}

export interface SnapshotDiff {
  changes: DiffChange[];
  totalBeforeCents: number;
  totalAfterCents: number;
  totalDeltaCents: number;
  hasChanges: boolean;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function keyedLines(items: LineItem[]): Map<string, LineItem> {
  const seen = new Map<string, number>();
  const out = new Map<string, LineItem>();
  for (const li of items) {
    const base = norm(li.description) || '(no description)';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(`${base}#${n}`, li);
  }
  return out;
}

const lineAmount = (li: LineItem) => li.quantity * li.unit_price_cents;
const lineLabel = (li: LineItem) => `${li.quantity} \u00d7 ${formatUsd(li.unit_price_cents)}`;

function diffLines(scope: string, scopeKey: string, before: LineItem[], after: LineItem[]): DiffChange[] {
  const b = keyedLines(before);
  const a = keyedLines(after);
  const out: DiffChange[] = [];

  for (const [key, li] of a) {
    const prev = b.get(key);
    if (!prev) {
      out.push({
        id: `${scopeKey}:add:${key}`, kind: 'added', scope, label: li.description || '(no description)',
        before: null, after: lineLabel(li), deltaCents: lineAmount(li),
      });
    } else if (prev.quantity !== li.quantity || prev.unit_price_cents !== li.unit_price_cents) {
      out.push({
        id: `${scopeKey}:chg:${key}`, kind: 'changed', scope, label: li.description || '(no description)',
        before: lineLabel(prev), after: lineLabel(li), deltaCents: lineAmount(li) - lineAmount(prev),
      });
    }
  }
  for (const [key, li] of b) {
    if (!a.has(key)) {
      out.push({
        id: `${scopeKey}:rem:${key}`, kind: 'removed', scope, label: li.description || '(no description)',
        before: lineLabel(li), after: null, deltaCents: -lineAmount(li),
      });
    }
  }
  return out;
}

function scalarChange(
  out: DiffChange[], id: string, label: string, before: string | null, after: string | null,
): void {
  if ((before ?? '') === (after ?? '')) return;
  out.push({
    id: `quote:${id}`,
    kind: before == null || before === '' ? 'added' : after == null || after === '' ? 'removed' : 'changed',
    scope: 'Quote', label, before: before || null, after: after || null, deltaCents: null,
  });
}

export function diffSnapshots(before: QuoteSnapshot, after: QuoteSnapshot): SnapshotDiff {
  const changes: DiffChange[] = [];

  scalarChange(changes, 'customer_name', 'Customer name', before.customer_name, after.customer_name);
  scalarChange(changes, 'customer_phone', 'Phone', before.customer_phone, after.customer_phone);
  scalarChange(changes, 'customer_email', 'Email', before.customer_email, after.customer_email);
  scalarChange(changes, 'tax', 'Tax rate', `${before.tax_percent}%`, `${after.tax_percent}%`);
  scalarChange(changes, 'deposit', 'Deposit', `${before.deposit_percent}%`, `${after.deposit_percent}%`);
  scalarChange(changes, 'valid_until', 'Valid until', before.valid_until, after.valid_until);
  scalarChange(changes, 'note', 'Note to customer', before.presentation_note, after.presentation_note);

  const beforeTiered = before.options.length > 0;
  const afterTiered = after.options.length > 0;

  if (!beforeTiered && !afterTiered) {
    changes.push(...diffLines('Items', 'flat', before.line_items, after.line_items));
  } else if (beforeTiered !== afterTiered) {
    changes.push({
      id: 'quote:format', kind: 'changed', scope: 'Quote', label: 'Estimate format',
      before: beforeTiered ? `${before.options.length} options` : 'Single price',
      after: afterTiered ? `${after.options.length} options` : 'Single price',
      deltaCents: null,
    });
  } else {
    const bMap = new Map(before.options.map((o) => [o.id, o]));
    const aMap = new Map(after.options.map((o) => [o.id, o]));

    for (const o of after.options) {
      const prev = bMap.get(o.id);
      const label = o.name || 'Unnamed option';
      if (!prev) {
        changes.push({
          id: `opt:${o.id}:add`, kind: 'added', scope: label, label: 'Option added',
          before: null, after: formatUsd(optionTotalCents(o, after.tax_percent)), deltaCents: null,
        });
        continue;
      }
      scalarOption(changes, o.id, label, 'Name', prev.name, o.name);
      scalarOption(changes, o.id, label, 'Summary', prev.summary, o.summary);
      scalarOption(changes, o.id, label, 'Warranty', prev.warranty_label, o.warranty_label);
      scalarOption(changes, o.id, label, 'Tier', prev.tier, o.tier);
      changes.push(...diffLines(label, `opt:${o.id}`, prev.line_items, o.line_items));
    }
    for (const o of before.options) {
      if (!aMap.has(o.id)) {
        changes.push({
          id: `opt:${o.id}:rem`, kind: 'removed', scope: o.name || 'Unnamed option', label: 'Option removed',
          before: formatUsd(optionTotalCents(o, before.tax_percent)), after: null, deltaCents: null,
        });
      }
    }

    const bRec = headlineOption(before)?.id ?? null;
    const aRec = headlineOption(after)?.id ?? null;
    if (bRec !== aRec) {
      changes.push({
        id: 'quote:recommended', kind: 'changed', scope: 'Quote', label: 'Recommended option',
        before: (bRec && bMap.get(bRec)?.name) || null, after: (aRec && aMap.get(aRec)?.name) || null,
        deltaCents: null,
      });
    }
  }

  const totalBeforeCents = headlineTotalCents(before);
  const totalAfterCents = headlineTotalCents(after);
  return {
    changes,
    totalBeforeCents,
    totalAfterCents,
    totalDeltaCents: totalAfterCents - totalBeforeCents,
    hasChanges: changes.length > 0,
  };
}

function scalarOption(
  out: DiffChange[], optionId: string, scope: string, label: string, before: string | null, after: string | null,
): void {
  if ((before ?? '') === (after ?? '')) return;
  out.push({
    id: `opt:${optionId}:${label}`,
    kind: !before ? 'added' : !after ? 'removed' : 'changed',
    scope, label, before: before || null, after: after || null, deltaCents: null,
  });
}

// ============================================================
// FOLLOW-UP PLAN
// ============================================================

export interface FollowUpPlanStep {
  channel: FollowUpChannel;
  due_at: string;
  message: string;
}

const DAY_MS = 86_400_000;
const PLAN_OFFSET_DAYS = [1, 3, 7, 14];

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || 'there';
}

/**
 * Builds a 4-touch plan anchored to when the quote was sent. Adaptive:
 *  - an unopened estimate gets "did it reach you" texts, an opened one gets
 *    "any questions" texts;
 *  - steps already overdue are compressed to one per day starting now instead
 *    of being dumped on the team all at once;
 *  - nothing is scheduled after the quote's valid-until date.
 */
export function buildFollowUpPlan(input: {
  customerName: string;
  sentAt: string | null;
  viewCount: number;
  validUntil: string | null;
  now?: Date;
}): FollowUpPlanStep[] {
  const now = (input.now ?? new Date()).getTime();
  const sent = input.sentAt && Number.isFinite(Date.parse(input.sentAt)) ? Date.parse(input.sentAt) : now;
  const expiry = input.validUntil ? Date.parse(`${input.validUntil}T23:59:59Z`) : null;

  if (expiry !== null && Number.isFinite(expiry) && expiry < now) return [];

  const viewed = input.viewCount > 0;
  const n = firstName(input.customerName);

  const templates: { channel: FollowUpChannel; message: string }[] = [
    {
      channel: 'sms',
      message: viewed
        ? `Hi ${n}, thanks for looking over the estimate. Happy to answer any questions or adjust the scope.`
        : `Hi ${n}, just making sure the estimate link reached you. Let me know if it didn't open.`,
    },
    {
      channel: 'call',
      message: `Call ${n}: ask if they have questions about the options, pricing or timing.`,
    },
    {
      channel: 'sms',
      message: viewed
        ? `Hi ${n}, if the price is the sticking point we can talk through the other options.`
        : `Hi ${n}, resending your estimate link in case it got buried. Reply with any questions.`,
    },
    {
      channel: 'call',
      message: `Final check-in with ${n}: confirm whether they want to proceed before the estimate expires.`,
    },
  ];

  const steps: FollowUpPlanStep[] = [];
  let cursor = now;
  PLAN_OFFSET_DAYS.forEach((days, i) => {
    const due = Math.max(sent + days * DAY_MS, cursor);
    if (expiry !== null && Number.isFinite(expiry) && due > expiry) return;
    cursor = due + DAY_MS;
    steps.push({ channel: templates[i].channel, due_at: new Date(due).toISOString(), message: templates[i].message });
  });
  return steps;
}

export type FollowUpDueState = 'done' | 'skipped' | 'cancelled' | 'overdue' | 'today' | 'upcoming';

export function followUpDueState(f: Pick<QuoteFollowUp, 'status' | 'due_at'>, now: Date = new Date()): FollowUpDueState {
  if (f.status !== 'pending') return f.status;
  const due = new Date(f.due_at);
  if (Number.isNaN(due.getTime())) return 'upcoming';
  if (due.toDateString() === now.toDateString()) return 'today';
  return due.getTime() < now.getTime() ? 'overdue' : 'upcoming';
}

export function nextPendingFollowUp(followups: QuoteFollowUp[]): QuoteFollowUp | null {
  return followups.filter((f) => f.status === 'pending').sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at))[0] ?? null;
}

// ============================================================
// TIMELINE
// ============================================================

export type TimelineKind =
  | 'created' | 'version' | 'sent' | 'viewed' | 'option_selected'
  | 'accepted' | 'declined' | 'followup' | 'job';

export interface TimelineItem {
  id: string;
  at: string;
  kind: TimelineKind;
  title: string;
  detail: string | null;
}

export function optionName(options: SnapshotOption[], id: string | null): string | null {
  if (!id) return null;
  return options.find((o) => o.id === id)?.name || null;
}

const CHANNEL_LABEL: Record<FollowUpChannel, string> = { call: 'Call', sms: 'Text', email: 'Email', visit: 'Visit' };
export const followUpChannelLabel = (c: FollowUpChannel) => CHANNEL_LABEL[c];

export function buildTimeline(ws: QuoteWorkspace): TimelineItem[] {
  const { quote, versions, events, followups, job } = ws;
  const items: TimelineItem[] = [];

  items.push({ id: 'created', at: quote.created_at, kind: 'created', title: 'Quote created', detail: null });

  for (const v of versions) {
    if (v.version_number > 1) {
      items.push({
        id: `v:${v.id}`, at: v.created_at, kind: 'version',
        title: `Version ${v.version_number} saved`, detail: formatUsd(v.total_cents),
      });
    }
  }

  if (quote.sent_at) {
    items.push({ id: 'sent', at: quote.sent_at, kind: 'sent', title: 'Sent to customer', detail: null });
  }

  for (const e of events) {
    if (e.event_type === 'viewed') {
      items.push({
        id: `e:${e.id}`, at: e.created_at, kind: 'viewed',
        title: e.metadata.first_view === true ? 'Customer opened the estimate' : 'Customer opened it again',
        detail: null,
      });
    } else if (e.event_type === 'option_selected') {
      items.push({
        id: `e:${e.id}`, at: e.created_at, kind: 'option_selected',
        title: 'Customer looked at an option', detail: optionName(quote.options, e.option_id),
      });
    } else {
      const total = e.metadata.total_cents == null ? null : num(e.metadata.total_cents, NaN);
      const opt = optionName(quote.options, e.option_id);
      const detail = [opt, total !== null && Number.isFinite(total) ? formatUsd(total) : null].filter(Boolean).join(' \u00b7 ');
      items.push({
        id: `e:${e.id}`, at: e.created_at, kind: e.event_type,
        title: e.event_type === 'accepted' ? 'Customer accepted' : 'Customer declined',
        detail: detail || null,
      });
    }
  }

  // Quotes answered before the event trail existed still deserve their answer on the timeline.
  const hasAnswerEvent = events.some((e) => e.event_type === 'accepted' || e.event_type === 'declined');
  if (!hasAnswerEvent && quote.responded_at && (quote.status === 'accepted' || quote.status === 'declined')) {
    items.push({
      id: 'responded', at: quote.responded_at, kind: quote.status,
      title: quote.status === 'accepted' ? 'Customer accepted' : 'Customer declined', detail: null,
    });
  }

  for (const f of followups) {
    if ((f.status === 'done' || f.status === 'skipped') && f.completed_at) {
      items.push({
        id: `f:${f.id}`, at: f.completed_at, kind: 'followup',
        title: `${CHANNEL_LABEL[f.channel]} follow-up ${f.status === 'done' ? 'done' : 'skipped'}`,
        detail: f.outcome,
      });
    }
  }

  if (job) {
    items.push({ id: `j:${job.id}`, at: job.created_at, kind: 'job', title: 'Converted to a job', detail: null });
  }

  return items
    .filter((i) => Number.isFinite(Date.parse(i.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
}

// ============================================================
// STATE HELPERS
// ============================================================

export function canConvertToJob(quote: Pick<WorkspaceQuote, 'status'>, job: WorkspaceJob | null): boolean {
  return quote.status === 'accepted' && job === null;
}

export function canSchedulePlan(quote: Pick<WorkspaceQuote, 'status'>): boolean {
  return quote.status === 'sent';
}

export type ValidityState = 'none' | 'valid' | 'expiring_soon' | 'expired';

export function validityState(validUntil: string | null, now: Date = new Date()): ValidityState {
  if (!validUntil) return 'none';
  const end = Date.parse(`${validUntil}T23:59:59Z`);
  if (!Number.isFinite(end)) return 'none';
  if (end < now.getTime()) return 'expired';
  return end - now.getTime() <= 3 * DAY_MS ? 'expiring_soon' : 'valid';
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
