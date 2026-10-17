/**
 * Stripe Disputes — pure domain helpers (no I/O). UI + tests import from here.
 * Data lives in stripe_disputes / stripe_dispute_evidence_files (see migration 20270510000000).
 */

export type DisputeTone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning';

export interface StripeDisputeRow {
  id: string;
  user_id: string;
  stripe_dispute_id: string;
  stripe_charge_id: string | null;
  payment_request_id: string | null;
  job_id: string | null;
  customer_name: string | null;
  amount_cents: number;
  currency: string;
  reason: string | null;
  network_reason_code: string | null;
  status: string;
  is_charge_refundable: boolean | null;
  evidence_due_by: string | null;
  has_evidence: boolean;
  past_due: boolean;
  submission_count: number;
  evidence_submitted_at: string | null;
  net_balance_cents: number;
  opened_at: string;
  closed_at: string | null;
  evidence_draft: Record<string, string>;
  last_event_type: string | null;
  updated_at: string;
}

export interface DisputeEvidenceFile {
  id: string;
  dispute_id: string;
  category: EvidenceCategory;
  file_name: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  stripe_file_id: string | null;
  created_at: string;
}

export interface DisputeEventRow {
  stripe_event_id: string;
  event_type: string;
  event_created: number;
  status_after: string | null;
}

export interface DisputeReasonStat { reason: string; total: number; won: number; lost: number; win_rate: number | null }
export interface DisputeMonthStat { month: string; opened: number; won: number; lost: number }
export interface DisputeStats {
  window_days: number;
  total: number;
  needs_response: number;
  under_review: number;
  won: number;
  lost: number;
  lost_unanswered: number;
  win_rate: number | null;
  at_stake_cents: number;
  won_cents: number;
  lost_cents: number;
  due_soon: number;
  overdue: number;
  paid_payments: number;
  dispute_rate_pct: number | null;
  by_reason: DisputeReasonStat[];
  monthly: DisputeMonthStat[];
}

// ---------------------------------------------------------------- status

const NEEDS_RESPONSE = ['needs_response', 'warning_needs_response'];
const IN_REVIEW = ['under_review', 'warning_under_review'];

export const isNeedsResponse = (status: string) => NEEDS_RESPONSE.includes(status);
export const isInReview = (status: string) => IN_REVIEW.includes(status);

export const STATUS_META: Record<string, { label: string; tone: DisputeTone }> = {
  needs_response: { label: 'Needs response', tone: 'danger' },
  warning_needs_response: { label: 'Inquiry — needs response', tone: 'warning' },
  under_review: { label: 'Under review', tone: 'accent' },
  warning_under_review: { label: 'Inquiry — under review', tone: 'accent' },
  warning_closed: { label: 'Inquiry closed', tone: 'neutral' },
  won: { label: 'Won', tone: 'success' },
  lost: { label: 'Lost', tone: 'danger' },
};

/** Unknown future Stripe statuses degrade gracefully instead of crashing the page. */
export function statusMeta(status: string): { label: string; tone: DisputeTone } {
  return STATUS_META[status] ?? { label: status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), tone: 'neutral' };
}

// ---------------------------------------------------------------- reasons & evidence

export type EvidenceCategory =
  | 'receipt' | 'customer_communication' | 'service_documentation' | 'customer_signature'
  | 'cancellation_policy' | 'refund_policy' | 'duplicate_charge_documentation' | 'uncategorized_file';

export type EvidenceTextField =
  | 'product_description' | 'customer_name' | 'customer_email_address' | 'billing_address' | 'service_date'
  | 'uncategorized_text' | 'cancellation_rebuttal' | 'refund_refusal_explanation' | 'duplicate_charge_explanation' | 'access_activity_log';

export const EVIDENCE_CATEGORIES: { key: EvidenceCategory; label: string; help: string }[] = [
  { key: 'service_documentation', label: 'Proof of service', help: 'Signed work order, before/after photos, technician timesheet.' },
  { key: 'customer_signature', label: 'Customer signature', help: 'Signed estimate, approval or completion sign-off.' },
  { key: 'customer_communication', label: 'Customer communication', help: 'Texts, emails or call notes showing the customer agreed to the work.' },
  { key: 'receipt', label: 'Invoice / receipt', help: 'The invoice or receipt the customer received.' },
  { key: 'cancellation_policy', label: 'Cancellation policy', help: 'The policy the customer accepted.' },
  { key: 'refund_policy', label: 'Refund policy', help: 'The refund terms the customer accepted.' },
  { key: 'duplicate_charge_documentation', label: 'Duplicate-charge proof', help: 'Documents showing the charges were for separate services.' },
  { key: 'uncategorized_file', label: 'Other supporting file', help: 'Anything else that supports your case.' },
];

