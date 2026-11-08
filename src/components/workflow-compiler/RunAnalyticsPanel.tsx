/**
 * Per-workflow run analytics: step timing, failure rate, approval wait, funnel, SLA hotspots, bottlenecks,
 * slow-run flags and (when recorded) LLM tokens. Computed from the audit trail of the most recent runs.
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchRunAudit, KIND_LABEL } from '@/lib/workflowCompiler';
import type { CompiledRun, CompiledWorkflow } from '@/lib/workflowCompiler';
import { outlineOrder } from '@/lib/workflowInsights';
import {
  anomalies, bottlenecks, buildSpans, costPerRun, funnel, nodeStats, slaHotspots,
} from '../../../supabase/functions/_shared/workflow-compiler/run-analytics.ts';
import type { AuditRow } from '../../../supabase/functions/_shared/workflow-compiler/run-analytics.ts';
import { card, field } from './styles';

const MAX_RUNS = 30;
const fmtMs = (ms: number | null) => {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function RunAnalyticsPanel({ runs, workflows }: { runs: CompiledRun[]; workflows: CompiledWorkflow[] }) {
  const withRuns = useMemo(() => workflows.filter((w) => runs.some((r) => r.workflow_id === w.id)), [workflows, runs]);
  const [wfId, setWfId] = useState(withRuns[0]?.id ?? '');
  const wf = withRuns.find((w) => w.id === wfId) ?? withRuns[0];
  const mine = useMemo(() => runs.filter((r) => r.workflow_id === wf?.id).slice(0, MAX_RUNS), [runs, wf?.id]);
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!wf) return;
    let cancelled = false;
    setRows(null); setFailed(false);
    Promise.all(mine.map((r) => fetchRunAudit(r.id)))
      .then((all) => { if (!cancelled) setRows(all.flat()); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [wf, mine]);

  const view = useMemo(() => {
    if (!wf || !rows) return null;
    const spans = buildSpans(rows);
    const stats = nodeStats(spans);
    const kinds = new Map(Object.entries(wf.graph.nodes).map(([id, n]) => [id, n.kind as string]));
    const order = outlineOrder(wf.graph).main.map((s) => s.id);
    const durations = mine.filter((r) => r.completed_at).map((r) => ({ id: r.id, ms: Date.parse(r.completed_at as string) - Date.parse(r.started_at) }));
    const slow = anomalies(durations.map((d) => d.ms)).map((i) => durations[i]);
    const tokens = costPerRun(rows, 0, 0);
    let tin = 0, tout = 0;
    tokens?.forEach((t) => { tin += t.tokensIn; tout += t.tokensOut; });
    return {
      stats, order, tokens: tokens ? { tin, tout } : null, slow,
      bottle: bottlenecks(stats, kinds), steps: funnel(spans, order), hot: slaHotspots(mine, spans),
    };
  }, [wf, rows, mine]);

  const label = (id: string) => wf?.graph.nodes[id]?.label ?? id;
  if (withRuns.length === 0) return <p className="py-12 text-center text-sm text-text-secondary">No runs to analyse yet. Start a test run from a compiled workflow.</p>;

  return (
    <div className="space-y-4">
      <label className="block text-xs text-text-secondary">Workflow
        <select className={`${field} mt-1 max-w-md`} value={wf?.id} onChange={(e) => setWfId(e.target.value)}>
          {withRuns.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </label>
      <p className="text-xs text-text-secondary">Based on the {mine.length} most recent run{mine.length === 1 ? '' : 's'}. Test and live runs are both included.</p>

      {failed && <p role="alert" className="text-sm text-danger">Could not load the audit trail. Try again shortly.</p>}
      {!failed && !view && <Loader2 size={20} className="animate-spin text-text-secondary" aria-label="Loading analytics" />}

      {view && wf && (
        <>
          <section className={card}>
            <h4 className="text-sm font-medium text-text-primary">Steps</h4>
            <div className="overflow-x-auto">
              <table className="mt-2 w-full text-start text-xs">
                <caption className="sr-only">Timing and failure rate for each step</caption>
                <thead className="text-text-secondary"><tr>
                  <th scope="col" className="py-1 text-start font-medium">Step</th><th scope="col" className="text-start font-medium">Runs</th>
                  <th scope="col" className="text-start font-medium">Median</th><th scope="col" className="text-start font-medium">Slowest 5%</th>
                  <th scope="col" className="text-start font-medium">Failed</th><th scope="col" className="text-start font-medium">Median approval wait</th>
                </tr></thead>
                <tbody className="text-text-primary">
                  {view.order.map((id) => {
                    const s = view.stats.find((x) => x.node === id);
                    return (
                      <tr key={id} className="border-t border-border">
                        <th scope="row" className="py-1 text-start font-normal" dir="auto">{KIND_LABEL[wf.graph.nodes[id].kind]} · {label(id)}</th>
                        <td>{s?.runs ?? 0}</td><td>{fmtMs(s?.p50 ?? null)}</td><td>{fmtMs(s?.p95 ?? null)}</td>
                        <td>{s && s.finished > 0 ? `${s.failures} (${pct(s.failureRate)})` : '—'}</td><td>{fmtMs(s?.approvalWaitP50 ?? null)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className={card}>
            <h4 className="text-sm font-medium text-text-primary">Where runs end up</h4>
            <ol className="mt-2 space-y-1 text-xs text-text-primary">
              {view.steps.map((s) => <li key={s.node} dir="auto">{label(s.node)}: {s.runs} run{s.runs === 1 ? '' : 's'} ({pct(s.ofStart)} of those that started)</li>)}
            </ol>
          </section>

          <section className={card}>
            <h4 className="text-sm font-medium text-text-primary">What to look at</h4>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-xs text-text-primary">
              {view.bottle.length === 0 && view.hot.length === 0 && view.slow.length === 0 && <li className="list-none text-text-secondary">Nothing stands out in these runs.</li>}
              {view.bottle.map((b) => <li key={`b-${b.node}`} dir="auto">Bottleneck: {label(b.node)} takes {pct(b.share)} of the working time (waiting for people is not counted).</li>)}
              {view.hot.map((h) => <li key={`h-${h.node}`} dir="auto">Time limit missed {h.breaches} time{h.breaches === 1 ? '' : 's'}, mostly while on: {label(h.node)}.</li>)}
              {view.slow.map((s) => <li key={`s-${s.id}`}>A run took unusually long ({fmtMs(s.ms)}).</li>)}
            </ul>
          </section>

          <section className={card}>
            <h4 className="text-sm font-medium text-text-primary">AI usage</h4>
            <p className="mt-1 text-xs text-text-secondary">
              {view.tokens ? `${view.tokens.tin.toLocaleString()} input and ${view.tokens.tout.toLocaleString()} output tokens across these runs.` : 'Token usage has not been recorded for these runs, so no cost is shown.'}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
