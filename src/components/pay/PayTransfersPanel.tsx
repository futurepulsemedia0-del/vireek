// Owner/admin: technician payout ledger + pay-run settlement (what to actually disburse).
import { useCallback, useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { Pill } from '@/components/pay/PayShared';
import { fetchSettlement, listFinalPayRuns, listTransfers, recordAdvanceRecovery } from '@/lib/payApi';
import { formatCents, transferKindLabel, transferStatusInfo, type SettlementRow, type TransferRow } from '@/lib/pay';

type Run = Awaited<ReturnType<typeof listFinalPayRuns>>[number];

export function PayTransfersPanel() {
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<string>('');
  const [rows, setRows] = useState<SettlementRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [t, r] = await Promise.all([listTransfers(50), listFinalPayRuns()]);
      setTransfers(t); setRuns(r); setRunId((cur) => cur || r[0]?.id || '');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (runId) fetchSettlement(runId).then(setRows).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the settlement.')); }, [runId]);

  async function record() {
    setBusy(true); setError(null); setInfo(null);
    try { const c = await recordAdvanceRecovery(runId); setInfo(`Recorded ${formatCents(c)} of advance recoveries.`); setRows(await fetchSettlement(runId)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not record.'); }
    finally { setBusy(false); }
  }

  const totalDue = rows.reduce((s, r) => s + r.disbursement_due_cents, 0);
  const anyRecovery = rows.some((r) => r.recommended_recovery_cents > 0);

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {info && <p role="status" className="text-sm text-text-primary">{info}</p>}

      <section className="rounded-xl border border-border bg-bg-secondary p-4">
        <h3 className="text-sm font-semibold text-text-primary">Pay-run settlement</h3>
        <p className="mt-1 text-xs text-text-secondary">Net pay minus instant payouts already sent minus advances to recover = what you still need to disburse. Skip anyone already paid in full.</p>
        {runs.length === 0 ? <p className="mt-3 text-sm text-text-secondary">Approve a pay run in Payroll to see its settlement.</p> : (
          <>
            <label className="mt-3 block text-xs text-text-secondary">Pay run
              <select className="focus-ring mt-1 block w-full rounded-xl border border-border bg-bg-primary p-2 text-sm text-text-primary" value={runId} onChange={(e) => setRunId(e.target.value)}>
                {runs.map((r) => <option key={r.id} value={r.id}>{r.pay_period_start} → {r.pay_period_end} · pay {r.pay_date} ({r.status})</option>)}
              </select>
            </label>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <thead className="text-xs text-text-secondary"><tr><th className="py-1">Employee</th><th>Net pay</th><th>Paid instantly</th><th>Advances to recover</th><th className="text-right">Disburse</th></tr></thead>
                <tbody className="divide-y divide-border text-text-primary">
                  {rows.map((r) => (
                    <tr key={r.item_id}><td className="py-2">{r.employee_name}</td><td>{formatCents(r.net_pay_cents)}</td><td>{formatCents(r.instant_paid_cents)}</td><td>{formatCents(r.recommended_recovery_cents)}</td><td className="text-right font-semibold">{formatCents(r.disbursement_due_cents)}</td></tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={4} className="pt-2 text-xs text-text-secondary">Total still to disburse</td><td className="pt-2 text-right font-semibold text-text-primary">{formatCents(totalDue)}</td></tr></tfoot>
              </table>
            </div>
            {anyRecovery && <Button className="mt-3" variant="secondary" disabled={busy} onClick={record}>{busy ? 'Recording…' : 'Record advance recoveries for this run'}</Button>}
            {anyRecovery && <p className="mt-2 text-xs text-text-secondary">Recording marks the advances as repaid in the ledger. The deduction itself happens when you disburse the amounts above.</p>}
          </>
        )}
      </section>

      {transfers.length === 0 ? <EmptyState icon={Wallet} title="No payouts yet" description="Instant payouts and earned-wage advances requested by your technicians appear here." /> : (
        <section className="rounded-xl border border-border bg-bg-secondary p-4">
          <h3 className="text-sm font-semibold text-text-primary">Technician transfers</h3>
          <ul className="mt-2 divide-y divide-border text-sm">
            {transfers.map((t) => { const s = transferStatusInfo(t.status); return (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                <div><p className="text-text-primary">{t.holder_name ?? 'Technician'} · {transferKindLabel(t.kind)}{t.sandbox ? ' (sandbox)' : ''}</p>
                  <p className="text-xs text-text-secondary">{new Date(t.created_at).toLocaleString()} · {formatCents(t.amount_cents)} (fee {formatCents(t.fee_cents)})</p></div>
                <Pill tone={s.tone}>{s.label}</Pill>
              </li>); })}
          </ul>
        </section>
      )}
    </div>
  );
}
