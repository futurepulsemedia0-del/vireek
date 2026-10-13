import { useCallback, useEffect, useMemo, useState } from 'react';
import { Receipt, Loader2, Plus, Send, CheckCircle2, Copy, Trash2, X, Search } from 'lucide-react';
import { SavedViewsBar, type AppliedViewExtras } from '@/components/SavedViewsBar';
import { SortSelect, type SortOption } from '@/components/SortSelect';
import { coerceSort, sortRows, type SortValue, type ViewSort } from '@/lib/viewSort';
import { Receipt, Loader2, Plus, Send, CheckCircle2, Copy, Trash2, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { calculateQuoteTotals, formatCents, type QuoteLineItem } from '@/lib/invoices';
import { SalesTaxPanel } from '@/components/tax/SalesTaxPanel';
import { TaxClassSelect } from '@/components/tax/TaxClassSelect';
import { emptyTaxSelection, getDocumentTotals, taxColumnsFromSelection } from '@/lib/salesTax';
import { createInvoice, deleteInvoice, fetchInvoices, getInvoiceLink, isOverdue, markInvoicePaid, markInvoiceSent, type Invoice, type InvoiceStatus } from '@/lib/invoices';
import { useBulkTable } from '@/hooks/useBulkTable';
import { applyRowPatches } from '@/lib/bulk/engine';
import { PromoCodePanel } from '@/components/promos/PromoCodePanel';

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  sent: 'bg-cta/15 text-cta',
  viewed: 'bg-warning-500/15 text-warning-500',
  paid: 'bg-success-500/15 text-success-500',
  void: 'bg-bg-tertiary text-text-secondary line-through',
};

const STATUS_FILTERS = ['all', 'draft', 'sent', 'viewed', 'paid', 'void', 'overdue'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const INVOICE_SORT_OPTIONS: SortOption[] = [
  { key: 'created_at', label: 'Date created', defaultDir: 'desc' },
  { key: 'due_date', label: 'Due date' },
  { key: 'customer_name', label: 'Customer' },
  { key: 'total', label: 'Total', defaultDir: 'desc' },
];
const INVOICE_SORT_ACCESSORS: Record<string, (i: Invoice) => SortValue> = {
  created_at: (i) => new Date(i.created_at).getTime(),
  due_date: (i) => (i.due_date ? new Date(i.due_date).getTime() : null),
  customer_name: (i) => i.customer_name,
  total: (i) => calculateQuoteTotals(i.line_items, i.tax_percent).totalCents,
};
function emptyLineItem(): QuoteLineItem {
  return { description: '', quantity: 1, unit_price_cents: 0 };
}

function InvoiceForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast();
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [items, setItems] = useState<QuoteLineItem[]>([emptyLineItem()]);
  const [tax, setTax] = useState(emptyTaxSelection());
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const subtotalCents = calculateQuoteTotals(items, 0).subtotalCents;
  const taxCents = tax.mode === 'auto' ? tax.calculation?.taxCents ?? 0 : Math.round((subtotalCents * tax.manualPercent) / 100);
  const totals = { totalCents: subtotalCents + taxCents };
  const updateItem = (i: number, patch: Partial<QuoteLineItem>) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  const submit = async () => {
    if (!customerName.trim()) { toast('Customer name is required.', 'error'); return; }
    const cleanItems = items.filter((it) => it.description.trim());
    if (cleanItems.length === 0) { toast('Add at least one line item.', 'error'); return; }
    setSaving(true);
    try {
      await createInvoice({
        customer_name: customerName.trim(),
        customer_email: customerEmail.trim() || undefined,
        customer_phone: customerPhone.trim() || undefined,
        line_items: cleanItems,
        tax_percent: taxPercent,
        due_date: dueDate || undefined,
        notes: notes.trim() || undefined,
      });
      toast('Invoice created.', 'success');
      onCreated();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the invoice.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-text-primary">New invoice</p>
        <button onClick={onClose} className="focus-ring rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary"><X size={16} /></button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-text-secondary">
          Customer name
          <input value={customerName} onChange={(e) => setCustomerName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
        </label>
        <label className="text-xs text-text-secondary">
          Email (optional)
          <input value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
        </label>
        <label className="text-xs text-text-secondary">
          Phone (optional)
          <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
        </label>
      </div>

      <div className="mt-4 space-y-2">
        <p className="text-xs text-text-secondary">Line items</p>
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-[1fr_70px_100px_28px] gap-2">
            <input value={it.description} onChange={(e) => updateItem(i, { description: e.target.value })} placeholder="Description"
              className="rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary" />
            <input type="number" min={1} value={it.quantity} onChange={(e) => updateItem(i, { quantity: Number(e.target.value) || 1 })}
              className="rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary" />
            <input type="number" min={0} step="0.01" value={(it.unit_price_cents / 100).toString()}
              onChange={(e) => updateItem(i, { unit_price_cents: Math.round(Number(e.target.value || 0) * 100) })} placeholder="$"
              className="rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary" />
            <button onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}
              className="focus-ring rounded-lg text-text-secondary hover:bg-bg-tertiary"><Trash2 size={14} /></button>
          </div>
        ))}
        <button onClick={() => setItems((prev) => [...prev, emptyLineItem()])}
          className="focus-ring flex items-center gap-1 text-xs font-medium text-cta"><Plus size={12} /> Add line</button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-text-secondary">
          Tax %
          <input type="number" min={0} step="0.01" value={taxPercent} onChange={(e) => setTaxPercent(Number(e.target.value) || 0)}
            className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
        </label>
        <label className="text-xs text-text-secondary">
          Due date
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
        </label>
        <div className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
          <span className="text-xs text-text-secondary">Total: </span>{formatCents(totals.totalCents)}
        </div>
      </div>
      <label className="mt-3 block text-xs text-text-secondary">
        Notes (optional)
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
          className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
      </label>

      <button disabled={saving || tax.pending} onClick={submit}
        className="focus-ring mt-4 flex items-center gap-1.5 rounded-lg bg-cta px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create invoice
      </button>
    </div>
  );
}

