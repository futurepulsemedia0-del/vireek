import { supabase } from '@/lib/supabase';

/**
 * Expenses — dashboard client library.
 *
 * Thin wrapper over supabase/migrations/20270415000000_expenses.sql.
 * `expenses` / `expense_allocations` are read-only from the client; every
 * change goes through the RPCs below (validation, workflow, ledger posting
 * and audit log all live in the database). Money is integer cents.
 * Every read is explicitly scoped to the account owner id on top of RLS.
 */

export const EXPENSE_BUCKET = 'expense-receipts';
/** Receipts are mandatory from $75.00 (mirrors save_expense()). */
export const RECEIPT_REQUIRED_CENTS = 7500;
export const MAX_AMOUNT_CENTS = 100_000_000;
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const ALLOWED_RECEIPT_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const;

export type ExpenseStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'reimbursed';
export type PaymentMethod = 'personal_card' | 'cash' | 'company_card' | 'other';
export type ReimbursementMethod = 'cash' | 'check' | 'bank_transfer' | 'payroll' | 'other';
export type ExpenseView = 'mine' | 'review' | 'reimburse' | 'all';

export interface ExpenseCategory {
  id: string;
  name: string;
  gl_account_code: string;
  is_system: boolean;
  active: boolean;
  sort_order: number;
}

export interface ExpenseAllocation {
  job_id: string;
  amount_cents: number;
  job: { customer_name: string | null; service_type: string | null } | null;
}

export interface Expense {
  id: string;
  user_id: string;
  submitted_by: string;
  submitted_by_email: string | null;
  vendor_name: string;
  expense_date: string;
  amount_cents: number;
  tax_cents: number;
  category_id: string;
  payment_method: PaymentMethod;
  is_reimbursable: boolean;
  notes: string | null;
  receipt_path: string | null;
  receipt_mime: string | null;
  receipt_hash: string | null;
  ocr_status: 'none' | 'done' | 'failed';
  ocr_data: Record<string, unknown> | null;
  status: ExpenseStatus;
  submitted_at: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  reimbursed_at: string | null;
  reimbursement_method: string | null;
  reimbursement_reference: string | null;
  created_at: string;
  category: { name: string } | null;
  allocations: ExpenseAllocation[];
}

export interface JobOption {
  id: string;
  customer_name: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  job_status: string;
}

export interface ExpenseSummary {
  pending_count: number;
  pending_cents: number;
  owed_count: number;
  owed_cents: number;
  period_cents: number;
  reimbursed_cents: number;
  by_category: { name: string; cents: number }[];
  by_job: { job_id: string; customer_name: string; cents: number }[];
}

export interface ReceiptExtraction {
  is_receipt: boolean;
  vendor_name: string | null;
  expense_date: string | null;
  total_cents: number | null;
  tax_cents: number | null;
  suggested_category: string | null;
  confidence: number;
  warnings: string[];
}

export interface ExpenseFormState {
  vendor_name: string;
  expense_date: string;
  amount: string;
  tax: string;
  category_id: string;
  payment_method: PaymentMethod;
  is_reimbursable: boolean;
  notes: string;
}

export interface AllocationRow {
  job_id: string;
  amount: string;
}

// ------------------------------------------------------------------
// Pure helpers (unit-tested)
// ------------------------------------------------------------------

