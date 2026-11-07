/** Staff — /staff/results-plan (wrapped in <StaffRoute>): margin per account, dispute queue, owner flags, integrity flags, pause. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import {
  currentMonth, formatMoney, staffFlags, staffOpenDisputes, staffOverview, staffPendingJobFlags, staffResolveDispute, staffResolveJobFlag, staffSetStatus,
  type StaffOverviewRow,
} from '@/lib/resultsPlanApi';
import { UNIT_COST_DEFAULTS, directCostPerVerifiedJob } from '../../supabase/functions/_shared/results-plan/unitEconomics';

export function StaffResultsPlanPage() {
  const { toast } = useToast();
  const [month, setMonth] = useState(currentMonth());
  const [rows, setRows] = useState<StaffOverviewRow[]>([]);
  const [disputes, setDisputes] = useState<Awaited<ReturnType<typeof staffOpenDisputes>>>([]);
  const [flags, setFlags] = useState<Awaited<ReturnType<typeof staffFlags>>>([]);
  const [jobFlags, setJobFlags] = useState<Awaited<ReturnType<typeof staffPendingJobFlags>>>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    try {
      const [o, d, f, j] = await Promise.all([staffOverview(month), staffOpenDisputes(), staffFlags(), staffPendingJobFlags()]);
      setRows(o); setDisputes(d); setFlags(f); setJobFlags(j);
    } catch { toast('Could not load Results Plan data.', 'error'); }
  }, [month, toast]);
  useEffect(() => { void load(); }, [load]);

  const direct = directCostPerVerifiedJob(UNIT_COST_DEFAULTS) * 100; // PLACEHOLDER cost model
  const margin = useMemo(() => rows.map((r) => {
    const revenue = r.billed_cents + r.base_fee_cents - r.credited_cents;
    const cost = Math.round(r.verified_jobs * direct + r.billed_cents * UNIT_COST_DEFAULTS.paymentPercentFee + r.verified_jobs * UNIT_COST_DEFAULTS.paymentFixedFee * 100);
    return { ...r, revenue, cost, pct: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) : null };
  }), [rows, direct]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); await load(); } catch { toast('Action failed.', 'error'); } finally { setBusy(null); }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6">
      <header className="space-y-2">
        <Link to="/staff" className="text-sm text-accent hover:underline">← Staff</Link>
        <h1 className="text-2xl font-bold text-text-primary">Results Plan (staff)</h1>
        <p className="text-sm text-text-secondary">Cost columns use PLACEHOLDER unit costs until calibrated from real data.</p>
        <label className="block text-sm text-text-primary">Month <input className="focus-ring ms-2 rounded-lg border border-border bg-bg-secondary px-2 py-1" value={month} onChange={(e: { target: { value: string } }) => setMonth(e.target.value)} inputMode="numeric" /></label>
      </header>

      <section aria-labelledby="s-margin"><h2 id="s-margin" className="mb-3 text-lg font-semibold text-text-primary">Margin per account</h2>
        <div className="overflow-x-auto"><table className="w-full text-start text-sm text-text-primary">
          <thead><tr className="text-text-secondary"><th className="p-2 text-start">Account</th><th className="p-2 text-start">Status</th><th className="p-2 text-end">Jobs</th><th className="p-2 text-end">Revenue</th><th className="p-2 text-end">Est. cost</th><th className="p-2 text-end">Margin</th><th className="p-2 text-end">Disputes</th><th className="p-2 text-end">High flags</th><th className="p-2"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{margin.map((r) => (
            <tr key={r.user_id} className="border-t border-border">
              <td className="p-2">{r.company_name ?? r.user_id.slice(0, 8)}</td><td className="p-2">{r.status}</td><td className="p-2 text-end">{r.verified_jobs}</td>
              <td className="p-2 text-end">{formatMoney(r.revenue)}</td><td className="p-2 text-end">{formatMoney(r.cost)}</td><td className="p-2 text-end">{r.pct === null ? '—' : `${r.pct}%`}</td>
              <td className="p-2 text-end">{r.open_disputes}</td><td className="p-2 text-end">{r.high_flags}</td>
              <td className="p-2 text-end">
                {r.status === 'paused'
                  ? <Button size="xs" variant="secondary" loading={busy === r.user_id} onClick={() => run(r.user_id, () => staffSetStatus(r.user_id, 'active', ''))}>Resume</Button>
                  : <Button size="xs" variant="danger" loading={busy === r.user_id} onClick={() => run(r.user_id, () => staffSetStatus(r.user_id, 'paused', 'Paused by Vireek staff for review'))}>Pause</Button>}
              </td>
            </tr>))}
            {margin.length === 0 && <tr><td className="p-2 text-text-secondary" colSpan={9}>No Results Plan accounts.</td></tr>}
          </tbody></table></div>
      </section>

      <section aria-labelledby="s-disputes" className="space-y-3"><h2 id="s-disputes" className="text-lg font-semibold text-text-primary">Dispute queue ({disputes.length})</h2>
        {disputes.map((d) => (
          <Card key={d.id} interactive={false} className="space-y-2 p-4">
            <p className="text-sm text-text-primary">{d.reason}</p>
            <p className="text-xs text-text-secondary">Account {d.user_id.slice(0, 8)} · opened {new Date(d.opened_at).toLocaleDateString()}</p>
            <div className="flex gap-2">
              <Button size="xs" variant="secondary" loading={busy === d.id} onClick={() => run(d.id, () => staffResolveDispute(d.id, true, 'Evidence supports the charge'))}>Uphold charge</Button>
              <Button size="xs" loading={busy === d.id} onClick={() => run(d.id, () => staffResolveDispute(d.id, false, 'Credited after review'))}>Credit owner</Button>
            </div>
          </Card>))}
      </section>

      <section aria-labelledby="s-jf" className="space-y-3"><h2 id="s-jf" className="text-lg font-semibold text-text-primary">Owner job flags ({jobFlags.length})</h2>
        {jobFlags.map((f) => (
          <Card key={f.id} interactive={false} className="flex flex-wrap items-center justify-between gap-2 p-4">
            <span className="text-sm text-text-primary">{f.flag.replace(/_/g, ' ')} · job {f.job_id.slice(0, 8)}{f.note ? ` — ${f.note}` : ''}</span>
            <span className="flex gap-2">
              <Button size="xs" variant="secondary" loading={busy === f.id} onClick={() => run(f.id, () => staffResolveJobFlag(f.id, false))}>Reject</Button>
              <Button size="xs" loading={busy === f.id} onClick={() => run(f.id, () => staffResolveJobFlag(f.id, true))}>Accept</Button>
            </span>
          </Card>))}
      </section>

      <section aria-labelledby="s-flags" className="space-y-3"><h2 id="s-flags" className="text-lg font-semibold text-text-primary">Integrity flags ({flags.length})</h2>
        {flags.map((f) => (<Card key={f.id} interactive={false} className="p-4 text-sm text-text-primary"><strong>{f.severity}</strong> · {f.code.replace(/_/g, ' ')} · week {f.week_start} · account {f.user_id.slice(0, 8)}<br />{f.detail}</Card>))}
      </section>
    </div>
  );
}
