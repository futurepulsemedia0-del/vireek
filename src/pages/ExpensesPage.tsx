import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Camera,
  Check,
  ChevronDown,
  FileText,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  Receipt,
  RefreshCw,
  ScanLine,
  Search,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  PAYMENT_METHOD_LABELS,
  REIMBURSEMENT_METHOD_LABELS,
  RECEIPT_REQUIRED_CENTS,
  STATUS_META,
  addCategory,
  applyExtraction,
  canEditExpense,
  canReviewExpense,
  centsToInput,
  checkAllocations,
  deleteExpense,
  dollarsToCents,
  ensureDefaultCategories,
  fetchCategories,
  fetchExpenses,
  fetchJobOptions,
  fetchSummary,
  findPossibleDuplicate,
  formatMoney,
  getReceiptUrl,
  monthRange,
  receiptHashExists,
  reimburseExpenses,
  removeReceipt,
  reviewExpense,
  runReceiptOcr,
  saveExpense,
  setCategoryActive,
  sha256Hex,
  splitEvenly,
  toISODate,
  uploadReceipt,
  validateExpenseForm,
  validateReceiptFile,
  type AllocationRow,
  type Expense,
  type ExpenseCategory,
  type ExpenseFormState,
  type ExpenseStatus,
  type ExpenseSummary,
  type ExpenseView,
  type JobOption,
  type PaymentMethod,
  type ReceiptExtraction,
  type ReimbursementMethod,
} from '@/lib/expenses';

const PAGE_SIZE = 25;

const selectCls =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary disabled:cursor-not-allowed disabled:opacity-50';

const GL_OPTIONS: { code: string; label: string }[] = [
  { code: '5000', label: '5000 · Cost of goods – parts' },
  { code: '5100', label: '5100 · Subcontractor cost' },
  { code: '6100', label: '6100 · Vehicle and fuel' },
  { code: '6200', label: '6200 · Marketing and advertising' },
  { code: '6300', label: '6300 · Software and subscriptions' },
  { code: '6400', label: '6400 · Rent and utilities' },
  { code: '6500', label: '6500 · Insurance' },
  { code: '6900', label: '6900 · General and administrative' },
];

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function StatusPill({ status }: { status: ExpenseStatus }) {
  const meta = STATUS_META[status];
  return <span className={`inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${meta.className}`}>{meta.label}</span>;
}

// ------------------------------------------------------------------
// Modal shell (focus trap, Escape, bottom sheet on phones)
// ------------------------------------------------------------------

