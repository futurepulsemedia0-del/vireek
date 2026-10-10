/**
 * Job detail (/dashboard/jobs/:id) — domain logic + data access.
 *
 * Everything that decides something (who may see/do what, the status flow, the
 * merged activity feed, cost/margin maths, parts roll-ups, photo validation) is
 * a PURE function so it is unit-tested in jobDetail.test.ts. The fetchers below
 * are thin: every query is scoped by the account owner's id (`user_id` /
 * `account_owner_id`) on top of RLS — a team member's own auth id is NOT the
 * id the business data is keyed by.
 */

import { supabase } from '@/lib/supabase';
import type { Job } from '@/lib/supabase';
import { fetchAggregateHistory, activityEventLabel } from '@/lib/activityLedger';
import type { ActivityEvent } from '@/lib/activityLedger';
import { calculateQuoteTotals } from '@/lib/invoices';
import type { Invoice } from '@/lib/invoices';
import type { JobCostEntry, CostCategory } from '@/lib/jobCosting';
import { addJobRoomPhoto, uploadJobRoomPhoto } from '@/lib/jobRoom';
import { logActivityEvent } from '@/lib/activityLedger';

// ============================================================
// ACCESS (permission gate)
// ============================================================

export interface JobAccessInput {
  isOwner: boolean;
  permissions: { can_view_all_jobs: boolean; can_view_billing: boolean };
  /** The signed-in team member's id (null for the owner). */
  teamMemberId: string | null;
  job: Pick<Job, 'assigned_technician_id'>;
}

export interface JobAccess {
  /** May open this job at all. */
  canView: boolean;
  /** May advance status, add notes and photos. */
  canEdit: boolean;
  /** May cancel / mark no-show (dispatcher-level). */
  canManage: boolean;
  /** May see costs, margin and invoices. */
  canSeeBilling: boolean;
}

/**
 * Mirrors the Jobs board rule: owners and anyone with `can_view_all_jobs` see
 * every job; other technicians only see jobs assigned to them. Billing data is
 * additionally gated by `can_view_billing`. (RLS scopes rows to the account but
 * does not enforce these per-member rules — the app layer must.)
 */
export function resolveJobAccess(input: JobAccessInput): JobAccess {
  const { isOwner, permissions, teamMemberId, job } = input;
  const seesAll = isOwner || permissions.can_view_all_jobs;
  const assignedToMe = teamMemberId !== null && job.assigned_technician_id === teamMemberId;
  const canView = seesAll || assignedToMe;
  return {
    canView,
    canEdit: canView,
    canManage: seesAll,
    canSeeBilling: canView && (isOwner || permissions.can_view_billing),
  };
}

// ============================================================
// STATUS FLOW
// ============================================================

export type JobStatus = Job['job_status'];

