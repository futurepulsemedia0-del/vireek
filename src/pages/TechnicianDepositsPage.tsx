import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Landmark, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import {
  DepositOverview, createDepositBatch, describePaymentError, fetchDepositOverview, formatCents, summarizeSelection,
} from '@/lib/inPersonPayments';

const today = () => new Date().toISOString().slice(0, 10);

export function TechnicianDepositsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<DepositOverview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [date, setDate] = useState(today());
  const [bankRef, setBankRef] = useState('');
  const [slip, setSlip] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try { setData(await fetchDepositOverview()); setSelected(new Set()); } catch { setLoadError(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const chosen = useMemo(() => (data?.undeposited ?? []).filter((p) => selected.has(p.id)), [data, selected]);
  const totals = summarizeSelection(chosen);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function submit() {
    setError(null); setSuccess(null);
    setBusy(true);
    try {
      const res = await createDepositBatch({ paymentIds: [...selected], depositedAt: date, bankReference: bankRef, slipNumber: slip, notes });
      if (!res.success) { setError(describePaymentError(res.error)); return; }
      setSuccess(`Deposit of ${formatCents((res.cash_cents ?? 0) + (res.check_cents ?? 0))} recorded.`);
      setBankRef(''); setSlip(''); setNotes('');
      await load();
    } catch {
      setError('Network problem. Nothing was saved — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg-primary pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-bg-primary/95 px-4 py-4 backdrop-blur">
        <button onClick={() => navigate('/tech/today')} aria-label="Back"><ArrowLeft className="h-5 w-5" /></button>
        <h1 className="text-lg font-semibold text-text-primary">Deposits</h1>
      </header>
      <main className="mx-auto max-w-lg space-y-4 px-4 py-4">
        {loadError && <EmptyStateError icon={AlertTriangle} onRetry={load} />}
        {!loadError && !data && <SkeletonCardList count={3} rows={2} />}
        {data && data.undeposited.length === 0 && (
          <EmptyState icon={Landmark} title="Nothing to deposit" description="Cash and checks you record will appear here until they are deposited." />
        )}

        {data && data.undeposited.length > 0 && (
          <section className="rounded-lg border border-border bg-bg-secondary p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">Undeposited ({data.undeposited.length})</h2>
              <button className="text-xs font-medium text-accent" onClick={() => setSelected(selected.size === data.undeposited.length ? new Set() : new Set(data.undeposited.map((p) => p.id)))}>
                {selected.size === data.undeposited.length ? 'Clear' : 'Select all'}
              </button>
            </div>
            <ul className="divide-y divide-border">
              {data.undeposited.map((p) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-3 py-2">
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="h-5 w-5" />
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="block truncate font-medium text-text-primary">{p.customer_name}</span>
                      <span className="block truncate text-xs text-text-secondary">
                        {p.method === 'check' ? `Check #${p.check_number}${p.check_bank ? ` · ${p.check_bank}` : ''}` : 'Cash'} · {new Date(p.received_at).toLocaleDateString()}
                      </span>
                    </span>
                    <span className="text-sm font-semibold text-text-primary">{formatCents(p.amount_cents)}</span>
                  </label>
                </li>
              ))}
            </ul>

            <div className="mt-3 space-y-3 border-t border-border pt-3">
              <p className="text-sm text-text-secondary" aria-live="polite">
                {totals.count} selected · Cash {formatCents(totals.cashCents)} · Checks {formatCents(totals.checkCents)} · <strong className="text-text-primary">Total {formatCents(totals.totalCents)}</strong>
              </p>
              <Input label="Deposit date" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} />
              <Input label="Bank / reference (optional)" value={bankRef} onChange={(e) => setBankRef(e.target.value)} maxLength={80} />
              <Input label="Deposit slip # (optional)" value={slip} onChange={(e) => setSlip(e.target.value)} maxLength={40} />
              <Textarea label="Notes (optional)" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
              <Button className="w-full" disabled={busy || selected.size === 0} onClick={submit}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Mark {totals.count || ''} as deposited
              </Button>
            </div>
          </section>
        )}
        {success && <p role="status" className="text-sm font-medium text-success-500">{success}</p>}

        {data && data.batches.length > 0 && (
          <section className="rounded-lg border border-border bg-bg-secondary p-3">
            <h2 className="mb-2 text-sm font-semibold text-text-primary">Recent deposits</h2>
            <ul className="divide-y divide-border">
              {data.batches.map((b) => (
                <li key={b.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block text-text-primary">{new Date(`${b.deposited_at}T12:00:00`).toLocaleDateString()} · {b.payment_count} item{b.payment_count === 1 ? '' : 's'}</span>
                    <span className="block truncate text-xs text-text-secondary">{[b.deposit_slip_number && `Slip ${b.deposit_slip_number}`, b.bank_reference].filter(Boolean).join(' · ') || 'No reference'}</span>
                  </span>
                  <span className="font-semibold text-text-primary">{formatCents(b.cash_cents + b.check_cents)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