export const STATUS_META: Record<ExpenseStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-bg-tertiary text-text-secondary' },
  submitted: { label: 'Awaiting review', className: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' },
  approved: { label: 'Approved', className: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300' },
  rejected: { label: 'Rejected', className: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300' },
  reimbursed: { label: 'Reimbursed', className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' },
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  personal_card: 'Personal card',
  cash: 'Cash',
  company_card: 'Company card',
  other: 'Other',
};

export const REIMBURSEMENT_METHOD_LABELS: Record<ReimbursementMethod, string> = {
  bank_transfer: 'Bank transfer',
  check: 'Check',
  cash: 'Cash',
  payroll: 'With payroll',
  other: 'Other',
};

/** "$1,234.50" → 123450. Returns null for anything that is not a plain amount with at most 2 decimals. */
export function dollarsToCents(input: string): number | null {
  const cleaned = input.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function formatMoney(cents: number | null | undefined): string {
  return `$${((cents ?? 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Local calendar date as YYYY-MM-DD (not UTC — a receipt printed tonight is "today"). */
export function toISODate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isValidISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function monthRange(now: Date = new Date()): { start: string; end: string } {
  return {
    start: toISODate(new Date(now.getFullYear(), now.getMonth(), 1)),
    end: toISODate(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  };
}

export interface ExpenseValidation {
  errors: Partial<Record<'vendor_name' | 'expense_date' | 'amount' | 'tax' | 'category_id' | 'notes' | 'receipt', string>>;
  amountCents: number | null;
  taxCents: number;
}

/** Mirrors the checks in save_expense() so users get field-level errors before a round trip. */
export function validateExpenseForm(
  form: ExpenseFormState,
  opts: { categories: ExpenseCategory[]; submit: boolean; hasReceipt: boolean; today?: Date },
): ExpenseValidation {
  const errors: ExpenseValidation['errors'] = {};
  const today = opts.today ?? new Date();

  const vendor = form.vendor_name.trim();
  if (!vendor) errors.vendor_name = 'Enter the vendor.';
  else if (vendor.length > 120) errors.vendor_name = 'Vendor is limited to 120 characters.';

  const amountCents = dollarsToCents(form.amount);
  if (amountCents === null || amountCents < 1) errors.amount = 'Enter a valid amount, e.g. 42.17.';
  else if (amountCents > MAX_AMOUNT_CENTS) errors.amount = 'That amount is too large.';

  let taxCents = 0;
  if (form.tax.trim()) {
    const t = dollarsToCents(form.tax);
    if (t === null) errors.tax = 'Enter a valid tax amount.';
    else if (amountCents !== null && t > amountCents) errors.tax = 'Tax cannot exceed the total.';
    else taxCents = t;
  }

  if (!isValidISODate(form.expense_date)) errors.expense_date = 'Enter the expense date.';
  else {
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (form.expense_date > toISODate(tomorrow)) errors.expense_date = 'The date cannot be in the future.';
  }

  if (!opts.categories.some((c) => c.id === form.category_id && c.active)) errors.category_id = 'Choose a category.';
  if (form.notes.length > 2000) errors.notes = 'Notes are limited to 2000 characters.';

  if (opts.submit && amountCents !== null && amountCents >= RECEIPT_REQUIRED_CENTS && !opts.hasReceipt) {
    errors.receipt = `A receipt is required for expenses of ${formatMoney(RECEIPT_REQUIRED_CENTS)} or more.`;
  }

  return { errors, amountCents, taxCents };
}

/** Splits a total into n parts that always sum exactly to the total (extra cents go to the first parts). */
export function splitEvenly(totalCents: number, parts: number): number[] {
  if (parts <= 0 || totalCents <= 0) return [];
  const base = Math.floor(totalCents / parts);
  const remainder = totalCents - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

export interface AllocationCheck {
  ok: boolean;
  message: string | null;
  allocatedCents: number;
  remainingCents: number;
  parsed: { job_id: string; amount_cents: number }[];
}

/** No rows = overhead (not tied to a job). Otherwise every row needs a job + amount and the rows must equal the total. */
export function checkAllocations(totalCents: number | null, rows: AllocationRow[]): AllocationCheck {
  const parsed: AllocationCheck['parsed'] = [];
  let allocated = 0;
  let message: string | null = null;
  const seen = new Set<string>();

  for (const row of rows) {
    const cents = dollarsToCents(row.amount);
    if (!row.job_id) message ??= 'Choose a job for every allocation line.';
    else if (seen.has(row.job_id)) message ??= 'Each job can only appear once.';
    else if (cents === null || cents < 1) message ??= 'Enter a positive amount for every allocation line.';
    if (row.job_id) seen.add(row.job_id);
    if (row.job_id && cents !== null && cents > 0) {
      parsed.push({ job_id: row.job_id, amount_cents: cents });
      allocated += cents;
    }
  }

  const remaining = (totalCents ?? 0) - allocated;
  if (!message && rows.length > 0 && totalCents !== null && remaining !== 0) {
    message =
      remaining > 0
        ? `${formatMoney(remaining)} is still unallocated.`
        : `Allocations exceed the total by ${formatMoney(-remaining)}.`;
  }
  return { ok: message === null, message, allocatedCents: allocated, remainingCents: remaining, parsed };
}

export function findPossibleDuplicate(
  candidate: { vendor_name: string; expense_date: string; amount_cents: number },
  existing: Pick<Expense, 'id' | 'vendor_name' | 'expense_date' | 'amount_cents' | 'status'>[],
  ignoreId?: string,
) {
  const vendor = candidate.vendor_name.trim().toLowerCase();
  return (
    existing.find(
      (e) =>
        e.id !== ignoreId &&
        e.status !== 'rejected' &&
        e.expense_date === candidate.expense_date &&
        e.amount_cents === candidate.amount_cents &&
        e.vendor_name.trim().toLowerCase() === vendor,
    ) ?? null
  );
}

export function canEditExpense(e: Pick<Expense, 'submitted_by' | 'status'>, uid: string | undefined): boolean {
  return !!uid && e.submitted_by === uid && (e.status === 'draft' || e.status === 'rejected');
}

/** Managers review submitted expenses, but only an account owner may review their own (segregation of duties). */
export function canReviewExpense(
  e: Pick<Expense, 'submitted_by' | 'status'>,
  ctx: { uid: string | undefined; ownerId: string | undefined; isManager: boolean },
): boolean {
  if (!ctx.isManager || !ctx.uid || e.status !== 'submitted') return false;
  return e.submitted_by !== ctx.uid || ctx.uid === ctx.ownerId;
}

/** Fills only the fields the user has not typed into; never overwrites their input. */
export function applyExtraction(
  form: ExpenseFormState,
  ex: ReceiptExtraction,
  categories: ExpenseCategory[],
  dirty: ReadonlySet<keyof ExpenseFormState>,
): ExpenseFormState {
  const next = { ...form };
  if (!dirty.has('vendor_name') && ex.vendor_name) next.vendor_name = ex.vendor_name;
  if (!dirty.has('expense_date') && ex.expense_date && isValidISODate(ex.expense_date)) next.expense_date = ex.expense_date;
  if (!dirty.has('amount') && ex.total_cents && ex.total_cents > 0) next.amount = centsToInput(ex.total_cents);
  if (!dirty.has('tax') && ex.tax_cents && ex.tax_cents > 0) next.tax = centsToInput(ex.tax_cents);
  if (!dirty.has('category_id') && ex.suggested_category) {
    const wanted = ex.suggested_category.trim().toLowerCase();
    const match = categories.find((c) => c.active && c.name.toLowerCase() === wanted);
    if (match) next.category_id = match.id;
  }
  return next;
}

function extensionFor(file: { name: string; type: string }): string {
  const fromName = file.name.split('.').pop()?.toLowerCase() ?? '';
  const byMime: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'application/pdf': 'pdf',
  };
  return byMime[file.type] ?? (['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'].includes(fromName) ? fromName : 'jpg');
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
};

/** Some browsers report an empty MIME type for HEIC — only then do we trust the extension. */
export function receiptMime(file: { name: string; type: string }): string {
  if ((ALLOWED_RECEIPT_MIME as readonly string[]).includes(file.type)) return file.type;
  if (file.type === '' || file.type === 'application/octet-stream') {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (MIME_BY_EXTENSION[ext]) return MIME_BY_EXTENSION[ext];
  }
  return file.type;
}

export function validateReceiptFile(file: { name: string; type: string; size: number }): string | null {
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > MAX_RECEIPT_BYTES) return 'Receipts can be up to 10 MB.';
  const mime = receiptMime(file);
  if (!(ALLOWED_RECEIPT_MIME as readonly string[]).includes(mime)) return 'Upload a photo (JPG, PNG, WebP, HEIC) or a PDF.';
  return null;
}

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------
// API
// ------------------------------------------------------------------

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export async function ensureDefaultCategories(): Promise<void> {
  await rpc<number>('ensure_default_expense_categories');
}

export async function fetchCategories(ownerId: string): Promise<ExpenseCategory[]> {
  const { data, error } = await supabase
    .from('expense_categories')
    .select('id, name, gl_account_code, is_system, active, sort_order')
    .eq('user_id', ownerId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ExpenseCategory[];
}

export async function addCategory(name: string, glAccountCode: string): Promise<void> {
  const { error } = await supabase.from('expense_categories').insert({ name: name.trim(), gl_account_code: glAccountCode.trim() || '6900' });
  if (error) throw new Error(error.code === '23505' ? 'A category with that name already exists.' : error.message);
}

export async function setCategoryActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('expense_categories').update({ active }).eq('id', id);
  if (error) throw new Error(error.message);
}

export interface FetchExpensesParams {
  ownerId: string;
  userId: string;
  view: ExpenseView;
  status?: ExpenseStatus | 'all';
  categoryId?: string;
  search?: string;
  from: number;
  pageSize: number;
}

export async function fetchExpenses(p: FetchExpensesParams): Promise<{ rows: Expense[]; hasMore: boolean }> {
  let q = supabase
    .from('expenses')
    .select('*, category:expense_categories(name), allocations:expense_allocations(job_id, amount_cents, job:jobs(customer_name, service_type))')
    .eq('user_id', p.ownerId);

  if (p.view === 'mine') q = q.eq('submitted_by', p.userId);
  if (p.view === 'review') q = q.eq('status', 'submitted');
  if (p.view === 'reimburse') q = q.eq('status', 'approved').eq('is_reimbursable', true);
  if ((p.view === 'mine' || p.view === 'all') && p.status && p.status !== 'all') q = q.eq('status', p.status);
  if (p.categoryId) q = q.eq('category_id', p.categoryId);

  const term = (p.search ?? '').trim().slice(0, 60).replace(/[\\%_,()]/g, ' ').trim();
  if (term) q = q.ilike('vendor_name', `%${term}%`);

  q = q.order('expense_date', { ascending: p.view === 'review' || p.view === 'reimburse' }).order('created_at', { ascending: false });
  const { data, error } = await q.range(p.from, p.from + p.pageSize);
  if (error) throw new Error(error.message);

  const all = (data ?? []) as Expense[];
  return { rows: all.slice(0, p.pageSize).map((r) => ({ ...r, allocations: r.allocations ?? [] })), hasMore: all.length > p.pageSize };
}

export async function fetchSummary(start: string, end: string): Promise<ExpenseSummary> {
  const raw = await rpc<Partial<ExpenseSummary> | null>('get_expense_summary', { p_start: start, p_end: end });
  return {
    pending_count: Number(raw?.pending_count ?? 0),
    pending_cents: Number(raw?.pending_cents ?? 0),
    owed_count: Number(raw?.owed_count ?? 0),
    owed_cents: Number(raw?.owed_cents ?? 0),
    period_cents: Number(raw?.period_cents ?? 0),
    reimbursed_cents: Number(raw?.reimbursed_cents ?? 0),
    by_category: (raw?.by_category ?? []).map((c) => ({ name: c.name, cents: Number(c.cents) })),
    by_job: (raw?.by_job ?? []).map((j) => ({ job_id: j.job_id, customer_name: j.customer_name, cents: Number(j.cents) })),
  };
}

export async function fetchJobOptions(ownerId: string): Promise<JobOption[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, customer_name, service_type, scheduled_datetime, job_status')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as JobOption[];
}

export interface SaveExpenseInput {
  id: string | null;
  form: ExpenseFormState;
  amountCents: number;
  taxCents: number;
  allocations: { job_id: string; amount_cents: number }[];
  receipt: { path: string; mime: string; hash: string | null } | null;
  ocr: { status: 'none' | 'done' | 'failed'; data: ReceiptExtraction | null };
  submit: boolean;
}

export async function saveExpense(i: SaveExpenseInput): Promise<string> {
  return rpc<string>('save_expense', {
    p_id: i.id,
    p_data: {
      vendor_name: i.form.vendor_name.trim(),
      expense_date: i.form.expense_date,
      amount_cents: i.amountCents,
      tax_cents: i.taxCents,
      category_id: i.form.category_id,
      payment_method: i.form.payment_method,
      is_reimbursable: i.form.payment_method === 'company_card' ? false : i.form.is_reimbursable,
      notes: i.form.notes.trim() || null,
      receipt_path: i.receipt?.path ?? null,
      receipt_mime: i.receipt?.mime ?? null,
      receipt_hash: i.receipt?.hash ?? null,
      ocr_status: i.ocr.status,
      ocr_data: i.ocr.data,
    },
    p_allocations: i.allocations,
    p_submit: i.submit,
  });
}

export async function reviewExpense(id: string, decision: 'approved' | 'rejected', note?: string): Promise<void> {
  await rpc<null>('review_expense', { p_id: id, p_decision: decision, p_note: note ?? null });
}

export async function reimburseExpenses(ids: string[], method: ReimbursementMethod, reference: string, paidDate: string): Promise<number> {
  return rpc<number>('reimburse_expenses', {
    p_ids: ids,
    p_method: method,
    p_reference: reference.trim() || null,
    p_paid_date: paidDate,
  });
}

export async function deleteExpense(id: string): Promise<void> {
  const receiptPath = await rpc<string | null>('delete_expense', { p_id: id });
  if (receiptPath) await removeReceipt(receiptPath);
}

export async function uploadReceipt(ownerId: string, uid: string, file: File): Promise<{ path: string; mime: string }> {
  const mime = receiptMime(file);
  const path = `${ownerId}/${uid}/${crypto.randomUUID()}.${extensionFor({ name: file.name, type: mime })}`;
  const { error } = await supabase.storage.from(EXPENSE_BUCKET).upload(path, file, { contentType: mime, upsert: false, cacheControl: '3600' });
  if (error) throw new Error(error.message);
  return { path, mime };
}

/** Best effort — an orphaned receipt must never block the user. */
export async function removeReceipt(path: string): Promise<void> {
  try {
    await supabase.storage.from(EXPENSE_BUCKET).remove([path]);
  } catch {
    /* ignore */
  }
}

export async function getReceiptUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(EXPENSE_BUCKET).createSignedUrl(path, 600);
  return error ? null : data?.signedUrl ?? null;
}

export async function receiptHashExists(ownerId: string, hash: string, ignoreId?: string): Promise<boolean> {
  let q = supabase.from('expenses').select('id').eq('user_id', ownerId).eq('receipt_hash', hash).neq('status', 'rejected').limit(1);
  if (ignoreId) q = q.neq('id', ignoreId);
  const { data } = await q;
  return (data?.length ?? 0) > 0;
}

export async function runReceiptOcr(path: string): Promise<ReceiptExtraction> {
  const { data, error } = await supabase.functions.invoke('expense-receipt-ocr', { body: { path } });
  if (error) {
    let message = 'We could not read that receipt. You can fill in the details by hand.';
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const body = (await ctx.json()) as { error?: string };
        if (body?.error) message = String(body.error);
      } catch {
        /* keep default */
      }
    }
    throw new Error(message);
  }
  return data.extraction as ReceiptExtraction;
}
