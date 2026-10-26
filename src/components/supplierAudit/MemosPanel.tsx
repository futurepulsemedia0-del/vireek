import { useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { deleteMemo, saveMemo, type AuditData, type MemoRow } from '@/lib/supplierAudit/api';
import { formatMoney } from '@/lib/supplierAudit/money';
import { Card, Pill, btnGhost, btnPrimary, dollarsToCents, inputClass } from './shared';

const REASONS = ['rebate', 'patronage', 'co_op', 'price_adjustment', 'return', 'warranty', 'other'] as const;

export function MemosPanel({ data, reload }: { data: AuditData; reload: () => Promise<void> }) {
  const { toast } = useToast();
  const [f, setF] = useState({ vendor_id: '', memo_no: '', memo_date: '', amount: '', reason: 'other', program_id: '' });
  const [busy, setBusy] = useState(false);
  const name = (id: string) => data.vendors.find((v) => v.id === id)?.name ?? 'Supplier';
  const add = async () => {
    const amount = dollarsToCents(f.amount);
    if (!f.vendor_id || amount === null || amount <= 0) { toast('Choose a vendor and enter the memo amount (e.g. 250.00).', 'error'); return; }
    setBusy(true);
    try { await saveMemo(data.ownerId, { vendor_id: f.vendor_id, memo_no: f.memo_no.trim() || null, memo_date: f.memo_date || null, amount_cents: amount, reason: f.reason as MemoRow['reason'], program_id: f.program_id || null, confidence: 1, needs_review: false }); setF({ ...f, memo_no: '', amount: '', memo_date: '' }); await reload(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error'); } finally { setBusy(false); }
  };
  const setStatus = async (m: MemoRow, status: MemoRow['applied_status']) => {
    try { await saveMemo(data.ownerId, { id: m.id, vendor_id: m.vendor_id, amount_cents: m.amount_cents, applied_status: status, applied_cents: status === 'applied' ? m.amount_cents : status === 'unapplied' || status === 'void' ? 0 : m.applied_cents }); await reload(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not update', 'error'); }
  };
  return (
    <div className="space-y-5">
      <Card title="Add a credit memo">
        <div className="grid gap-3 sm:grid-cols-6">
          <select className={`${inputClass} sm:col-span-2`} value={f.vendor_id} onChange={(e) => setF({ ...f, vendor_id: e.target.value })} aria-label="Vendor"><option value="">Vendor…</option>{data.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
          <input className={inputClass} placeholder="Memo #" value={f.memo_no} onChange={(e) => setF({ ...f, memo_no: e.target.value })} />
          <input type="date" className={inputClass} value={f.memo_date} onChange={(e) => setF({ ...f, memo_date: e.target.value })} aria-label="Memo date" />
          <input className={inputClass} inputMode="decimal" placeholder="Amount $" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <select className={inputClass} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} aria-label="Reason">{REASONS.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}</select>
          <select className={`${inputClass} sm:col-span-4`} value={f.program_id} onChange={(e) => setF({ ...f, program_id: e.target.value })} aria-label="Linked program"><option value="">No linked program</option>{data.programRows.filter((p) => !f.vendor_id || p.vendor_id === f.vendor_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button type="button" className={`${btnPrimary} sm:col-span-2`} disabled={busy} onClick={add}><Plus size={16} /> Add memo</button>
        </div>
        <p className="mt-2 text-xs text-text-secondary">A memo marked “applied” stops being flagged. Link rebate memos to their program so received rebates are subtracted correctly.</p>
      </Card>
      <Card title="Credit memos">
        {data.memos.length === 0 ? <p className="text-sm text-text-secondary">No credit memos recorded.</p> : (
          <ul className="divide-y divide-border">{data.memos.slice().sort((a, b) => (b.memo_date ?? '').localeCompare(a.memo_date ?? '')).map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span><span className="font-medium text-text-primary">{name(m.vendor_id)} · {m.memo_no ?? '(no #)'}</span> <span className="text-text-secondary">{m.memo_date ?? 'no date'} · {formatMoney(m.amount_cents, m.currency)} · {m.reason.replace('_', ' ')}</span></span>
              <span className="flex items-center gap-2"><Pill cls={m.applied_status === 'applied' ? 'bg-success-500/10 text-success-500' : m.applied_status === 'void' ? 'bg-bg-tertiary text-text-secondary' : 'bg-warning-500/10 text-warning-500'}>{m.applied_status.replace('_', ' ')}</Pill>
                <select className={`${inputClass} w-auto`} aria-label="Change status" value={m.applied_status} onChange={(e) => setStatus(m, e.target.value as MemoRow['applied_status'])}><option value="unapplied">Unapplied</option><option value="applied">Applied</option><option value="void">Void</option></select>
                <button type="button" aria-label="Delete memo" className={btnGhost} onClick={async () => { if (!window.confirm('Delete this credit memo?')) return; try { await deleteMemo(m.id); await reload(); } catch (e) { toast(e instanceof Error ? e.message : 'Delete failed', 'error'); } }}><Trash2 size={14} /></button></span>
            </li>))}</ul>)}
      </Card>
    </div>
  );
}
