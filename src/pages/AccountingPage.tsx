import { useEffect, useState, useCallback, useMemo } from 'react';
import { BookOpen, RefreshCw, Plus, CheckCircle2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { supabase } from '@/lib/supabase';
import {
  ensureChartOfAccounts,
  fetchChartOfAccounts,
  fetchArInvoices,
  fetchApBills,
  createArInvoice,
  recordArPayment,
  createApBill,
  recordApBillPayment,
  fetchProfitAndLoss,
  fetchBalanceSheet,
  fetchArAging,
  fetchApAging,
  formatCents,
  type ChartOfAccount,
  type ArInvoice,
  type ApBill,
  type ProfitAndLossRow,
  type BalanceSheetRow,
  type AgingRow,
} from '@/lib/accounting';

type Tab = 'overview' | 'invoices' | 'bills' | 'reports';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'invoices', label: 'Invoices (AR)' },
  { id: 'bills', label: 'Bills (AP)' },
  { id: 'reports', label: 'Reports' },
];

const STATUS_COLORS: Record<string, string> = {
  paid: 'bg-emerald-100 text-emerald-700',
  partially_paid: 'bg-blue-100 text-blue-700',
  sent: 'bg-amber-100 text-amber-700',
  approved: 'bg-amber-100 text-amber-700',
  overdue: 'bg-red-100 text-red-700',
  draft: 'bg-slate-100 text-slate-600',
  void: 'bg-slate-100 text-slate-400',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_COLORS[status] ?? 'bg-slate-100 text-slate-600'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function QuickInvoiceForm({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState(() => new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.from('customers').select('id, name').order('name').limit(200).then(({ data }) => setCustomers(data ?? []));
  }, []);

  const handleSubmit = async () => {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!description.trim() || !cents || cents <= 0) {
      toast('Enter a description and a positive amount.', 'error');
      return;
    }
    setSaving(true);
    try {
      await createArInvoice({
        customerId: customerId || null,
        jobId: null,
        quoteId: null,
        dueDate,
        taxCents: 0,
        lines: [{ description, amountCents: cents }],
      });
      toast('Invoice posted to AR and the ledger.', 'success');
      setDescription('');
      setAmount('');
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create invoice.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-6 grid gap-3 p-4 sm:grid-cols-5">
      <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm">
        <option value="">No customer on file</option>
        {customers.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm sm:col-span-2" />
      <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount $" type="number" step="0.01" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm" />
      <input value={dueDate} onChange={(e) => setDueDate(e.target.value)} type="date" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm" />
      <button type="button" onClick={handleSubmit} disabled={saving} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 sm:col-span-5">
        <Plus size={14} /> Post invoice
      </button>
    </Card>
  );
}

function QuickBillForm({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [vendorId, setVendorId] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState(() => new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.from('vendors').select('id, name').order('name').limit(200).then(({ data }) => setVendors(data ?? []));
  }, []);

  const handleSubmit = async () => {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!description.trim() || !cents || cents <= 0) {
      toast('Enter a description and a positive amount.', 'error');
      return;
    }
    setSaving(true);
    try {
      await createApBill({
        vendorId: vendorId || null,
        purchaseOrderId: null,
        dueDate,
        taxCents: 0,
        lines: [{ description, amountCents: cents }],
      });
      toast('Bill posted to AP and the ledger.', 'success');
      setDescription('');
      setAmount('');
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create bill.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-6 grid gap-3 p-4 sm:grid-cols-5">
      <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm">
        <option value="">No vendor on file</option>
        {vendors.map((v) => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
      </select>
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm sm:col-span-2" />
      <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount $" type="number" step="0.01" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm" />
      <input value={dueDate} onChange={(e) => setDueDate(e.target.value)} type="date" className="rounded-lg border border-border-primary bg-bg-primary px-2 py-1.5 text-sm" />
      <button type="button" onClick={handleSubmit} disabled={saving} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 sm:col-span-5">
        <Plus size={14} /> Post bill
      </button>
    </Card>
  );
}

function PaymentRow({ label, balanceCents, onPay }: { label: string; balanceCents: number; onPay: (cents: number) => Promise<void> }) {
  const [amount, setAmount] = useState(() => (balanceCents / 100).toFixed(2));
  const [paying, setPaying] = useState(false);
  if (balanceCents <= 0) return null;
  return (
    <div className="mt-2 flex items-center gap-2">
      <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" step="0.01" className="w-24 rounded-lg border border-border-primary bg-bg-primary px-2 py-1 text-xs" />
      <button
        type="button"
        disabled={paying}
        onClick={async () => {
          setPaying(true);
          try {
            await onPay(Math.round(parseFloat(amount) * 100));
          } finally {
            setPaying(false);
          }
        }}
        className="inline-flex items-center gap-1 rounded-lg border border-border-primary px-2 py-1 text-xs font-medium text-text-primary hover:bg-bg-secondary disabled:opacity-50"
      >
        <CheckCircle2 size={12} /> {label}
      </button>
    </div>
  );
}

export function AccountingPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<ChartOfAccount[]>([]);
  const [invoices, setInvoices] = useState<ArInvoice[]>([]);
  const [bills, setBills] = useState<ApBill[]>([]);
  const [pnl, setPnl] = useState<ProfitAndLossRow[]>([]);
  const [balanceSheet, setBalanceSheet] = useState<BalanceSheetRow[]>([]);
  const [arAging, setArAging] = useState<AgingRow[]>([]);
  const [apAging, setApAging] = useState<AgingRow[]>([]);
  const [reportView, setReportView] = useState<'pnl' | 'balance_sheet' | 'ar_aging' | 'ap_aging'>('pnl');

  const load = useCallback(async () => {
    try {
      await ensureChartOfAccounts();
      const monthStart = new Date();
      monthStart.setDate(1);
      const [acc, inv, bl, pl, bs, ara, apa] = await Promise.all([
        fetchChartOfAccounts(),
        fetchArInvoices(),
        fetchApBills(),
        fetchProfitAndLoss(monthStart.toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)),
        fetchBalanceSheet(),
        fetchArAging(),
        fetchApAging(),
      ]);
      setAccounts(acc);
      setInvoices(inv);
      setBills(bl);
      setPnl(pl);
      setBalanceSheet(bs);
      setArAging(ara);
      setApAging(apa);
    } catch {
      toast('Could not load the books.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = useMemo(() => {
    const arOutstanding = invoices.reduce((s, i) => s + (i.total_cents - i.amount_paid_cents), 0);
    const apOutstanding = bills.reduce((s, b) => s + (b.total_cents - b.amount_paid_cents), 0);
    const revenue = pnl.filter((r) => r.type === 'revenue').reduce((s, r) => s + r.amount_cents, 0);
    const expense = pnl.filter((r) => r.type === 'expense').reduce((s, r) => s + r.amount_cents, 0);
    return { arOutstanding, apOutstanding, netIncome: revenue - expense, revenue, expense };
  }, [invoices, bills, pnl]);

  if (loading) {
    return (
      <DashboardLayout activeLabel="Accounting">
        <p className="text-sm text-text-secondary">Loading...</p>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Accounting">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <BookOpen size={22} /> Accounting
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Real double-entry books: chart of accounts, general ledger, Accounts Receivable, Accounts Payable, and
            financial statements — every invoice and bill posts a balanced journal entry automatically.
          </p>
        </div>
        <button type="button" onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-border-primary bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-secondary">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <div className="mb-6 flex gap-1 border-b border-border-primary">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? 'border-brand-500 text-brand-600' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <Card className="p-4">
              <p className="text-xs text-text-secondary">AR outstanding</p>
              <p className="mt-1 text-2xl font-bold text-text-primary">{formatCents(totals.arOutstanding)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-text-secondary">AP outstanding</p>
              <p className="mt-1 text-2xl font-bold text-text-primary">{formatCents(totals.apOutstanding)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-text-secondary">Net income (month to date)</p>
              <p className={`mt-1 text-2xl font-bold ${totals.netIncome >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatCents(totals.netIncome)}</p>
            </Card>
          </div>
          <Card className="p-0">
            <div className="border-b border-border-primary px-4 py-3">
              <p className="text-sm font-semibold text-text-primary">Chart of accounts</p>
            </div>
            <div className="divide-y divide-border-primary">
              {accounts.map((a) => (
                <div key={a.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-text-secondary">{a.code}</span>
                  <span className="flex-1 px-3 text-text-primary">{a.name}</span>
                  <span className="text-xs capitalize text-text-secondary">{a.type}</span>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      {tab === 'invoices' && (
        <>
          <QuickInvoiceForm onCreated={load} />
          {invoices.length === 0 ? (
            <EmptyState icon={BookOpen} title="No invoices yet" description="Post your first invoice above — it lands in AR and the general ledger at the same time." />
          ) : (
            <Card className="p-0">
              {invoices.map((inv) => (
                <div key={inv.id} className="border-b border-border-primary px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-text-primary">{inv.invoice_number}</p>
                      <p className="text-xs text-text-secondary">Due {inv.due_date}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={inv.status} />
                      <span className="text-sm font-semibold text-text-primary">{formatCents(inv.total_cents)}</span>
                    </div>
                  </div>
                  <PaymentRow
                    label="Record payment"
                    balanceCents={inv.total_cents - inv.amount_paid_cents}
                    onPay={async (cents) => {
                      try {
                        await recordArPayment({ invoiceId: inv.id, amountCents: cents, paymentMethod: 'card' });
                        toast('Payment posted.', 'success');
                        load();
                      } catch (e) {
                        toast(e instanceof Error ? e.message : 'Could not record payment.', 'error');
                      }
                    }}
                  />
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      {tab === 'bills' && (
        <>
          <QuickBillForm onCreated={load} />
          {bills.length === 0 ? (
            <EmptyState icon={BookOpen} title="No bills yet" description="Post a vendor bill above — it lands in AP and the general ledger at the same time." />
          ) : (
            <Card className="p-0">
              {bills.map((bill) => (
                <div key={bill.id} className="border-b border-border-primary px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-text-primary">{bill.bill_number}</p>
                      <p className="text-xs text-text-secondary">Due {bill.due_date}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={bill.status} />
                      <span className="text-sm font-semibold text-text-primary">{formatCents(bill.total_cents)}</span>
                    </div>
                  </div>
                  <PaymentRow
                    label="Pay bill"
                    balanceCents={bill.total_cents - bill.amount_paid_cents}
                    onPay={async (cents) => {
                      try {
                        await recordApBillPayment({ billId: bill.id, amountCents: cents, paymentMethod: 'ach' });
                        toast('Bill payment posted.', 'success');
                        load();
                      } catch (e) {
                        toast(e instanceof Error ? e.message : 'Could not record payment.', 'error');
                      }
                    }}
                  />
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      {tab === 'reports' && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {([
              ['pnl', 'Profit & Loss'],
              ['balance_sheet', 'Balance Sheet'],
              ['ar_aging', 'AR Aging'],
              ['ap_aging', 'AP Aging'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setReportView(id)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${reportView === id ? 'bg-brand-500 text-white' : 'bg-bg-secondary text-text-secondary hover:text-text-primary'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {reportView === 'pnl' && (
            <Card className="p-0">
              {pnl.map((r) => (
                <div key={r.account_code} className="flex justify-between border-b border-border-primary px-4 py-2 text-sm last:border-b-0">
                  <span className="text-text-primary">{r.account_name}</span>
                  <span className="font-medium text-text-primary">{formatCents(r.amount_cents)}</span>
                </div>
              ))}
              <div className="flex justify-between px-4 py-3 text-sm font-bold text-text-primary">
                <span>Net income</span>
                <span className={totals.netIncome >= 0 ? 'text-emerald-600' : 'text-red-600'}>{formatCents(totals.netIncome)}</span>
              </div>
            </Card>
          )}

          {reportView === 'balance_sheet' && (
            <Card className="p-0">
              {balanceSheet.map((r) => (
                <div key={r.account_code} className="flex justify-between border-b border-border-primary px-4 py-2 text-sm last:border-b-0">
                  <span className="text-text-primary">{r.account_name} <span className="text-xs text-text-secondary capitalize">({r.type})</span></span>
                  <span className="font-medium text-text-primary">{formatCents(r.balance_cents)}</span>
                </div>
              ))}
              {balanceSheet.length === 0 && <p className="px-4 py-6 text-sm text-text-secondary">No posted activity yet.</p>}
            </Card>
          )}

          {reportView === 'ar_aging' && (
            <Card className="p-0">
              {arAging.map((r) => (
                <div key={r.invoice_id} className="flex justify-between border-b border-border-primary px-4 py-2 text-sm last:border-b-0">
                  <span className="text-text-primary">{r.invoice_number} &middot; {r.customer_name}</span>
                  <span className="flex items-center gap-2">
                    <span className="rounded-full bg-bg-secondary px-2 py-0.5 text-[11px] text-text-secondary">{r.bucket}</span>
                    <span className="font-medium text-text-primary">{formatCents(r.balance_cents)}</span>
                  </span>
                </div>
              ))}
              {arAging.length === 0 && <p className="px-4 py-6 text-sm text-text-secondary">Nothing outstanding.</p>}
            </Card>
          )}

          {reportView === 'ap_aging' && (
            <Card className="p-0">
              {apAging.map((r) => (
                <div key={r.bill_id} className="flex justify-between border-b border-border-primary px-4 py-2 text-sm last:border-b-0">
                  <span className="text-text-primary">{r.bill_number} &middot; {r.vendor_name}</span>
                  <span className="flex items-center gap-2">
                    <span className="rounded-full bg-bg-secondary px-2 py-0.5 text-[11px] text-text-secondary">{r.bucket}</span>
                    <span className="font-medium text-text-primary">{formatCents(r.balance_cents)}</span>
                  </span>
                </div>
              ))}
              {apAging.length === 0 && <p className="px-4 py-6 text-sm text-text-secondary">Nothing outstanding.</p>}
            </Card>
          )}
        </>
      )}
    </DashboardLayout>
  );
}