export const STATUS_LABELS: Record<JobStatus, string> = {
  scheduled: 'Scheduled',
  en_route: 'En route',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

export const STATUS_BADGE: Record<JobStatus, string> = {
  scheduled: 'bg-accent/10 text-accent',
  en_route: 'bg-blue-500/10 text-blue-500',
  in_progress: 'bg-warning-500/10 text-warning-500',
  completed: 'bg-success-500/10 text-success-500',
  cancelled: 'bg-danger/10 text-danger',
  no_show: 'bg-warning-500/10 text-warning-500',
};

export const STATUS_FLOW: JobStatus[] = ['scheduled', 'en_route', 'in_progress', 'completed'];

export function nextStatus(status: JobStatus): JobStatus | null {
  const i = STATUS_FLOW.indexOf(status);
  return i >= 0 && i < STATUS_FLOW.length - 1 ? STATUS_FLOW[i + 1] : null;
}

export type StepState = 'done' | 'current' | 'upcoming';

export interface StatusStep {
  key: JobStatus;
  label: string;
  state: StepState;
  /** Best-known moment this step happened (null when the schema doesn't record it). */
  at: string | null;
}

export interface StatusTimeline {
  steps: StatusStep[];
  /** Set when the job ended outside the happy path. */
  terminal: JobStatus | null;
}

/**
 * The jobs table stores the current status plus a few milestone timestamps, not
 * a full status history — so only moments the schema actually records are
 * shown (created, ETA set, completed); the rest stay null instead of invented.
 */
export function buildStatusTimeline(
  job: Pick<Job, 'job_status' | 'created_at' | 'eta_set_at' | 'completed_at'>,
): StatusTimeline {
  const terminal = job.job_status === 'cancelled' || job.job_status === 'no_show' ? job.job_status : null;
  const currentIndex = STATUS_FLOW.indexOf(job.job_status);

  const steps = STATUS_FLOW.map<StatusStep>((key, i) => {
    let state: StepState = 'upcoming';
    if (!terminal) state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming';
    else if (key === 'scheduled') state = 'done';

    // A completed job is "done" at its last step too, not "current".
    if (!terminal && job.job_status === 'completed' && key === 'completed') state = 'done';

    let at: string | null = null;
    if (key === 'scheduled') at = job.created_at;
    if (key === 'en_route' && !terminal && currentIndex >= 1) at = job.eta_set_at;
    if (key === 'completed' && !terminal && job.job_status === 'completed') at = job.completed_at;
    return { key, label: STATUS_LABELS[key], state, at };
  });

  return { steps, terminal };
}

// ============================================================
// ACTIVITY FEED (ledger events + facts stored on the job / invoice)
// ============================================================

export type FeedKind =
  | 'created'
  | 'completed'
  | 'rescheduled'
  | 'eta'
  | 'signed'
  | 'invoice_sent'
  | 'invoice_viewed'
  | 'invoice_paid'
  | 'note'
  | 'other';

export interface FeedItem {
  id: string;
  at: string;
  kind: FeedKind;
  title: string;
  detail: string | null;
  actor: string | null;
}

export const NOTE_EVENT_TYPE = 'job.note';
export const NOTE_MAX_LENGTH = 1000;

type FeedJob = Pick<
  Job,
  | 'created_at'
  | 'completed_at'
  | 'rescheduled_by_customer_at'
  | 'eta_set_at'
  | 'eta_minutes'
  | 'customer_signature_at'
  | 'customer_signature_name'
>;

// invoice_number is assigned by a DB trigger and can still be null on a fresh draft.
type FeedInvoice = Pick<Invoice, 'id' | 'sent_at' | 'viewed_at' | 'paid_at' | 'payment_method'> & {
  invoice_number: string | null;
};

function validTime(value: string | null | undefined): value is string {
  return !!value && !Number.isNaN(new Date(value).getTime());
}

function noteText(event: ActivityEvent): string {
  const t = event.event_data?.text;
  return typeof t === 'string' ? t : '';
}

/**
 * Merges the append-only ledger with facts stored on the job and its invoices.
 * Ledger events win: a `job.created` / `job.completed` row suppresses the
 * equivalent derived entry so nothing shows twice. Newest first; stable for
 * identical timestamps; duplicate ids (e.g. a realtime event also returned by
 * a refetch) collapse to one.
 */
export function buildActivityFeed(input: {
  job: FeedJob;
  invoices: FeedInvoice[];
  events: ActivityEvent[];
}): FeedItem[] {
  const { job, invoices, events } = input;
  const items = new Map<string, FeedItem>();
  const put = (item: FeedItem) => {
    if (validTime(item.at) && !items.has(item.id)) items.set(item.id, item);
  };

  const hasCreated = events.some((e) => e.event_type === 'job.created');
  const hasCompleted = events.some((e) => e.event_type === 'job.completed');

  for (const e of events) {
    if (e.event_type === NOTE_EVENT_TYPE) {
      const text = noteText(e).trim();
      if (!text) continue;
      const author = e.event_data?.author;
      put({
        id: `ev:${e.id}`,
        at: e.occurred_at,
        kind: 'note',
        title: 'Note added',
        detail: text,
        actor: typeof author === 'string' && author.trim() ? author.trim() : null,
      });
      continue;
    }
    const kind: FeedKind = e.event_type === 'job.created' ? 'created' : e.event_type === 'job.completed' ? 'completed' : 'other';
    put({
      id: `ev:${e.id}`,
      at: e.occurred_at,
      kind,
      title: activityEventLabel(e.event_type),
      detail: null,
      actor: e.actor_type === 'system' ? 'System' : e.actor_type === 'customer' ? 'Customer' : e.actor_type === 'ai' ? 'AI' : null,
    });
  }

  if (!hasCreated) put({ id: 'job:created', at: job.created_at, kind: 'created', title: 'Job created', detail: null, actor: null });
  if (!hasCompleted && job.completed_at)
    put({ id: 'job:completed', at: job.completed_at, kind: 'completed', title: 'Job completed', detail: null, actor: null });
  if (job.rescheduled_by_customer_at)
    put({ id: 'job:rescheduled', at: job.rescheduled_by_customer_at, kind: 'rescheduled', title: 'Customer rescheduled', detail: null, actor: 'Customer' });
  if (job.eta_set_at)
    put({
      id: 'job:eta',
      at: job.eta_set_at,
      kind: 'eta',
      title: 'ETA shared',
      detail: job.eta_minutes !== null ? `Arriving in about ${job.eta_minutes} min` : null,
      actor: null,
    });
  if (job.customer_signature_at)
    put({
      id: 'job:signed',
      at: job.customer_signature_at,
      kind: 'signed',
      title: 'Customer signed off',
      detail: job.customer_signature_name,
      actor: 'Customer',
    });

  for (const inv of invoices) {
    const ref = inv.invoice_number ?? 'Invoice';
    if (inv.sent_at) put({ id: `inv:${inv.id}:sent`, at: inv.sent_at, kind: 'invoice_sent', title: `${ref} sent`, detail: null, actor: null });
    if (inv.viewed_at) put({ id: `inv:${inv.id}:viewed`, at: inv.viewed_at, kind: 'invoice_viewed', title: `${ref} viewed by customer`, detail: null, actor: 'Customer' });
    if (inv.paid_at)
      put({
        id: `inv:${inv.id}:paid`,
        at: inv.paid_at,
        kind: 'invoice_paid',
        title: `${ref} paid`,
        detail: inv.payment_method ? `via ${inv.payment_method}` : null,
        actor: null,
      });
  }

  return [...items.values()].sort((a, b) => {
    const d = new Date(b.at).getTime() - new Date(a.at).getTime();
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
}

/** Returns an error message, or null when the note is OK to save. */
export function validateNote(text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return 'Write a note first.';
  if (t.length > NOTE_MAX_LENGTH) return `Notes are limited to ${NOTE_MAX_LENGTH} characters.`;
  return null;
}

// ============================================================
// COSTS
// ============================================================

export interface CostBreakdownRow {
  category: CostCategory;
  totalCents: number;
  count: number;
  /** Share of total cost, 0-1 (0 when there is no cost). */
  share: number;
}

export interface CostSummary {
  rows: CostBreakdownRow[];
  totalCostCents: number;
  revenueCents: number;
  grossProfitCents: number;
  /** Percent (e.g. 32.5); null when there is no revenue to measure against. */
  marginPct: number | null;
}

const safeCents = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0);

/**
 * Revenue = the live (non-void) invoice total when one exists — it is what the
 * customer is actually billed — otherwise the quick `invoice_amount` on the job
 * (dollars). Multiple live invoices are summed.
 */
export function jobRevenueCents(
  job: Pick<Job, 'invoice_amount'>,
  invoices: Pick<Invoice, 'status' | 'line_items' | 'tax_percent'>[],
): number {
  const live = invoices.filter((i) => i.status !== 'void');
  if (live.length > 0) {
    return live.reduce((s, i) => s + calculateQuoteTotals(i.line_items ?? [], Number(i.tax_percent) || 0).totalCents, 0);
  }
  return typeof job.invoice_amount === 'number' && Number.isFinite(job.invoice_amount) && job.invoice_amount > 0
    ? Math.round(job.invoice_amount * 100)
    : 0;
}

export function summarizeCosts(entries: Pick<JobCostEntry, 'category' | 'total_cost_cents'>[], revenueCents: number): CostSummary {
  const byCategory = new Map<CostCategory, { totalCents: number; count: number }>();
  for (const e of entries) {
    const cur = byCategory.get(e.category) ?? { totalCents: 0, count: 0 };
    byCategory.set(e.category, { totalCents: cur.totalCents + safeCents(e.total_cost_cents), count: cur.count + 1 });
  }
  const totalCostCents = [...byCategory.values()].reduce((s, r) => s + r.totalCents, 0);
  const rows = [...byCategory.entries()]
    .map(([category, r]) => ({ category, ...r, share: totalCostCents > 0 ? r.totalCents / totalCostCents : 0 }))
    .sort((a, b) => b.totalCents - a.totalCents);
  const revenue = safeCents(revenueCents);
  const grossProfitCents = revenue - totalCostCents;
  return {
    rows,
    totalCostCents,
    revenueCents: revenue,
    grossProfitCents,
    marginPct: revenue > 0 ? (grossProfitCents / revenue) * 100 : null,
  };
}

export function invoiceTotals(inv: Pick<Invoice, 'line_items' | 'tax_percent'>) {
  return calculateQuoteTotals(inv.line_items ?? [], Number(inv.tax_percent) || 0);
}

/** The invoice to feature: newest live one, else newest overall. Input order is irrelevant. */
export function primaryInvoice<T extends Pick<Invoice, 'status' | 'created_at'>>(invoices: T[]): T | null {
  const byNewest = [...invoices].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return byNewest.find((i) => i.status !== 'void') ?? byNewest[0] ?? null;
}

// ============================================================
// PARTS
// ============================================================

export type PartReadiness = 'ready' | 'short' | 'no_location';

export interface RequiredPartRow {
  requirement_id: string;
  part_id: string;
  part_name: string;
  quantity_required: number;
  status: 'needed' | 'allocated' | 'installed' | 'backordered';
  readiness_status: PartReadiness;
  source_location_name: string | null;
  shortage_quantity: number;
}

export interface UsedPartRow {
  id: string;
  part_id: string;
  part_name: string;
  part_number: string | null;
  transaction_type: 'usage' | 'return';
  quantity_delta: number;
  unit_cost_cents: number | null;
  location_name: string | null;
  created_at: string;
}

export interface PartsSummary {
  total: number;
  installed: number;
  backordered: number;
  /** Parts not yet installed that can't be covered from the technician's van / warehouse. */
  atRisk: number;
}

export function summarizeRequiredParts(rows: RequiredPartRow[]): PartsSummary {
  const open = rows.filter((r) => r.status !== 'installed');
  return {
    total: rows.length,
    installed: rows.length - open.length,
    backordered: rows.filter((r) => r.status === 'backordered').length,
    atRisk: open.filter((r) => r.status === 'backordered' || r.readiness_status !== 'ready').length,
  };
}

export interface UsedPartSummary {
  part_id: string;
  part_name: string;
  part_number: string | null;
  /** Net units consumed (usage minus returns). */
  quantity: number;
  /** Net cost in cents using each transaction's recorded unit cost (0 when unknown). */
  costCents: number;
}

/** Usage transactions carry negative deltas and returns positive — net them per part. */
export function summarizeUsedParts(rows: UsedPartRow[]): UsedPartSummary[] {
  const byPart = new Map<string, UsedPartSummary>();
  for (const r of rows) {
    const cur = byPart.get(r.part_id) ?? {
      part_id: r.part_id,
      part_name: r.part_name,
      part_number: r.part_number,
      quantity: 0,
      costCents: 0,
    };
    cur.quantity += -r.quantity_delta;
    cur.costCents += -r.quantity_delta * (r.unit_cost_cents ?? 0);
    byPart.set(r.part_id, cur);
  }
  return [...byPart.values()].filter((p) => p.quantity !== 0).sort((a, b) => a.part_name.localeCompare(b.part_name));
}

// ============================================================
// PHOTOS
// ============================================================

export const PHOTO_MAX_BYTES = 10 * 1024 * 1024; // matches the job-room-photos bucket limit
export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

export function validatePhotoFile(file: { type: string; size: number }): string | null {
  if (!PHOTO_MIME_TYPES.includes(file.type)) return 'Use a JPG, PNG, WebP or HEIC image.';
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > PHOTO_MAX_BYTES) return 'Photos must be 10 MB or smaller.';
  return null;
}

/** Stored values are bucket paths; tolerate absolute URLs too. */
export function resolvePhotoUrl(value: string, publicUrlFor: (path: string) => string): string {
  return /^https?:\/\//i.test(value) ? value : publicUrlFor(value);
}

export function jobPhotoUrl(value: string): string {
  return resolvePhotoUrl(value, (path) => supabase.storage.from('job-room-photos').getPublicUrl(path).data.publicUrl);
}

// ============================================================
// SMALL FORMATTERS
// ============================================================

export function formatWhen(value: string | null | undefined): string {
  if (!value || Number.isNaN(new Date(value).getTime())) return '—';
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function relativeTime(value: string, now: Date = new Date()): string {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return '';
  const sec = Math.round((now.getTime() - t) / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.round(hr / 24);
  return day < 8 ? `${day} d ago` : formatWhen(value);
}

/** Google Maps search link for an address (no API key needed). */
export function mapsLink(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

/** Digits and a leading + only, for tel: links. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

// ============================================================
// DATA ACCESS — every query is scoped to the account owner
// ============================================================

export interface JobTechnician {
  id: string;
  member_name: string | null;
  member_email: string;
  member_phone: string | null;
  skills: string[];
}

export async function fetchJob(jobId: string, ownerId: string): Promise<Job | null> {
  const { data, error } = await supabase.from('jobs').select('*').eq('id', jobId).eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return (data as Job | null) ?? null;
}

export async function fetchJobTechnician(technicianId: string, ownerId: string): Promise<JobTechnician | null> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, member_name, member_email, member_phone, skills')
    .eq('id', technicianId)
    .eq('account_owner_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  return (data as JobTechnician | null) ?? null;
}

export async function fetchJobRequiredParts(jobId: string, ownerId: string): Promise<RequiredPartRow[]> {
  const { data, error } = await supabase
    .from('job_parts_readiness')
    .select('requirement_id, part_id, part_name, quantity_required, status, readiness_status, source_location_name, shortage_quantity')
    .eq('job_id', jobId)
    .eq('user_id', ownerId)
    .order('part_name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as RequiredPartRow[];
}

interface UsedPartQueryRow {
  id: string;
  part_id: string;
  transaction_type: 'usage' | 'return';
  quantity_delta: number;
  unit_cost_cents: number | null;
  created_at: string;
  inventory_parts: { name: string; part_number: string | null } | null;
  inventory_locations: { name: string } | null;
}

export async function fetchJobUsedParts(jobId: string, ownerId: string): Promise<UsedPartRow[]> {
  const { data, error } = await supabase
    .from('inventory_transactions')
    .select(
      'id, part_id, transaction_type, quantity_delta, unit_cost_cents, created_at, inventory_parts(name, part_number), inventory_locations(name)',
    )
    .eq('job_id', jobId)
    .eq('user_id', ownerId)
    .in('transaction_type', ['usage', 'return'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as UsedPartQueryRow[]).map((r) => ({
    id: r.id,
    part_id: r.part_id,
    part_name: r.inventory_parts?.name ?? 'Unknown part',
    part_number: r.inventory_parts?.part_number ?? null,
    transaction_type: r.transaction_type,
    quantity_delta: r.quantity_delta,
    unit_cost_cents: r.unit_cost_cents,
    location_name: r.inventory_locations?.name ?? null,
    created_at: r.created_at,
  }));
}

export async function fetchJobCostEntries(jobId: string, ownerId: string): Promise<JobCostEntry[]> {
  const { data, error } = await supabase
    .from('job_cost_entries')
    .select('*')
    .eq('job_id', jobId)
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as JobCostEntry[];
}

export async function fetchJobInvoices(jobId: string, ownerId: string): Promise<Invoice[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('job_id', jobId)
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Invoice[];
}

/** Ledger history for this job (the RPC itself resolves the caller's account). */
export async function fetchJobEvents(jobId: string): Promise<ActivityEvent[]> {
  return fetchAggregateHistory('job', jobId);
}

export interface JobStatusResult {
  ok: boolean;
  /** Present when the database blocked the change (quality gate / evidence chain). */
  blockedBy?: string[];
  error?: string;
}

export async function updateJobStatusScoped(
  jobId: string,
  ownerId: string,
  status: JobStatus,
  parseBlockers: (message: string) => string[] | null,
): Promise<JobStatusResult> {
  const { error } = await supabase.from('jobs').update({ job_status: status }).eq('id', jobId).eq('user_id', ownerId);
  if (!error) return { ok: true };
  const blockers = parseBlockers(error.message ?? '');
  if (blockers && blockers.length > 0) return { ok: false, blockedBy: blockers };
  return { ok: false, error: error.message };
}

export interface JobNotesPatch {
  dispatch_note?: string | null;
  diagnosis_notes?: string | null;
  work_performed_notes?: string | null;
}

export async function saveJobNotes(jobId: string, ownerId: string, patch: JobNotesPatch): Promise<void> {
  const clean: JobNotesPatch = {};
  for (const [k, v] of Object.entries(patch) as [keyof JobNotesPatch, string | null | undefined][]) {
    if (v === undefined) continue;
    clean[k] = v === null || v.trim() === '' ? null : v.trim();
  }
  const { error } = await supabase.from('jobs').update(clean).eq('id', jobId).eq('user_id', ownerId);
  if (error) throw error;
}

export async function addJobNote(jobId: string, text: string, author: string | null): Promise<void> {
  const err = validateNote(text);
  if (err) throw new Error(err);
  await logActivityEvent({
    aggregateType: 'job',
    aggregateId: jobId,
    eventType: NOTE_EVENT_TYPE,
    eventData: { text: text.trim(), author },
  });
}

/**
 * Uploads to the signed-in user's OWN storage folder (the bucket policy keys on
 * auth.uid(), which for a team member differs from the account owner's id),
 * then appends the path to the job's before/after list.
 */
export async function attachJobPhoto(args: {
  authUserId: string;
  job: Pick<Job, 'id' | 'before_photos' | 'after_photos'>;
  slot: 'before' | 'after';
  file: File;
}): Promise<void> {
  const invalid = validatePhotoFile(args.file);
  if (invalid) throw new Error(invalid);
  const path = await uploadJobRoomPhoto(args.authUserId, args.file);
  const current = args.slot === 'before' ? args.job.before_photos : args.job.after_photos;
  const ok = await addJobRoomPhoto(args.job.id, args.slot, current ?? [], path);
  if (!ok) throw new Error('Could not attach the photo to this job.');
}
