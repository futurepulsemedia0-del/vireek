import { useCallback, useEffect, useState } from 'react';
import { Receipt, Loader2, Plus, Send, CheckCircle2, Copy, Trash2, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { calculateQuoteTotals, formatCents, type QuoteLineItem } from '@/lib/invoices';
import { createInvoice, deleteInvoice, fetchInvoices, getInvoiceLink, isOverdue, markInvoicePaid, markInvoiceSent, type Invoice, type InvoiceStatus } from '@/lib/invoices';

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  sent: 'bg-cta/15 text-cta',
  viewed: 'bg-warning-500/15 text-warning-500',
  paid: 'bg-success-500/15 text-success-500',
  void: 'bg-bg-tertiary text-text-secondary line-through',
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
  const [taxPercent, setTaxPercent] = useState(0);
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const totals = calculateQuoteTotals(items, taxPercent);
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

      <button disabled={saving} onClick={submit}
        className="focus-ring mt-4 flex items-center gap-1.5 rounded-lg bg-cta px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create invoice
      </button>
    </div>
  );
}

export function InvoicesPage() {
  const { toast } = useToast();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
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

        {invoices.length === 0 && !showForm && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-sm text-text-secondary">
            No invoices yet. Create one to start billing customers with itemized, shareable invoices.
          </div>
        )}

        <div className="space-y-2">
          {invoices.map((inv) => {
            const totals = calculateQuoteTotals(inv.line_items, inv.tax_percent);
            const overdue = isOverdue(inv);
            return (
              <div key={inv.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{inv.invoice_number} · {inv.customer_name}</p>
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