export function InvoicesPage() {
  const { toast } = useToast();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [promoOpenId, setPromoOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInvoices(await fetchInvoices());
    } catch {
      toast('Could not load invoices.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<ViewSort | null>(null);

  const visibleInvoices = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = invoices.filter((inv) => {
      if (statusFilter === 'overdue' ? !isOverdue(inv) : statusFilter !== 'all' && inv.status !== statusFilter) return false;
      return (
        !q ||
        inv.invoice_number.toLowerCase().includes(q) ||
        inv.customer_name.toLowerCase().includes(q) ||
        (inv.customer_email?.toLowerCase().includes(q) ?? false)
      );
    });
    return sortRows(base, sort, INVOICE_SORT_ACCESSORS);
  }, [invoices, search, statusFilter, sort]);

  const currentFilters = { search, statusFilter };
  const applyView = (f: Record<string, unknown>, extras: AppliedViewExtras) => {
    setSearch(typeof f.search === 'string' ? f.search : '');
    setStatusFilter(STATUS_FILTERS.includes(f.statusFilter as StatusFilter) ? (f.statusFilter as StatusFilter) : 'all');
    setSort(coerceSort(extras.sort, INVOICE_SORT_OPTIONS.map((o) => o.key), null));
  };

  const send = async (inv: Invoice) => {
    setBusyId(inv.id);
    try {
      await markInvoiceSent(inv.id);
      await navigator.clipboard.writeText(getInvoiceLink(inv.invoice_token));
      toast('Marked as sent — link copied to clipboard.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send this invoice.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const pay = async (inv: Invoice) => {
    setBusyId(inv.id);
    try {
      await markInvoicePaid(inv.id, 'manual');
      toast('Marked as paid.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update this invoice.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteInvoice(id);
      toast('Invoice deleted.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete this invoice.', 'error');
    }
  };

  const copyLink = async (inv: Invoice) => {
    await navigator.clipboard.writeText(getInvoiceLink(inv.invoice_token));
    toast('Link copied.', 'success');
  };

  const bulk = useBulkTable<Invoice>({
    table: 'invoices',
    rows: invoices,
    noun: { singular: 'invoice', plural: 'invoices' },
    getLabel: (i) => `${i.invoice_number} · ${i.customer_name}`,
    exportFilename: 'invoices',
    exportColumns: [
      { header: 'Invoice #', accessor: (i) => i.invoice_number },
      { header: 'Customer', accessor: (i) => i.customer_name },
      { header: 'Email', accessor: (i) => i.customer_email },
      { header: 'Status', accessor: (i) => i.status },
      { header: 'Total', accessor: (i) => formatCents(calculateQuoteTotals(i.line_items, i.tax_percent).totalCents) },
      { header: 'Due date', accessor: (i) => i.due_date },
      { header: 'Paid at', accessor: (i) => i.paid_at },
      { header: 'Created', accessor: (i) => i.created_at },
    ],
    statusField: 'status',
    statusOptions: [
      { value: 'sent', label: 'Mark sent' },
      { value: 'paid', label: 'Mark paid', confirm: 'Mark the selected invoices as paid (manual payment)? This affects your revenue figures.' },
      { value: 'void', label: 'Void', confirm: 'Void the selected invoices? Voided invoices can no longer be paid.' },
    ],
    statusExtras: (v) =>
      v === 'sent'
        ? { sent_at: new Date().toISOString() }
        : v === 'paid'
          ? { paid_at: new Date().toISOString(), payment_method: 'manual' }
          : {},
    assignField: 'assigned_to',
    canDelete: (i) => (i.status === 'paid' ? 'Paid invoices are kept for your records.' : null),
    onRowsChanged: (u) => setInvoices((prev) => applyRowPatches(prev, u)),
    onRowsRemoved: (ids) => setInvoices((prev) => prev.filter((i) => !ids.includes(i.id))),
  });
  if (loading) {
    return <DashboardLayout activeLabel="Invoicing"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Invoicing">
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Receipt className="text-cta" size={20} />
            <p className="text-sm font-semibold text-text-primary">Invoicing</p>
          </div>
          <button onClick={() => setShowForm((v) => !v)}
            className="focus-ring flex items-center gap-1.5 rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta">
            <Plus size={14} /> New invoice
          </button>
        </div>

        {showForm && <InvoiceForm onClose={() => setShowForm(false)} onCreated={load} />}
                {invoices.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search invoices…"
                aria-label="Search invoices"
                className="focus-ring w-full rounded-xl border border-border bg-bg-secondary py-2.5 pl-10 pr-4 text-sm text-text-primary placeholder:text-text-secondary/60"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              aria-label="Filter by status"
              className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary"
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>{s === 'all' ? 'All statuses' : s.charAt(0).toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
            <SortSelect value={sort} options={INVOICE_SORT_OPTIONS} onChange={setSort} />
            <SavedViewsBar page="invoices" currentFilters={currentFilters} currentSort={sort} onApply={applyView} />
          </div>
        )}
        {invoices.length > 0 && visibleInvoices.length === 0 && (
          <p className="text-center text-sm text-text-secondary">Nothing matches these filters.</p>
        )}

        {invoices.length === 0 && !showForm && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-sm text-text-secondary">
            No invoices yet. Create one to start billing customers with itemized, shareable invoices.
          </div>
        )}

        <div className="space-y-2">
          {visibleInvoices.map((inv) => {
            const totals = getDocumentTotals(inv);
            const overdue = isOverdue(inv);
            return (
              <div key={inv.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="flex items-center gap-2.5 text-sm font-semibold text-text-primary">
                      {bulk.rowCheckbox(inv.id, inv.invoice_number)}
                      {inv.invoice_number} · {inv.customer_name}
                    </p>
                    <p className="text-xs text-text-secondary">
                      {formatCents(totals.totalCents)}
                      {inv.due_date && ` · due ${new Date(inv.due_date).toLocaleDateString()}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${overdue ? 'bg-danger-500/15 text-danger-500' : STATUS_STYLES[inv.status]}`}>
                      {overdue ? 'overdue' : inv.status}
                    </span>
                    {inv.status !== 'paid' && inv.status !== 'void' && (
                      <>
                        {inv.status === 'draft' && (
                          <button disabled={busyId === inv.id} onClick={() => send(inv)}
                            className="focus-ring flex items-center gap-1 rounded-lg bg-cta/15 px-2.5 py-1 text-xs font-medium text-cta disabled:opacity-50">
                            <Send size={12} /> Send
                          </button>
                        )}
                        {inv.status !== 'draft' && (
                          <button onClick={() => copyLink(inv)} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary"><Copy size={14} /></button>
                        )}
                        <button disabled={busyId === inv.id} onClick={() => pay(inv)}
                          className="focus-ring flex items-center gap-1 rounded-lg bg-success-500/15 px-2.5 py-1 text-xs font-medium text-success-500 disabled:opacity-50">
                          <CheckCircle2 size={12} /> Mark paid
                        </button>
                      </>
                    )}
                    <button onClick={() => remove(inv.id)} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary"><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </DashboardLayout>
  );
}
