import { useMemo, useState } from 'react';
import { Upload, Trash2, Check, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { deleteStatement, refreshStatementStatus, updateLine, uploadStatement, type AuditData, type LineRow } from '@/lib/supplierAudit/api';
import { isYmd, parseMoneyToCents } from '@/lib/supplierAudit/money';
import { Card, Pill, btnGhost, btnPrimary, centsToDollars, inputClass } from './shared';
import { EmptyState } from '@/components/EmptyState';
import { FileSpreadsheet } from 'lucide-react';

const today = () => new Date().toISOString().slice(0, 10);
const STATUS_CLS: Record<string, string> = { pending: 'bg-bg-tertiary text-text-secondary', parsed: 'bg-success-500/10 text-success-500', reviewed: 'bg-success-500/10 text-success-500', needs_review: 'bg-warning-500/10 text-warning-500', failed: 'bg-danger/10 text-danger' };

function ReviewRow({ line, onDone }: { line: LineRow; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const [v, setV] = useState({ invoice_no: line.invoice_no ?? '', invoice_date: line.invoice_date ?? '', sku: line.sku ?? '', qty: line.qty === null ? '' : String(line.qty), unit: centsToDollars(line.unit_price_cents), ext: centsToDollars(line.extended_cents), is_credit: line.is_credit });
  const [busy, setBusy] = useState(false);
  const save = async (status: 'confirmed' | 'rejected') => {
    setBusy(true);
    try {
      if (status === 'confirmed') {
        const ext = parseMoneyToCents(v.ext); const unit = v.unit.trim() ? parseMoneyToCents(v.unit) : null;
        if (ext === null || ext < 0) throw new Error('Enter the line amount as a plain number (e.g. 125.50) — it is never guessed.');
        if (v.unit.trim() && (unit === null || unit < 0)) throw new Error('Unit price is not a valid number.');
        if (!isYmd(v.invoice_date)) throw new Error('Enter the invoice date as YYYY-MM-DD.');
        const qty = v.qty.trim() ? Number(v.qty) : null;
        if (qty !== null && (!Number.isFinite(qty) || qty < 0)) throw new Error('Quantity is not valid.');
        await updateLine(line.id, { invoice_no: v.invoice_no.trim() || null, invoice_date: v.invoice_date, sku: v.sku.trim() || null, qty, unit_price_cents: unit, extended_cents: ext, is_credit: v.is_credit, review_status: 'confirmed' });
      } else await updateLine(line.id, { review_status: 'rejected' });
      await refreshStatementStatus(line.statement_id); await onDone();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error'); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof v, val: string | boolean) => setV((p) => ({ ...p, [k]: val }));
  return (
    <li className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>Line {line.line_no}</span><Pill cls="bg-warning-500/10 text-warning-500">{Math.round(line.confidence * 100)}% confidence</Pill></div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <input className={inputClass} aria-label="Invoice number" placeholder="Invoice #" value={v.invoice_no} onChange={(e) => set('invoice_no', e.target.value)} />
        <input className={inputClass} aria-label="Date" type="date" value={v.invoice_date} onChange={(e) => set('invoice_date', e.target.value)} />
        <input className={inputClass} aria-label="SKU" placeholder="SKU" value={v.sku} onChange={(e) => set('sku', e.target.value)} />
        <input className={inputClass} aria-label="Quantity" inputMode="decimal" placeholder="Qty" value={v.qty} onChange={(e) => set('qty', e.target.value)} />
        <input className={inputClass} aria-label="Unit price" inputMode="decimal" placeholder="Unit $" value={v.unit} onChange={(e) => set('unit', e.target.value)} />
        <input className={inputClass} aria-label="Amount" inputMode="decimal" placeholder="Amount $" value={v.ext} onChange={(e) => set('ext', e.target.value)} />
      </div>
      {line.description && <p className="mt-2 truncate text-xs text-text-secondary">{line.description}</p>}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-text-secondary"><input type="checkbox" checked={v.is_credit} onChange={(e) => set('is_credit', e.target.checked)} /> Credit / return</label>
        <div className="flex gap-2"><button type="button" className={btnGhost} disabled={busy} onClick={() => save('rejected')}><X size={14} /> Reject</button><button type="button" className={btnPrimary} disabled={busy} onClick={() => save('confirmed')}><Check size={14} /> Confirm</button></div>
      </div>
    </li>
  );
}

export function StatementsPanel({ data, reload }: { data: AuditData; reload: () => Promise<void> }) {
  const { toast } = useToast();
  const [vendorId, setVendorId] = useState('');
  const [start, setStart] = useState(`${new Date().getFullYear()}-01-01`);
  const [end, setEnd] = useState(today());
  const [currency, setCurrency] = useState('USD');
  const [dateOrder, setDateOrder] = useState<'mdy' | 'dmy'>('mdy');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const vendorName = (id: string) => data.vendors.find((v) => v.id === id)?.name ?? 'Supplier';
  const queue = useMemo(() => data.lineRows.filter((l) => l.review_status === 'needs_review').slice(0, 40), [data.lineRows]);
  const queueTotal = data.lineRows.filter((l) => l.review_status === 'needs_review').length;

  const submit = async () => {
    if (!file || !vendorId) return;
    if (end < start) { toast('The end date is before the start date.', 'error'); return; }
    setBusy(true);
    try {
      const r = await uploadStatement({ file, vendorId, periodStart: start, periodEnd: end, currency: currency.toUpperCase(), dateOrder }, data.ownerId);
      if (r.duplicate) toast('This exact file was already uploaded — nothing was added.', 'info');
      else toast(`${r.lines} lines read${r.needsReview ? `, ${r.needsReview} need your review` : ''}.`, 'success');
      setFile(null); await reload();
    } catch (e) { toast(e instanceof Error ? e.message : 'Upload failed', 'error'); await reload(); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <Card title="Upload a statement or invoice">
        {data.vendors.length === 0 ? <p className="text-sm text-text-secondary">Add a vendor in Vendor Management first.</p> : (
          <div className="grid gap-3 sm:grid-cols-6">
            <select className={`${inputClass} sm:col-span-2`} value={vendorId} onChange={(e) => setVendorId(e.target.value)} aria-label="Vendor"><option value="">Choose vendor…</option>{data.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
            <input type="date" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} aria-label="Period start" />
            <input type="date" className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} aria-label="Period end" />
            <input className={inputClass} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} aria-label="Currency" />
            <select className={inputClass} value={dateOrder} onChange={(e) => setDateOrder(e.target.value as 'mdy' | 'dmy')} aria-label="Date order"><option value="mdy">MM/DD/YYYY</option><option value="dmy">DD/MM/YYYY</option></select>
            <input type="file" accept=".pdf,.csv,.tsv,.xlsx,.jpg,.jpeg,.png" className={`${inputClass} sm:col-span-4`} onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Statement file" />
            <button type="button" className={`${btnPrimary} sm:col-span-2`} disabled={busy || !file || !vendorId} onClick={submit}><Upload size={16} />{busy ? 'Reading…' : 'Upload & read'}</button>
            <p className="text-xs text-text-secondary sm:col-span-6">CSV/Excel are read on your device. PDFs are read by an AI reader: every field gets a confidence, and anything unsure goes to the review queue below — nothing is guessed.</p>
          </div>)}
      </Card>

      <Card title={`Review queue (${queueTotal})`}>
        {queueTotal === 0 ? <p className="text-sm text-text-secondary">Nothing waiting. Lines the reader was unsure about appear here and are excluded from every number until you confirm them.</p> : (
          <><p className="mb-3 text-xs text-text-secondary">These lines are NOT counted in any finding until you confirm them.{queueTotal > queue.length ? ` Showing the first ${queue.length}.` : ''}</p>
            <ul className="space-y-3">{queue.map((l) => <ReviewRow key={l.id} line={l} onDone={reload} />)}</ul></>)}
      </Card>

      <Card title="Statements">
        {data.statements.length === 0 ? <EmptyState icon={FileSpreadsheet} title="No statements yet" description="Upload a monthly statement to start the audit." /> : (
          <ul className="divide-y divide-border">{data.statements.slice().sort((a, b) => b.period_end.localeCompare(a.period_end)).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-0"><span className="font-medium text-text-primary">{vendorName(s.vendor_id)}</span> <span className="text-text-secondary">{s.period_start} → {s.period_end} · {s.line_count} lines · {s.source_file_name ?? 'manual'}</span>{s.parse_error && <span className="block text-xs text-danger">{s.parse_error}</span>}</span>
              <span className="flex items-center gap-2"><Pill cls={STATUS_CLS[s.parse_status] ?? STATUS_CLS.pending}>{s.parse_status.replace('_', ' ')}</Pill>
                <button type="button" aria-label="Delete statement" className={btnGhost} onClick={async () => { if (!window.confirm('Delete this statement and its lines? Findings based on it will update on the next run.')) return; try { await deleteStatement(s.id); await reload(); } catch (e) { toast(e instanceof Error ? e.message : 'Delete failed', 'error'); } }}><Trash2 size={14} /></button></span>
            </li>))}</ul>)}
      </Card>
    </div>
  );
}