export const EVIDENCE_TEXT_FIELDS: { key: EvidenceTextField; label: string; multiline: boolean; placeholder?: string }[] = [
  { key: 'product_description', label: 'Description of the service', multiline: true, placeholder: 'What was done, where, by whom, and when.' },
  { key: 'service_date', label: 'Service date', multiline: false, placeholder: 'YYYY-MM-DD' },
  { key: 'customer_name', label: 'Customer name', multiline: false },
  { key: 'customer_email_address', label: 'Customer email', multiline: false },
  { key: 'billing_address', label: 'Billing address', multiline: false },
  { key: 'uncategorized_text', label: 'Additional explanation', multiline: true, placeholder: 'Anything the bank should know — timeline, communication, customer acknowledgement.' },
  { key: 'cancellation_rebuttal', label: 'Why the cancellation does not apply', multiline: true },
  { key: 'refund_refusal_explanation', label: 'Why a refund was not owed', multiline: true },
  { key: 'duplicate_charge_explanation', label: 'Why this is not a duplicate', multiline: true },
  { key: 'access_activity_log', label: 'Access / activity log', multiline: true },
];

export const TEXT_FIELD_MAX = 20000;
export const TEXT_TOTAL_MAX = 150000;
export const FILE_TOTAL_MAX_BYTES = 4_500_000;
export const FILE_COUNT_MAX = 20;
export const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];

interface ReasonMeta { label: string; hint: string; files: EvidenceCategory[]; texts: EvidenceTextField[] }

const GENERAL: ReasonMeta = {
  label: 'General', hint: 'The bank gave no specific reason. Show the service was agreed, delivered and billed correctly.',
  files: ['receipt', 'service_documentation', 'customer_communication'], texts: ['product_description', 'service_date'],
};

export const REASON_META: Record<string, ReasonMeta> = {
  fraudulent: { label: 'Fraudulent', hint: 'The cardholder says they did not authorize this. Prove the customer requested and received the work.', files: ['customer_signature', 'service_documentation', 'customer_communication', 'receipt'], texts: ['product_description', 'service_date', 'customer_name'] },
  unrecognized: { label: 'Unrecognized', hint: 'The customer does not recognise the charge. Show who you are and what was done.', files: ['receipt', 'service_documentation', 'customer_communication'], texts: ['product_description', 'service_date', 'customer_name'] },
  product_not_received: { label: 'Service not received', hint: 'The customer claims the work was not done. Proof of completion is decisive.', files: ['service_documentation', 'customer_signature', 'customer_communication'], texts: ['product_description', 'service_date'] },
  product_unacceptable: { label: 'Service not as described', hint: 'The customer says the work was unsatisfactory. Show the agreed scope and what you delivered.', files: ['service_documentation', 'customer_communication', 'refund_policy'], texts: ['product_description', 'uncategorized_text'] },
  duplicate: { label: 'Duplicate charge', hint: 'The customer says they were charged twice. Show the charges cover separate work.', files: ['duplicate_charge_documentation', 'receipt'], texts: ['duplicate_charge_explanation'] },
  credit_not_processed: { label: 'Credit not processed', hint: 'The customer says a promised refund never arrived.', files: ['refund_policy', 'customer_communication'], texts: ['refund_refusal_explanation'] },
  subscription_canceled: { label: 'Subscription canceled', hint: 'The customer says they canceled a recurring service (e.g. a maintenance plan).', files: ['cancellation_policy', 'customer_communication'], texts: ['cancellation_rebuttal'] },
  general: GENERAL,
  customer_initiated: GENERAL,
  debit_not_authorized: { ...GENERAL, label: 'Debit not authorized' },
  bank_cannot_process: { ...GENERAL, label: 'Bank cannot process' },
  check_returned: { ...GENERAL, label: 'Check returned' },
  incorrect_account_details: { ...GENERAL, label: 'Incorrect account details' },
  insufficient_funds: { ...GENERAL, label: 'Insufficient funds' },
};

export function reasonMeta(reason: string | null): ReasonMeta & { key: string } {
  const key = reason ?? 'general';
  const meta = REASON_META[key];
  if (meta) return { ...meta, key };
  return { ...GENERAL, key, label: key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) };
}