function Modal({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useFocusTrap(open);
  useEscapeToClose(open, onClose);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-t-2xl border border-border bg-bg-secondary shadow-xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-border px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Create / edit expense
// ------------------------------------------------------------------

interface ReceiptState {
  path: string;
  mime: string;
  hash: string | null;
  isNew: boolean;
}

type OcrState = { status: 'idle' | 'scanning' | 'done' | 'failed'; message: string | null; data: ReceiptExtraction | null };

function initialForm(expense: Expense | null, categories: ExpenseCategory[]): ExpenseFormState {
  if (expense) {
    return {
      vendor_name: expense.vendor_name,
      expense_date: expense.expense_date,
      amount: centsToInput(expense.amount_cents),
      tax: expense.tax_cents > 0 ? centsToInput(expense.tax_cents) : '',
      category_id: expense.category_id,
      payment_method: expense.payment_method,
      is_reimbursable: expense.is_reimbursable,
      notes: expense.notes ?? '',
    };
  }
  return {
    vendor_name: '',
    expense_date: toISODate(new Date()),
    amount: '',
    tax: '',
    category_id: categories.find((c) => c.active && c.name === 'Other')?.id ?? '',
    payment_method: 'personal_card',
    is_reimbursable: true,
    notes: '',
  };
}

function ExpenseFormModal({
  expense,
  categories,
  ownerId,
  uid,
  existing,
  onClose,
  onSaved,
}: {
  expense: Expense | null;
  categories: ExpenseCategory[];
  ownerId: string;
  uid: string;
  existing: Expense[];
  onClose: () => void;
  onSaved: (submitted: boolean) => void;
}) {
  const { toast } = useToast();
  const activeCategories = useMemo(() => categories.filter((c) => c.active || c.id === expense?.category_id), [categories, expense?.category_id]);
  const [form, setForm] = useState<ExpenseFormState>(() => initialForm(expense, categories));
  const dirty = useRef<Set<keyof ExpenseFormState>>(new Set());
  const [receipt, setReceipt] = useState<ReceiptState | null>(
    expense?.receipt_path ? { path: expense.receipt_path, mime: expense.receipt_mime ?? '', hash: expense.receipt_hash, isNew: false } : null,
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [ocr, setOcr] = useState<OcrState>({ status: expense?.ocr_status === 'done' ? 'done' : 'idle', message: null, data: null });
  const [allocRows, setAllocRows] = useState<AllocationRow[]>(
    () => expense?.allocations.map((a) => ({ job_id: a.job_id, amount: centsToInput(a.amount_cents) })) ?? [],
  );
  const [jobs, setJobs] = useState<JobOption[] | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'submit' | null>(null);
  const savedRef = useRef(false);
  const scanToken = useRef(0);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const amountCents = dollarsToCents(form.amount);
  const alloc = checkAllocations(amountCents, allocRows);
  const duplicate = useMemo(
    () =>
      amountCents && form.vendor_name.trim() && form.expense_date
        ? findPossibleDuplicate({ vendor_name: form.vendor_name, expense_date: form.expense_date, amount_cents: amountCents }, existing, expense?.id)
        : null,
    [amountCents, form.vendor_name, form.expense_date, existing, expense?.id],
  );

  const setField = <K extends keyof ExpenseFormState>(key: K, value: ExpenseFormState[K]) => {
    dirty.current.add(key);
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => {
      if (!e[key === 'amount' ? 'amount' : key]) return e;
      const next = { ...e };
      delete next[key === 'amount' ? 'amount' : key];
      return next;
    });
  };

  // Local preview for a freshly chosen image / signed link for the saved receipt.
  useEffect(() => {
    if (!receipt) {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;
    getReceiptUrl(receipt.path).then((url) => {
      if (!cancelled) setPreviewUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [receipt]);

  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    setJobsError(null);
    try {
      setJobs(await fetchJobOptions(ownerId));
    } catch (e) {
      setJobsError(errMsg(e, 'Could not load jobs.'));
    } finally {
      setJobsLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    if (allocRows.length > 0 && jobs === null && !jobsLoading && !jobsError) void loadJobs();
  }, [allocRows.length, jobs, jobsLoading, jobsError, loadJobs]);

  const discardAndClose = useCallback(() => {
    if (receipt?.isNew && !savedRef.current) void removeReceipt(receipt.path);
    onClose();
  }, [receipt, onClose]);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setReceiptError(null);
    const invalid = validateReceiptFile(file);
    if (invalid) {
      setReceiptError(invalid);
      return;
    }
    const token = ++scanToken.current;
    setOcr({ status: 'scanning', message: null, data: null });
    try {
      const hash = await sha256Hex(file);
      if (await receiptHashExists(ownerId, hash, expense?.id)) {
        setOcr({ status: 'idle', message: null, data: null });
        setReceiptError('This receipt has already been filed on another expense.');
        return;
      }
      const uploaded = await uploadReceipt(ownerId, uid, file);
      if (token !== scanToken.current) {
        void removeReceipt(uploaded.path);
        return;
      }
      if (receipt?.isNew) void removeReceipt(receipt.path);
      setReceipt({ path: uploaded.path, mime: uploaded.mime, hash, isNew: true });
      try {
        const data = await runReceiptOcr(uploaded.path);
        if (token !== scanToken.current) return;
        setForm((f) => applyExtraction(f, data, categories, dirty.current));
        setOcr({ status: 'done', message: null, data });
      } catch (e) {
        if (token !== scanToken.current) return;
        setOcr({ status: 'failed', message: errMsg(e, 'We could not read that receipt.'), data: null });
      }
    } catch (e) {
      if (token !== scanToken.current) return;
      setOcr({ status: 'idle', message: null, data: null });
      setReceiptError(errMsg(e, 'Could not upload that receipt. Check your connection and try again.'));
    }
  };

  const removeCurrentReceipt = () => {
    scanToken.current++;
    if (receipt?.isNew) void removeReceipt(receipt.path);
    setReceipt(null);
    setOcr({ status: 'idle', message: null, data: null });
  };

  const updateRow = (i: number, patch: Partial<AllocationRow>) => setAllocRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const addRow = () =>
    setAllocRows((rows) => [...rows, { job_id: '', amount: rows.length === 0 && amountCents ? centsToInput(amountCents) : '' }]);

  const splitRows = () => {
    if (!amountCents || allocRows.length === 0) return;
    const parts = splitEvenly(amountCents, allocRows.length);
    setAllocRows((rows) => rows.map((r, i) => ({ ...r, amount: centsToInput(parts[i]) })));
  };

  const submit = async (asSubmit: boolean) => {
    setFormError(null);
    const v = validateExpenseForm(form, { categories, submit: asSubmit, hasReceipt: !!receipt });
    // A category that was archived after this draft was created is still allowed on edit.
    if (v.errors.category_id && form.category_id === expense?.category_id) delete v.errors.category_id;
    setErrors(v.errors);
    if (Object.keys(v.errors).length > 0 || v.amountCents === null) {
      setFormError('Please fix the highlighted fields.');
      return;
    }
    if (!alloc.ok) {
      setFormError(alloc.message);
      return;
    }
    setSaving(asSubmit ? 'submit' : 'draft');
    try {
      await saveExpense({
        id: expense?.id ?? null,
        form,
        amountCents: v.amountCents,
        taxCents: v.taxCents,
        allocations: alloc.parsed,
        receipt: receipt ? { path: receipt.path, mime: receipt.mime, hash: receipt.hash } : null,
        ocr: { status: ocr.status === 'done' ? 'done' : ocr.status === 'failed' ? 'failed' : 'none', data: ocr.data },
        submit: asSubmit,
      });
      savedRef.current = true;
      if (expense?.receipt_path && expense.receipt_path !== receipt?.path) void removeReceipt(expense.receipt_path);
      toast(asSubmit ? 'Expense submitted for review.' : 'Draft saved.', 'success');
      onSaved(asSubmit);
    } catch (e) {
      setFormError(errMsg(e, 'Could not save this expense. Please try again.'));
    } finally {
      setSaving(null);
    }
  };

  const isImage = !!receipt && receipt.mime.startsWith('image/');
  const needsReceiptHint = amountCents !== null && amountCents >= RECEIPT_REQUIRED_CENTS && !receipt;
  const busy = saving !== null || ocr.status === 'scanning';

  return (
    <Modal
      open
      title={expense ? 'Edit expense' : 'New expense'}
      onClose={discardAndClose}
      footer={
        <div className="flex flex-col gap-3">
          {formError && (
            <p role="alert" className="flex items-start gap-2 text-sm text-danger">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> {formError}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={discardAndClose} disabled={saving !== null}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => submit(false)} disabled={busy}>
              {saving === 'draft' && <Loader2 size={16} className="animate-spin" />} Save draft
            </Button>
            <Button onClick={() => submit(true)} disabled={busy}>
              {saving === 'submit' && <Loader2 size={16} className="animate-spin" />} Submit for review
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {/* Receipt capture */}
        <section aria-label="Receipt">
          <div className="rounded-xl border border-dashed border-border bg-bg-primary p-4">
            {!receipt ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <ScanLine size={28} className="text-accent" aria-hidden="true" />
                <p className="text-sm text-text-secondary">Add a receipt and we will read the vendor, date and total for you.</p>
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                  <Button variant="secondary" size="sm" onClick={() => cameraInput.current?.click()} disabled={busy}>
                    <Camera size={16} /> Take photo
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
                    <Upload size={16} /> Upload photo or PDF
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                {isImage && previewUrl ? (
                  <img src={previewUrl} alt="Receipt preview" className="h-16 w-16 rounded-lg border border-border object-cover" />
                ) : (
                  <span className="flex h-16 w-16 items-center justify-center rounded-lg bg-bg-tertiary text-text-secondary">
                    <FileText size={24} aria-hidden="true" />
                  </span>
                )}
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium text-text-primary">Receipt attached</p>
                  {previewUrl && (
                    <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                      Open
                    </a>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
                  Replace
                </Button>
                <Button variant="ghost" size="sm" onClick={removeCurrentReceipt} disabled={busy} aria-label="Remove receipt">
                  <Trash2 size={16} />
                </Button>
              </div>
            )}
            <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ''; }} />
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" className="hidden" onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
          <div aria-live="polite" className="mt-2 space-y-1 text-sm">
            {ocr.status === 'scanning' && (
              <p className="flex items-center gap-2 text-text-secondary">
                <Loader2 size={14} className="animate-spin" /> Reading your receipt…
              </p>
            )}
            {ocr.status === 'done' && ocr.data && (
              <p className={ocr.data.confidence < 0.6 ? 'text-amber-700 dark:text-amber-300' : 'text-text-secondary'}>
                <Check size={14} className="mr-1 inline" aria-hidden="true" />
                {ocr.data.confidence < 0.6 ? 'We filled what we could — please double-check every field.' : 'Details filled from your receipt — review them before submitting.'}
              </p>
            )}
            {ocr.status === 'done' && ocr.data?.warnings.map((w) => (
              <p key={w} className="text-amber-700 dark:text-amber-300">{w}</p>
            ))}
            {ocr.status === 'failed' && <p className="text-amber-700 dark:text-amber-300">{ocr.message} Fill in the details by hand.</p>}
            {receiptError && <p role="alert" className="text-danger">{receiptError}</p>}
            {errors.receipt && <p role="alert" className="text-danger">{errors.receipt}</p>}
            {!errors.receipt && needsReceiptHint && <p className="text-text-secondary">A receipt is required to submit expenses of {formatMoney(RECEIPT_REQUIRED_CENTS)} or more.</p>}
          </div>
        </section>

        {/* Details */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Input label="Vendor" required value={form.vendor_name} maxLength={120} error={errors.vendor_name} onChange={(e) => setField('vendor_name', e.target.value)} placeholder="e.g. Home Depot" />
          </div>
          <Input label="Total" required inputMode="decimal" value={form.amount} error={errors.amount} onChange={(e) => setField('amount', e.target.value)} placeholder="0.00" />
          <Input label="Tax included (optional)" inputMode="decimal" value={form.tax} error={errors.tax} onChange={(e) => setField('tax', e.target.value)} placeholder="0.00" />
          <Input label="Date" required type="date" value={form.expense_date} max={toISODate(new Date())} error={errors.expense_date} onChange={(e) => setField('expense_date', e.target.value)} />
          <div>
            <label htmlFor="exp-category" className="mb-1.5 block text-sm font-medium text-text-primary">
              Category<span className="ml-0.5 text-danger">*</span>
            </label>
            <select id="exp-category" className={selectCls} value={form.category_id} onChange={(e) => setField('category_id', e.target.value)} aria-invalid={!!errors.category_id}>
              <option value="">Choose a category…</option>
              {activeCategories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (archived)'}</option>
              ))}
            </select>
            {errors.category_id && <p role="alert" className="mt-1.5 text-xs text-danger">{errors.category_id}</p>}
          </div>
          <div>
            <label htmlFor="exp-method" className="mb-1.5 block text-sm font-medium text-text-primary">Paid with</label>
            <select
              id="exp-method"
              className={selectCls}
              value={form.payment_method}
              onChange={(e) => {
                const method = e.target.value as PaymentMethod;
                dirty.current.add('payment_method');
                setForm((f) => ({ ...f, payment_method: method, is_reimbursable: method === 'company_card' ? false : f.is_reimbursable }));
              }}
            >
              {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((m) => (
                <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
              ))}
            </select>
          </div>
          <label className="flex min-h-[48px] items-center gap-3 self-end text-sm text-text-primary">
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-border"
              checked={form.payment_method === 'company_card' ? false : form.is_reimbursable}
              disabled={form.payment_method === 'company_card'}
              onChange={(e) => setField('is_reimbursable', e.target.checked)}
            />
            <span>
              Reimburse me
              {form.payment_method === 'company_card' && <span className="block text-xs text-text-secondary">Company card spend is not reimbursed.</span>}
            </span>
          </label>
          <div className="sm:col-span-2">
            <Textarea label="Notes (optional)" rows={2} maxLength={2000} value={form.notes} error={errors.notes} onChange={(e) => setField('notes', e.target.value)} placeholder="What was this for?" />
          </div>
        </div>

        {duplicate && (
          <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200" role="status">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            This looks like an expense already filed for {duplicate.vendor_name} on {formatDate(duplicate.expense_date)} ({formatMoney(duplicate.amount_cents)}). Submit only if it is a different purchase.
          </p>
        )}

        {/* Job allocation */}
        <section aria-label="Job allocation" className="rounded-xl border border-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Charge to jobs</h3>
              <p className="text-xs text-text-secondary">Leave empty for overhead. Allocated amounts feed each job's real cost.</p>
            </div>
            {allocRows.length === 0 && (
              <Button variant="secondary" size="sm" onClick={addRow}>
                <Plus size={16} /> Add job
              </Button>
            )}
          </div>

          {allocRows.length > 0 && (
            <div className="mt-3 space-y-3">
              {jobsLoading && <p className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={14} className="animate-spin" /> Loading jobs…</p>}
              {jobsError && (
                <p role="alert" className="text-sm text-danger">
                  {jobsError}{' '}
                  <button type="button" className="underline" onClick={() => void loadJobs()}>Retry</button>
                </p>
              )}
              {jobs && jobs.length === 0 && <p className="text-sm text-text-secondary">You have no jobs to charge this to yet.</p>}
              {allocRows.map((row, i) => (
                <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-start">
                  <select
                    className={selectCls}
                    aria-label={`Job ${i + 1}`}
                    value={row.job_id}
                    onChange={(e) => updateRow(i, { job_id: e.target.value })}
                  >
                    <option value="">Choose a job…</option>
                    {(jobs ?? []).map((j) => (
                      <option key={j.id} value={j.id} disabled={allocRows.some((r, idx) => idx !== i && r.job_id === j.id)}>
                        {j.customer_name}{j.service_type ? ` · ${j.service_type}` : ''}{j.scheduled_datetime ? ` · ${formatDate(j.scheduled_datetime)}` : ''}
                      </option>
                    ))}
                    {row.job_id && !(jobs ?? []).some((j) => j.id === row.job_id) && <option value={row.job_id}>Selected job</option>}
                  </select>
                  <div className="flex gap-2 sm:w-44">
                    <Input aria-label={`Amount for job ${i + 1}`} inputMode="decimal" value={row.amount} onChange={(e) => updateRow(i, { amount: e.target.value })} placeholder="0.00" />
                    <Button variant="ghost" size="sm" aria-label={`Remove job ${i + 1}`} onClick={() => setAllocRows((rows) => rows.filter((_, idx) => idx !== i))}>
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={addRow} disabled={allocRows.length >= 20}><Plus size={16} /> Add job</Button>
                <Button variant="ghost" size="sm" onClick={splitRows} disabled={!amountCents}>Split evenly</Button>
                <Button variant="ghost" size="sm" onClick={() => setAllocRows([])}>Overhead instead</Button>
                <p className={`ml-auto text-sm ${alloc.ok ? 'text-text-secondary' : 'text-danger'}`} role={alloc.ok ? undefined : 'alert'}>
                  {alloc.message ?? `${formatMoney(alloc.allocatedCents)} allocated`}
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------
// Reject + reimburse dialogs
// ------------------------------------------------------------------

function RejectModal({ expense, onClose, onDone }: { expense: Expense; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (note.trim().length < 3) {
      setError('Add a short reason so the submitter knows what to fix.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await reviewExpense(expense.id, 'rejected', note.trim());
      toast('Expense rejected.', 'success');
      onDone();
    } catch (e) {
      setError(errMsg(e, 'Could not reject this expense.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Reject expense"
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={confirm} disabled={busy}>{busy && <Loader2 size={16} className="animate-spin" />} Reject expense</Button>
        </div>
      }
    >
      <p className="mb-3 text-sm text-text-secondary">
        {expense.vendor_name} · {formatMoney(expense.amount_cents)}. The submitter can fix it and send it again.
      </p>
      <Textarea label="Reason" required rows={3} maxLength={500} value={note} error={error ?? undefined} onChange={(e) => { setNote(e.target.value); setError(null); }} />
    </Modal>
  );
}

function ReimburseModal({ expenses, onClose, onDone }: { expenses: Expense[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [method, setMethod] = useState<ReimbursementMethod>('bank_transfer');
  const [reference, setReference] = useState('');
  const [paidDate, setPaidDate] = useState(toISODate(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = expenses.reduce((sum, e) => sum + e.amount_cents, 0);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const n = await reimburseExpenses(expenses.map((e) => e.id), method, reference, paidDate);
      toast(`${n} expense${n === 1 ? '' : 's'} marked as reimbursed.`, 'success');
      onDone();
    } catch (e) {
      setError(errMsg(e, 'Could not record the reimbursement.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Record reimbursement"
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-3">
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={confirm} disabled={busy}>{busy && <Loader2 size={16} className="animate-spin" />} Record {formatMoney(total)}</Button>
          </div>
        </div>
      }
    >
      <p className="mb-4 text-sm text-text-secondary">
        {expenses.length} expense{expenses.length === 1 ? '' : 's'} · {formatMoney(total)}. This posts the payment to your books (Dr Reimbursements Payable, Cr Cash).
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="reimb-method" className="mb-1.5 block text-sm font-medium text-text-primary">Paid by</label>
          <select id="reimb-method" className={selectCls} value={method} onChange={(e) => setMethod(e.target.value as ReimbursementMethod)}>
            {(Object.keys(REIMBURSEMENT_METHOD_LABELS) as ReimbursementMethod[]).map((m) => (
              <option key={m} value={m}>{REIMBURSEMENT_METHOD_LABELS[m]}</option>
            ))}
          </select>
        </div>
        <Input label="Payment date" type="date" value={paidDate} max={toISODate(new Date())} onChange={(e) => setPaidDate(e.target.value)} />
        <div className="sm:col-span-2">
          <Input label="Reference (optional)" maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Check number or transfer ID" />
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------
// Category manager (managers only)
// ------------------------------------------------------------------

function CategoryManager({ categories, onChanged }: { categories: ExpenseCategory[]; onChanged: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [gl, setGl] = useState('6900');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await addCategory(name, gl);
      setName('');
      onChanged();
      toast('Category added.', 'success');
    } catch (e) {
      toast(errMsg(e, 'Could not add the category.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (c: ExpenseCategory) => {
    try {
      await setCategoryActive(c.id, !c.active);
      onChanged();
    } catch (e) {
      toast(errMsg(e, 'Could not update the category.'), 'error');
    }
  };

  return (
    <Card className="mt-6 p-4">
      <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>
          <span className="block text-sm font-semibold text-text-primary">Categories</span>
          <span className="block text-xs text-text-secondary">Each category posts to a ledger account when expenses are approved.</span>
        </span>
        <ChevronDown size={18} className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="mt-4 space-y-4">
          <ul className="divide-y divide-border">
            {categories.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className={c.active ? 'text-text-primary' : 'text-text-secondary line-through'}>
                  {c.name} <span className="text-xs text-text-secondary">· {c.gl_account_code}</span>
                </span>
                {c.name !== 'Other' && (
                  <button type="button" onClick={() => void toggle(c)} className="text-xs text-accent hover:underline">
                    {c.active ? 'Archive' : 'Restore'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1"><Input label="New category" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Uniforms" /></div>
            <div className="sm:w-64">
              <label htmlFor="cat-gl" className="mb-1.5 block text-sm font-medium text-text-primary">Ledger account</label>
              <select id="cat-gl" className={selectCls} value={gl} onChange={(e) => setGl(e.target.value)}>
                {GL_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
              </select>
            </div>
            <Button variant="secondary" onClick={add} disabled={busy || !name.trim()}>{busy && <Loader2 size={16} className="animate-spin" />} Add</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------
// Row
// ------------------------------------------------------------------

function ExpenseDetails({ expense, showSubmitter }: { expense: Expense; showSubmitter: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [urlState, setUrlState] = useState<'idle' | 'loading' | 'error'>('idle');

  useEffect(() => {
    if (!expense.receipt_path) return;
    let cancelled = false;
    setUrlState('loading');
    getReceiptUrl(expense.receipt_path).then((u) => {
      if (cancelled) return;
      setUrl(u);
      setUrlState(u ? 'idle' : 'error');
    });
    return () => {
      cancelled = true;
    };
  }, [expense.receipt_path]);

  const isImage = expense.receipt_mime?.startsWith('image/');
  return (
    <div className="grid gap-4 border-t border-border bg-bg-primary/50 px-4 py-4 text-sm md:grid-cols-[160px_1fr]">
      <div>
        {!expense.receipt_path && <p className="text-text-secondary">No receipt attached.</p>}
        {expense.receipt_path && urlState === 'loading' && <div className="h-28 w-full animate-pulse rounded-lg bg-bg-tertiary md:w-40" />}
        {expense.receipt_path && urlState === 'error' && <p className="text-danger">Receipt could not be loaded.</p>}
        {url && isImage && (
          <a href={url} target="_blank" rel="noopener noreferrer">
            <img src={url} alt={`Receipt from ${expense.vendor_name}`} className="max-h-48 w-full rounded-lg border border-border object-cover md:w-40" loading="lazy" />
          </a>
        )}
        {url && !isImage && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-accent hover:underline">
            <FileText size={16} aria-hidden="true" /> Open receipt (PDF)
          </a>
        )}
      </div>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {showSubmitter && <div><dt className="text-xs text-text-secondary">Submitted by</dt><dd className="text-text-primary">{expense.submitted_by_email ?? 'Unknown'}</dd></div>}
        <div><dt className="text-xs text-text-secondary">Paid with</dt><dd className="text-text-primary">{PAYMENT_METHOD_LABELS[expense.payment_method]}{expense.is_reimbursable ? ' · reimbursable' : ''}</dd></div>
        {expense.tax_cents > 0 && <div><dt className="text-xs text-text-secondary">Tax included</dt><dd className="text-text-primary">{formatMoney(expense.tax_cents)}</dd></div>}
        {expense.allocations.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="text-xs text-text-secondary">Charged to jobs</dt>
            <dd className="text-text-primary">
              {expense.allocations.map((a) => (
                <span key={a.job_id} className="mr-2 inline-block">{a.job?.customer_name ?? 'Job'} ({formatMoney(a.amount_cents)})</span>
              ))}
            </dd>
          </div>
        ) : (
          <div><dt className="text-xs text-text-secondary">Charged to</dt><dd className="text-text-primary">Overhead</dd></div>
        )}
        {expense.notes && <div className="sm:col-span-2"><dt className="text-xs text-text-secondary">Notes</dt><dd className="whitespace-pre-wrap text-text-primary">{expense.notes}</dd></div>}
        {expense.status === 'rejected' && expense.review_note && (
          <div className="sm:col-span-2 rounded-lg bg-red-50 p-3 text-red-900 dark:bg-red-500/10 dark:text-red-200"><dt className="text-xs font-semibold">Rejected</dt><dd>{expense.review_note}</dd></div>
        )}
        {expense.status === 'reimbursed' && (
          <div className="sm:col-span-2"><dt className="text-xs text-text-secondary">Reimbursed</dt><dd className="text-text-primary">{formatDate(expense.reimbursed_at)}{expense.reimbursement_method ? ` · ${REIMBURSEMENT_METHOD_LABELS[expense.reimbursement_method as ReimbursementMethod] ?? expense.reimbursement_method}` : ''}{expense.reimbursement_reference ? ` · ${expense.reimbursement_reference}` : ''}</dd></div>
        )}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------
// Page
// ------------------------------------------------------------------

const VIEW_LABELS: Record<ExpenseView, string> = {
  mine: 'My expenses',
  review: 'Needs review',
  reimburse: 'To reimburse',
  all: 'All expenses',
};

export function ExpensesPage() {
  const { user, profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const { toast } = useToast();

  const uid = user?.id;
  // Same derivation as NotificationsContext: every query is scoped to the ACCOUNT OWNER, never to the member.
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const isManager = isOwner || permissions.can_view_billing;

  const [view, setView] = useState<ExpenseView>('mine');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ExpenseStatus | 'all'>('all');
  const [categoryId, setCategoryId] = useState('');

  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [rows, setRows] = useState<Expense[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [summaryError, setSummaryError] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [formTarget, setFormTarget] = useState<{ expense: Expense | null } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Expense | null>(null);
  const [approveTarget, setApproveTarget] = useState<Expense | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);
  const [reimburseTargets, setReimburseTargets] = useState<Expense[] | null>(null);

  const requestId = useRef(0);
  const rowsCount = useRef(0);
  rowsCount.current = rows.length;

  const effectiveView: ExpenseView = !isManager && view !== 'mine' ? 'mine' : view;

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadCategories = useCallback(async () => {
    if (!ownerId) return;
    try {
      setCategories(await fetchCategories(ownerId));
      setCategoriesError(null);
    } catch (e) {
      setCategoriesError(errMsg(e, 'Could not load categories.'));
    }
  }, [ownerId]);

  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false;
    (async () => {
      try {
        await ensureDefaultCategories();
      } catch {
        /* the read below surfaces any real problem */
      }
      if (!cancelled) await loadCategories();
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerId, loadCategories]);

  const loadSummary = useCallback(async () => {
    if (!ownerId) return;
    try {
      const { start, end } = monthRange();
      setSummary(await fetchSummary(start, end));
      setSummaryError(false);
    } catch {
      setSummaryError(true);
    }
  }, [ownerId]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const loadList = useCallback(
    async (reset: boolean) => {
      if (!ownerId || !uid) return;
      const id = ++requestId.current;
      if (reset) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }
      try {
        const res = await fetchExpenses({
          ownerId,
          userId: uid,
          view: effectiveView,
          status,
          categoryId: categoryId || undefined,
          search,
          from: reset ? 0 : rowsCount.current,
          pageSize: PAGE_SIZE,
        });
        if (id !== requestId.current) return;
        setRows((prev) => (reset ? res.rows : [...prev, ...res.rows.filter((r) => !prev.some((p) => p.id === r.id))]));
        setHasMore(res.hasMore);
      } catch (e) {
        if (id !== requestId.current) return;
        if (reset) setRows([]);
        setError(errMsg(e, 'Could not load expenses.'));
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [ownerId, uid, effectiveView, status, categoryId, search],
  );

  useEffect(() => {
    setSelected(new Set());
    setExpandedId(null);
    void loadList(true);
  }, [loadList]);

  const refreshAll = useCallback(() => {
    void loadList(true);
    void loadSummary();
  }, [loadList, loadSummary]);

  const runApprove = async (e: Expense) => {
    try {
      await reviewExpense(e.id, 'approved');
      toast('Expense approved and posted to the books.', 'success');
      refreshAll();
    } catch (err) {
      toast(errMsg(err, 'Could not approve this expense.'), 'error');
    }
  };

  const runDelete = async (e: Expense) => {
    try {
      await deleteExpense(e.id);
      toast('Expense deleted.', 'success');
      refreshAll();
    } catch (err) {
      toast(errMsg(err, 'Could not delete this expense.'), 'error');
    }
  };

  const payable = useMemo(() => rows.filter((r) => r.status === 'approved' && r.is_reimbursable), [rows]);
  const selectedRows = useMemo(() => payable.filter((r) => selected.has(r.id)), [payable, selected]);
  const showSubmitter = effectiveView !== 'mine';
  const filtersActive = status !== 'all' || !!categoryId || !!search.trim();
  const categoryName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  // ---- gates -------------------------------------------------------
  if (profileLoading || (!ownerId && !uid)) {
    return (
      <DashboardLayout activeLabel="Expenses">
        <SkeletonStatGrid className="mb-6" />
        <SkeletonCardList count={4} />
      </DashboardLayout>
    );
  }
  if (!ownerId || !uid) {
    return (
      <DashboardLayout activeLabel="Expenses">
        <EmptyState icon={Receipt} title="Expenses are unavailable" description="We could not find the account this login belongs to. Ask the account owner to check your team access." />
      </DashboardLayout>
    );
  }

  const views: ExpenseView[] = isManager ? ['mine', 'review', 'reimburse', 'all'] : ['mine'];

  return (
    <DashboardLayout activeLabel="Expenses">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Receipt size={22} aria-hidden="true" /> Expenses
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Snap a receipt and Vireek fills in the details. Charge it to jobs, get it approved, and reimburse your team — every step lands in your books.
          </p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button variant="secondary" size="sm" onClick={refreshAll} aria-label="Refresh"><RefreshCw size={16} /></Button>
          <Button className="flex-1 sm:flex-none" onClick={() => setFormTarget({ expense: null })} disabled={categories.length === 0}>
            <Plus size={18} /> New expense
          </Button>
        </div>
      </div>

      {categoriesError && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {categoriesError} <button type="button" className="underline" onClick={() => void loadCategories()}>Retry</button>
        </p>
      )}

      {/* Summary */}
      {summary === null && !summaryError ? (
        <SkeletonStatGrid className="mb-6" />
      ) : summary ? (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: isManager ? 'Awaiting review' : 'Awaiting review (yours)', value: formatMoney(summary.pending_cents), sub: `${summary.pending_count} expense${summary.pending_count === 1 ? '' : 's'}` },
            { label: isManager ? 'To reimburse' : 'Owed to you', value: formatMoney(summary.owed_cents), sub: `${summary.owed_count} approved` },
            { label: 'Approved this month', value: formatMoney(summary.period_cents), sub: 'Posted to the books' },
            { label: 'Reimbursed this month', value: formatMoney(summary.reimbursed_cents), sub: 'Paid out' },
          ].map((s) => (
            <Card key={s.label} className="p-4">
              <p className="text-xs font-medium text-text-secondary">{s.label}</p>
              <p className="mt-1 text-xl font-bold tabular-nums text-text-primary">{s.value}</p>
              <p className="text-xs text-text-secondary">{s.sub}</p>
            </Card>
          ))}
        </div>
      ) : (
        <p className="mb-6 text-sm text-text-secondary">
          Totals are unavailable right now. <button type="button" className="text-accent underline" onClick={() => void loadSummary()}>Retry</button>
        </p>
      )}

      {isManager && summary && (summary.by_category.length > 0 || summary.by_job.length > 0) && (
        <div className="mb-6 grid gap-3 md:grid-cols-2">
          {[
            { title: 'Top categories this month', items: summary.by_category.map((c) => ({ key: c.name, label: c.name, cents: c.cents })) },
            { title: 'Top jobs this month', items: summary.by_job.map((j) => ({ key: j.job_id, label: j.customer_name, cents: j.cents })) },
          ].map((block) => {
            const max = Math.max(1, ...block.items.map((i) => i.cents));
            return (
              <Card key={block.title} className="p-4">
                <h3 className="mb-3 text-sm font-semibold text-text-primary">{block.title}</h3>
                {block.items.length === 0 ? (
                  <p className="text-xs text-text-secondary">Nothing allocated yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {block.items.map((i) => (
                      <li key={i.key} className="text-sm">
                        <div className="flex justify-between gap-3">
                          <span className="truncate text-text-primary">{i.label}</span>
                          <span className="tabular-nums text-text-secondary">{formatMoney(i.cents)}</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-bg-tertiary"><div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.max(4, (i.cents / max) * 100)}%` }} /></div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Tabs */}
      {views.length > 1 && (
        <div role="tablist" aria-label="Expense views" className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1">
          {views.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={effectiveView === v}
              onClick={() => { setView(v); setStatus('all'); }}
              className={`focus-ring min-h-[44px] shrink-0 rounded-xl px-4 text-sm font-medium transition-colors ${effectiveView === v ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary'}`}
            >
              {VIEW_LABELS[v]}
              {v === 'review' && summary && summary.pending_count > 0 && (
                <span className="ml-2 rounded-full bg-white/25 px-2 py-0.5 text-xs">{summary.pending_count}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_180px_200px]">
        <Input icon={Search} aria-label="Search by vendor" placeholder="Search vendors…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        <select aria-label="Filter by status" className={selectCls} value={status} disabled={effectiveView === 'review' || effectiveView === 'reimburse'} onChange={(e) => setStatus(e.target.value as ExpenseStatus | 'all')}>
          <option value="all">All statuses</option>
          {(Object.keys(STATUS_META) as ExpenseStatus[]).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
        </select>
        <select aria-label="Filter by category" className={selectCls} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {effectiveView === 'reimburse' && payable.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3">
          <label className="flex items-center gap-3 text-sm text-text-primary">
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-border"
              checked={selectedRows.length === payable.length}
              onChange={(e) => setSelected(e.target.checked ? new Set(payable.map((r) => r.id)) : new Set())}
            />
            Select all ({payable.length})
          </label>
          <Button size="sm" disabled={selectedRows.length === 0} onClick={() => setReimburseTargets(selectedRows)}>
            Reimburse {selectedRows.length > 0 ? `${selectedRows.length} · ${formatMoney(selectedRows.reduce((s, r) => s + r.amount_cents, 0))}` : 'selected'}
          </Button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <SkeletonCardList count={5} />
      ) : error ? (
        <Card className="p-6 text-center">
          <p role="alert" className="text-sm text-danger">{error}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void loadList(true)}><RefreshCw size={16} /> Try again</Button>
        </Card>
      ) : rows.length === 0 ? (
        filtersActive ? (
          <EmptyState
            icon={Search}
            title="No expenses match these filters"
            description="Try a different search or clear the filters."
            action={{ label: 'Clear filters', onClick: () => { setSearchInput(''); setStatus('all'); setCategoryId(''); } }}
          />
        ) : effectiveView === 'review' ? (
          <EmptyState icon={Check} title="You're all caught up" description="Expenses your team submits will wait here for approval." />
        ) : effectiveView === 'reimburse' ? (
          <EmptyState icon={Check} title="Nobody is waiting to be paid back" description="Approved expenses that need reimbursing will show up here." />
        ) : (
          <EmptyState
            icon={Receipt}
            title={effectiveView === 'all' ? 'No expenses have been filed' : 'Track your first expense'}
            description="Take a photo of a receipt — we read the vendor, date and total so you don't have to type them."
            action={{ label: 'New expense', onClick: () => setFormTarget({ expense: null }) }}
          />
        )
      ) : (
        <Card className="overflow-hidden p-0 hover:translate-y-0">
          <ul>
            {rows.map((e) => {
              const expanded = expandedId === e.id;
              const editable = canEditExpense(e, uid);
              const reviewable = canReviewExpense(e, { uid, ownerId, isManager });
              const payableRow = isManager && e.status === 'approved' && e.is_reimbursable;
              return (
                <li key={e.id} className="border-b border-border last:border-b-0">
                  <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:gap-4">
                    {effectiveView === 'reimburse' && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${e.vendor_name}`}
                        className="h-5 w-5 shrink-0 rounded border-border"
                        checked={selected.has(e.id)}
                        onChange={(ev) => setSelected((prev) => { const next = new Set(prev); if (ev.target.checked) next.add(e.id); else next.delete(e.id); return next; })}
                      />
                    )}
                    <button type="button" className="focus-ring flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : e.id)}>
                      <span className="mt-0.5 text-text-secondary">{e.receipt_path ? <Paperclip size={18} aria-label="Has receipt" /> : <FileText size={18} aria-hidden="true" />}</span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-text-primary">{e.vendor_name}</span>
                        <span className="block text-xs text-text-secondary">
                          {formatDate(e.expense_date)} · {e.category?.name ?? categoryName.get(e.category_id) ?? 'Uncategorized'}
                          {showSubmitter && e.submitted_by_email ? ` · ${e.submitted_by_email}` : ''}
                          {e.allocations.length > 0 ? ` · ${e.allocations.length} job${e.allocations.length === 1 ? '' : 's'}` : ''}
                        </span>
                      </span>
                      <ChevronDown size={16} className={`ml-auto mt-1 shrink-0 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>
                    <div className="flex items-center justify-between gap-3 md:justify-end">
                      <span className="font-semibold tabular-nums text-text-primary">{formatMoney(e.amount_cents)}</span>
                      <StatusPill status={e.status} />
                    </div>
                    {(editable || reviewable || payableRow) && (
                      <div className="flex flex-wrap gap-2 md:justify-end">
                        {reviewable && (
                          <>
                            <Button size="sm" onClick={() => setApproveTarget(e)}><Check size={16} /> Approve</Button>
                            <Button size="sm" variant="secondary" onClick={() => setRejectTarget(e)}>Reject</Button>
                          </>
                        )}
                        {payableRow && <Button size="sm" variant="secondary" onClick={() => setReimburseTargets([e])}>Mark reimbursed</Button>}
                        {editable && (
                          <>
                            <Button size="sm" variant="secondary" onClick={() => setFormTarget({ expense: e })}><Pencil size={16} /> {e.status === 'rejected' ? 'Fix & resubmit' : 'Edit'}</Button>
                            <Button size="sm" variant="ghost" aria-label={`Delete ${e.vendor_name}`} onClick={() => setDeleteTarget(e)}><Trash2 size={16} /></Button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {expanded && <ExpenseDetails expense={e} showSubmitter={showSubmitter} />}
                </li>
              );
            })}
          </ul>
          {hasMore && (
            <div className="border-t border-border p-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => void loadList(false)} disabled={loadingMore}>
                {loadingMore && <Loader2 size={16} className="animate-spin" />} Load more
              </Button>
            </div>
          )}
        </Card>
      )}

      {isManager && categories.length > 0 && <CategoryManager categories={categories} onChanged={() => void loadCategories()} />}

      {formTarget && (
        <ExpenseFormModal
          expense={formTarget.expense}
          categories={categories}
          ownerId={ownerId}
          uid={uid}
          existing={rows}
          onClose={() => setFormTarget(null)}
          onSaved={() => { setFormTarget(null); refreshAll(); }}
        />
      )}
      {rejectTarget && <RejectModal expense={rejectTarget} onClose={() => setRejectTarget(null)} onDone={() => { setRejectTarget(null); refreshAll(); }} />}
      {reimburseTargets && <ReimburseModal expenses={reimburseTargets} onClose={() => setReimburseTargets(null)} onDone={() => { setReimburseTargets(null); refreshAll(); }} />}

      <ConfirmDialog
        open={!!approveTarget}
        title="Approve this expense?"
        description={approveTarget ? `${approveTarget.vendor_name} · ${formatMoney(approveTarget.amount_cents)} will be posted to your books${approveTarget.is_reimbursable ? ' and queued for reimbursement' : ''}.` : ''}
        confirmLabel="Approve"
        onCancel={() => setApproveTarget(null)}
        onConfirm={async () => {
          const target = approveTarget;
          setApproveTarget(null);
          if (target) await runApprove(target);
        }}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete this expense?"
        description={deleteTarget ? `${deleteTarget.vendor_name} · ${formatMoney(deleteTarget.amount_cents)} and its receipt will be permanently removed.` : ''}
        confirmLabel="Delete expense"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) await runDelete(target);
        }}
      />
    </DashboardLayout>
  );
}
