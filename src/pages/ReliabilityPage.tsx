// Recreated: verify against original intent
// /dashboard/reliability  ("Reliability & Observability")
//
// An at-a-glance health view of the automation your account runs: reliability score per agent, workflow and
// integration, worst first, with a window switch. Scores come from src/lib/executionReliability.ts (the same source
// as the Execution Reliability page); this page only summarises and links onward.
// TODO(vireek): voice and platform-level observability RPCs in the migrations are operator/service-role only and
// are not shown to account users here. If the original page showed more panels, add them from that source.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  fetchExecutionReliabilityScores,
  type ExecutionEntityType,
  type ExecutionReliabilityScore,
  type ReliabilityTier,
} from '@/lib/executionReliability';

const WINDOWS = [7, 30, 90] as const;
const TIER: Record<ReliabilityTier, { label: string; cls: string }> = {
  excellent: { label: 'Excellent', cls: 'bg-success-500/10 text-success-500' },
  good: { label: 'Good', cls: 'bg-accent/10 text-accent' },
  at_risk: { label: 'At risk', cls: 'bg-warning-500/10 text-warning-500' },
  critical: { label: 'Critical', cls: 'bg-danger/10 text-danger' },
};
const TYPE_LABEL: Record<ExecutionEntityType, string> = { agent: 'Agents', workflow: 'Workflows', integration: 'Integrations' };
const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const pct = (n: number) => `${Math.round((Number.isFinite(n) ? n : 0) * 100)}%`;

export function ReliabilityPage() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [rows, setRows] = useState<ExecutionReliabilityScore[] | null>(null);
  const [error, setError] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(false);
    setRows(null);
    try {
      const r = await fetchExecutionReliabilityScores(days);
      if (mine === seq.current) setRows(r);
    } catch {
      if (mine === seq.current) setError(true);
    }
  }, [days]);
  useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);

  const summary = useMemo(() => {
    const list = rows ?? [];
    const count = (t: ReliabilityTier) => list.filter((r) => r.tier === t).length;
    const runs = list.reduce((s, r) => s + r.totalRuns, 0);
    // Weighted by volume so one busy agent counts more than a rarely used one.
    const avg = runs === 0 ? null : list.reduce((s, r) => s + r.score * r.totalRuns, 0) / runs;
    return { runs, avg, critical: count('critical'), atRisk: count('at_risk'), good: count('good') + count('excellent') };
  }, [rows]);

  const worst = useMemo(() => [...(rows ?? [])].sort((a, b) => a.score - b.score).slice(0, 8), [rows]);

  return (
    <DashboardLayout activeLabel="Reliability & Observability">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Activity size={22} aria-hidden="true" /> Reliability &amp; observability</h1>
          <p className="mt-1 text-sm text-text-secondary">How dependably your automation is running.</p>
        </div>
        <div role="group" aria-label="Time window" className="flex gap-1">
          {WINDOWS.map((w) => (
            <button key={w} type="button" aria-pressed={days === w} onClick={() => setDays(w)} className={`focus-ring min-h-[40px] rounded-lg border px-3 text-sm font-semibold ${days === w ? 'border-accent text-accent' : 'border-border text-text-secondary'}`}>{w} days</button>
          ))}
        </div>
      </div>

      {error && <p role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">Could not load reliability data. <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">Try again</button></p>}
      {!rows && !error && <p role="status" className="py-6 text-sm text-text-secondary">Loading…</p>}

      {rows && (
        rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-sm text-text-secondary">No automation runs were recorded in the last {days} days, so there is nothing to score yet.</p>
        ) : (
          <>
            <dl className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                ['Runs', summary.runs.toLocaleString()],
                ['Average score', summary.avg === null ? '—' : String(Math.round(summary.avg))],
                ['Healthy', String(summary.good)],
                ['At risk or critical', String(summary.atRisk + summary.critical)],
              ].map(([k, v]) => <div key={k} className={card}><dt className="text-xs font-semibold text-text-secondary">{k}</dt><dd className="mt-1 text-xl font-bold text-text-primary">{v}</dd></div>)}
            </dl>

            <section className={card} aria-labelledby="rel-worst">
              <h2 id="rel-worst" className="text-base font-semibold text-text-primary">Needs attention first</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="text-xs text-text-secondary"><tr><th scope="col" className="py-2 pe-3 font-semibold">Name</th><th scope="col" className="px-3 py-2 font-semibold">Type</th><th scope="col" className="px-3 py-2 text-right font-semibold">Runs</th><th scope="col" className="px-3 py-2 text-right font-semibold">Success</th><th scope="col" className="px-3 py-2 text-right font-semibold">Rolled back</th><th scope="col" className="ps-3 py-2 text-right font-semibold">Score</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {worst.map((r) => (
                      <tr key={`${r.entityType}:${r.entityKey}`}>
                        <th scope="row" className="py-2 pe-3 font-medium text-text-primary">{r.entityLabel}</th>
                        <td className="px-3 py-2 text-text-secondary">{TYPE_LABEL[r.entityType]}</td>
                        <td className="px-3 py-2 text-right text-text-secondary">{r.totalRuns.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-text-secondary">{pct(r.successRate)}</td>
                        <td className="px-3 py-2 text-right text-text-secondary">{pct(r.rollbackRate)}</td>
                        <td className="ps-3 py-2 text-right"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TIER[r.tier].cls}`}>{Math.round(r.score)} · {TIER[r.tier].label}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )
      )}

      <section className={`${card} mt-6`} aria-labelledby="rel-more">
        <h2 id="rel-more" className="text-base font-semibold text-text-primary">Go deeper</h2>
        <ul className="mt-3 grid gap-2 md:grid-cols-3">
          {[['/dashboard/execution-reliability', 'Execution Reliability', 'Every agent, workflow and integration.'], ['/dashboard/ai-reliability', 'AI Reliability', 'Decision quality and reviews.'], ['/dashboard/governance', 'Governance Center', 'Rules and approvals.']].map(([to, label, hint]) => (
            <li key={to}><Link to={to} className="focus-ring block rounded-xl border border-border p-3 hover:bg-bg-tertiary"><span className="block text-sm font-semibold text-text-primary">{label}</span><span className="block text-xs text-text-secondary">{hint}</span></Link></li>
          ))}
        </ul>
      </section>
    </DashboardLayout>
  );
}