/** How complete the evidence is relative to what usually wins this dispute reason. Guidance only — never a guarantee. */
export function evidenceReadiness(
  reason: string | null,
  draft: Record<string, string>,
  files: Pick<DisputeEvidenceFile, 'category'>[],
): { pct: number; missingFiles: EvidenceCategory[]; missingTexts: EvidenceTextField[] } {
  const meta = reasonMeta(reason);
  const have = new Set(files.map((f) => f.category));
  const missingFiles = meta.files.filter((c) => !have.has(c));
  const missingTexts = meta.texts.filter((t) => !(draft[t] ?? '').trim());
  const total = meta.files.length + meta.texts.length;
  const done = total - missingFiles.length - missingTexts.length;
  return { pct: total === 0 ? 100 : Math.round((done / total) * 100), missingFiles, missingTexts };
}

export function validateDraft(draft: Record<string, string>): string | null {
  let total = 0;
  for (const [key, value] of Object.entries(draft)) {
    if (value.length > TEXT_FIELD_MAX) return `"${EVIDENCE_TEXT_FIELDS.find((f) => f.key === key)?.label ?? key}" is longer than ${TEXT_FIELD_MAX.toLocaleString()} characters.`;
    total += value.length;
  }
  return total > TEXT_TOTAL_MAX ? `Evidence text is longer than ${TEXT_TOTAL_MAX.toLocaleString()} characters in total.` : null;
}

export function validateEvidenceFile(
  file: { name: string; type: string; size: number },
  existing: Pick<DisputeEvidenceFile, 'size_bytes'>[],
): string | null {
  if (!ALLOWED_MIME.includes(file.type)) return 'Only PDF, JPG or PNG files are accepted by card networks.';
  if (file.size <= 0) return 'This file is empty.';
  if (existing.length >= FILE_COUNT_MAX) return `You can attach at most ${FILE_COUNT_MAX} files.`;
  const used = existing.reduce((s, f) => s + f.size_bytes, 0);
  if (used + file.size > FILE_TOTAL_MAX_BYTES) {
    return `Total evidence files cannot exceed ${formatBytes(FILE_TOTAL_MAX_BYTES)} (${formatBytes(FILE_TOTAL_MAX_BYTES - used)} left). Compress images or merge into one PDF.`;
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Storage object name: unique, filesystem-safe, keeps the extension. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, '_').replace(/_{2,}/g, '_').slice(-80);
  return cleaned || 'file';
}

// ---------------------------------------------------------------- deadline

export type DeadlineKind = 'none' | 'overdue' | 'critical' | 'soon' | 'ok';

export function deadlineState(dueBy: string | null, now: number = Date.now()): { kind: DeadlineKind; label: string; tone: DisputeTone } {
  if (!dueBy) return { kind: 'none', label: 'No deadline', tone: 'neutral' };
  const ms = new Date(dueBy).getTime() - now;
  if (Number.isNaN(ms)) return { kind: 'none', label: 'No deadline', tone: 'neutral' };
  if (ms <= 0) return { kind: 'overdue', label: 'Deadline passed', tone: 'danger' };
  const hours = ms / 3_600_000;
  const label = hours < 1 ? `${Math.max(1, Math.round(ms / 60_000))}m left`
    : hours < 48 ? `${Math.floor(hours)}h left`
    : `${Math.floor(hours / 24)}d left`;
  if (hours <= 24) return { kind: 'critical', label, tone: 'danger' };
  if (hours <= 72) return { kind: 'soon', label, tone: 'warning' };
  return { kind: 'ok', label, tone: 'neutral' };
}

// ---------------------------------------------------------------- list helpers

export type DisputeTab = 'all' | 'action' | 'review' | 'won' | 'lost';

export function matchesTab(status: string, tab: DisputeTab): boolean {
  switch (tab) {
    case 'action': return isNeedsResponse(status);
    case 'review': return isInReview(status);
    case 'won': return status === 'won';
    case 'lost': return status === 'lost';
    default: return true;
  }
}

/** Filter + sort: items needing action first (soonest deadline first), then newest. */
export function filterDisputes(rows: StripeDisputeRow[], tab: DisputeTab, query: string): StripeDisputeRow[] {
  const q = query.trim().toLowerCase();
  return rows
    .filter((r) => matchesTab(r.status, tab))
    .filter((r) => !q || [r.customer_name, r.stripe_dispute_id, r.reason, r.network_reason_code].some((v) => (v ?? '').toLowerCase().includes(q)))
    .sort((a, b) => {
      const an = isNeedsResponse(a.status), bn = isNeedsResponse(b.status);
      if (an !== bn) return an ? -1 : 1;
      if (an && bn) return new Date(a.evidence_due_by ?? '9999-12-31').getTime() - new Date(b.evidence_due_by ?? '9999-12-31').getTime();
      return new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime();
    });
}

export function formatMoney(cents: number, currency = 'usd'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export const formatPct = (value: number | null): string => (value === null || value === undefined ? '—' : `${value}%`);
