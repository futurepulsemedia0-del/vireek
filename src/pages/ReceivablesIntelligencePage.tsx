/**
 * Service Receivables Intelligence — /dashboard/receivables
 * Cash realization intelligence: which revenue is actually collectable, and
 * which operational step (approval workflow, invoicing lag, disputes) is
 * delaying it. Chain: Job → Quote → Approval → Contract → Invoice → Payment
 * → Dispute → Collection.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Landmark, Loader2, RefreshCw, ArrowRight, AlertTriangle, Clock, ShieldAlert } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { formatCents } from '@/lib/quotes';
import {
  buildCashDragInsights,
  collectabilityPct,
  compareWorkflows,
  computeReceivablesAnalysis,
  DELAY_STAGE_LABELS,
  fetchReceivablesAnalysis,
  type AgingBucket,
  type GraphNodeKey,
  type ReceivablesConfidence,
  type ReceivablesResult,
  type ReceivablesWeek,
} from '@/lib/receivablesIntelligence';

const NODE_LABELS: Record<GraphNodeKey, string> = {
  job: 'Job',
  quote: 'Quote',
  approval: 'Approval',
  contract: 'Contract',
  invoice: 'Invoice',
  payment: 'Payment',
  dispute: 'Dispute',
  collection: 'Collection',
};

const CONFIDENCE_STYLES: Record<ReceivablesConfidence, string> = {
  high: 'bg-success-500/15 text-success-500',
  medium: 'bg-warning-500/15 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

const AGING_STYLES: Record<AgingBucket['bucket'], string> = {
  current: 'bg-success-500',
  '1-30': 'bg-cta',
  '31-60': 'bg-warning-500',
  '61-90': 'bg-warning-500',
  '90+': 'bg-danger-500',
};

function days(value: number | null): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)}d`;
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'danger' | 'success' }) {
  const toneClass = tone === 'danger' ? 'text-danger-500' : tone === 'success' ? 'text-success-500' : 'text-text-primary';
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[10px] uppercase text-text-secondary">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function WeeklyBars({ weekly }: { weekly: ReceivablesWeek[] }) {
  const max = Math.max(...weekly.flatMap((w) => [w.billed_cents, w.collected_cents]), 1);
  const chartW = 320;
  const chartH = 90;
  const slot = weekly.length > 0 ? chartW / weekly.length : chartW;
  const barW = Math.max(slot / 2 - 2, 2);
  const h = (v: number) => (v / max) * (chartH - 4);
  return (
    <div>
      <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full" style={{ height: chartH }} role="img" aria-label="Billed versus collected per week">
        {weekly.map((w, i) => (
          <g key={w.week_start}>
            <rect x={i * slot + 1} y={chartH - h(w.billed_cents)} width={barW} height={h(w.billed_cents)} rx={1.5} fill="rgb(37 99 235)" opacity={0.85} />
            <rect x={i * slot + 1 + barW + 1} y={chartH - h(w.collected_cents)} width={barW} height={h(w.collected_cents)} rx={1.5} fill="rgb(34 197 94)" opacity={0.85} />
          </g>
        ))}
      </svg>
      <div className="mt-1 flex items-center gap-3 text-[10px] text-text-secondary">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-cta" /> Billed</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-success-500" /> Collected</span>
        <span className="ml-auto">Last {weekly.length} weeks</span>
      </div>
    </div>
  );
}

export function ReceivablesIntelligencePage() {
  const { toast } = useToast();
  const [result, setResult] = useState<ReceivablesResult | null>(null);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const row = await fetchReceivablesAnalysis();
      setResult(row?.result ?? null);
      setComputedAt(row?.computed_at ?? null);
    } catch {
      toast('Could not load receivables intelligence.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const recalc = async () => {
    setComputing(true);
    try {
      setResult(await computeReceivablesAnalysis());
      setComputedAt(new Date().toISOString());
      toast('Receivables intelligence updated.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not compute receivables intelligence.', 'error');
    } finally {
      setComputing(false);
    }
  };

  const insights = useMemo(() => (result ? buildCashDragInsights(result) : []), [result]);
  const workflow = useMemo(() => (result ? compareWorkflows(result.segments) : null), [result]);
  const collectability = result ? collectabilityPct(result) : null;
  const agingMax = result ? Math.max(...result.aging.map((a) => a.cents), 1) : 1;

  if (loading) {
    return <DashboardLayout activeLabel="Receivables Intelligence"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Receivables Intelligence">
      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Landmark className="text-cta" size={20} />
            <p className="text-sm font-semibold text-text-primary">Service Receivables Intelligence</p>
            {result && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${CONFIDENCE_STYLES[result.confidence]}`}>
                {result.confidence} confidence · {result.paid_invoices} paid / {result.invoices_analyzed} invoices
              </span>
            )}
          </div>
          <button disabled={computing} onClick={recalc}
            className="focus-ring flex items-center gap-1.5 rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta disabled:opacity-50">
            {computing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {result ? 'Recalculate' : 'Analyze'}
          </button>
        </div>
        <p className="text-xs text-text-secondary">
          Which revenue is actually collectable — and which operational step is delaying it. Traces every invoice back through
          approval, contract and job so a slow-paying job type can be traced to the workflow behind it.
          {computedAt && <> Last computed {new Date(computedAt).toLocaleString()}.</>}
        </p>

        {!result && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-sm text-text-secondary">
            No analysis yet. Click Analyze to scan your invoices, quotes, contracts and payments.
          </div>
        )}

        {result && result.invoices_analyzed === 0 && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-sm text-text-secondary">
            No sent invoices in the last {result.window_days} days. Send invoices from the Invoicing page and this view fills in automatically.
          </div>
        )}

        {result && result.invoices_analyzed > 0 && (
          <>
            {result.confidence === 'low' && (
              <div className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-xs text-warning-500">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>Only {result.paid_invoices} paid invoices so far — timing figures and slow-segment findings are directional until more invoices settle.</span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Kpi label="Open receivables" value={formatCents(result.summary.open_cents)} hint={`${formatCents(result.summary.overdue_cents)} overdue`} />
              <Kpi label="Expected collectable" value={formatCents(result.summary.expected_collectable_cents)}
                hint={collectability !== null ? `${collectability.toFixed(0)}% of open (estimate)` : undefined} tone="success" />
              <Kpi label="At risk" value={formatCents(result.summary.at_risk_cents)}
                hint={result.summary.disputed_open_cents > 0 ? `${formatCents(result.summary.disputed_open_cents)} disputed` : undefined} tone="danger" />
              <Kpi label="DSO" value={days(result.summary.dso_days)} hint="open AR ÷ last 90d billed" />
              <Kpi label="Median days to cash" value={days(result.summary.median_days_to_cash)} hint={`p90 ${days(result.summary.p90_days_to_cash)}`} />
            </div>

            <section className="rounded-2xl border border-border bg-bg-secondary p-4">
              <p className="mb-3 text-xs font-semibold text-text-primary">Cash realization chain</p>
              <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
                {result.graph.nodes.map((n, i) => (
                  <div key={n.key} className="flex items-center gap-1">
                    <div className="min-w-[88px] rounded-xl border border-border bg-bg-primary p-3 text-center">
                      <p className="text-[10px] uppercase text-text-secondary">{NODE_LABELS[n.key]}</p>
                      <p className="mt-0.5 text-base font-semibold text-text-primary">{n.count}</p>
                    </div>
                    {i < result.graph.nodes.length - 1 && <ArrowRight size={12} className="shrink-0 text-text-secondary" />}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-secondary">
                {[
                  ['Quote → approval', result.graph.transitions.quote_to_approval_days],
                  ['Approval → invoice', result.graph.transitions.approval_to_invoice_days],
                  ['Job complete → invoice', result.graph.transitions.job_to_invoice_days],
                  ['Invoice → payment', result.graph.transitions.invoice_to_payment_days],
                ].map(([label, value]) => (
                  <span key={label as string} className="flex items-center gap-1 rounded-full bg-bg-tertiary px-2.5 py-1">
                    <Clock size={10} /> {label as string}: <span className="font-medium text-text-primary">{days(value as number | null)}</span>
                  </span>
                ))}
              </div>
              {workflow && (
                <p className="mt-3 text-xs text-text-secondary">
                  Approval-gated jobs reach cash in <span className="font-medium text-text-primary">{workflow.gated_days.toFixed(1)}d</span> vs{' '}
                  <span className="font-medium text-text-primary">{workflow.direct_days.toFixed(1)}d</span> for directly billed jobs
                  ({workflow.gated_paid} vs {workflow.direct_paid} paid invoices).
                </p>
              )}
            </section>

            <section className="space-y-3">
              <p className="text-xs font-semibold text-text-primary">Where operations are slowing cash</p>
              {insights.length === 0 ? (
                <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-xs text-text-secondary">
                  No job type is materially slower than your {days(result.summary.median_days_to_cash)} median with enough settled invoices to say so. Re-run as more invoices are paid.
                </div>
              ) : insights.map((ins) => (
                <div key={`${ins.service_type}-${ins.approval_gated}-${ins.has_contract}`} className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-lg bg-warning-500/15 px-2 py-1 font-medium text-warning-500">
                      {ins.service_type}{ins.approval_gated ? ' · approval workflow' : ' · direct billing'}{ins.has_contract ? ' · under contract' : ''}
                    </span>
                    <ArrowRight size={11} className="text-text-secondary" />
                    <span className="rounded-lg bg-bg-tertiary px-2 py-1 text-text-primary">
                      Slowest step: {DELAY_STAGE_LABELS[ins.bottleneck]} ({ins.bottleneck_days.toFixed(1)}d)
                    </span>
                    <ArrowRight size={11} className="text-text-secondary" />
                    <span className="rounded-lg bg-danger-500/15 px-2 py-1 font-medium text-danger-500">
                      {formatCents(ins.trapped_cents)} still open
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-text-secondary">
                    Takes <span className="font-medium text-text-primary">{ins.days_to_cash.toFixed(1)} days</span> to turn into cash —{' '}
                    {ins.multiple.toFixed(1)}× your {ins.baseline_days.toFixed(1)}-day median ({ins.delay_days.toFixed(1)} days slower)
                    on an average ticket of {formatCents(ins.avg_ticket_cents)}.
                    {ins.dispute_rate > 0 && <> {(ins.dispute_rate * 100).toFixed(0)}% of these jobs are disputed.</>}
                  </p>
                </div>
              ))}
            </section>

            <div className="grid gap-4 md:grid-cols-2">
              <section className="rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="mb-3 text-xs font-semibold text-text-primary">Open receivables by days past due</p>
                {result.aging.length === 0 ? (
                  <p className="text-xs text-text-secondary">Nothing outstanding.</p>
                ) : (
                  <div className="space-y-2">
                    {result.aging.map((a) => (
                      <div key={a.bucket}>
                        <div className="flex justify-between text-[11px] text-text-secondary">
                          <span>{a.bucket === 'current' ? 'Not yet due' : `${a.bucket} days`} · {a.count}</span>
                          <span className="font-medium text-text-primary">{formatCents(a.cents)}</span>
                        </div>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
                          <div className={`h-full rounded-full ${AGING_STYLES[a.bucket]}`} style={{ width: `${(a.cents / agingMax) * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <section className="rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="mb-3 text-xs font-semibold text-text-primary">Billed vs collected</p>
                <WeeklyBars weekly={result.weekly} />
              </section>
            </div>

            <section className="rounded-2xl border border-border bg-bg-secondary p-4">
              <p className="mb-3 text-xs font-semibold text-text-primary">Cash realization by job type and workflow</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead className="text-[10px] uppercase text-text-secondary">
                    <tr>
                      <th className="pb-2 pr-3">Job type</th><th className="pb-2 pr-3">Workflow</th><th className="pb-2 pr-3">Invoices</th>
                      <th className="pb-2 pr-3">Billed</th><th className="pb-2 pr-3">Open</th><th className="pb-2 pr-3">Days to cash</th>
                      <th className="pb-2 pr-3">Approval wait</th><th className="pb-2 pr-3">Disputed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.segments.map((s) => (
                      <tr key={`${s.service_type}-${s.approval_gated}-${s.has_contract}`} className="border-t border-border text-text-secondary">
                        <td className="py-2 pr-3 font-medium text-text-primary">{s.service_type}</td>
                        <td className="py-2 pr-3">{s.approval_gated ? 'Quote approval' : 'Direct'}{s.has_contract ? ' + contract' : ''}</td>
                        <td className="py-2 pr-3">{s.invoices}</td>
                        <td className="py-2 pr-3">{formatCents(s.billed_cents)}</td>
                        <td className="py-2 pr-3">{formatCents(s.open_cents)}</td>
                        <td className="py-2 pr-3 font-medium text-text-primary">{days(s.median_days_to_cash)}</td>
                        <td className="py-2 pr-3">{days(s.median_approval_days)}</td>
                        <td className="py-2 pr-3">{(s.dispute_rate * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[10px] text-text-secondary">Only combinations with 3+ invoices are shown.</p>
            </section>

            <section className="rounded-2xl border border-border bg-bg-secondary p-4">
              <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                <ShieldAlert size={13} className="text-danger-500" /> Revenue most at risk of not being collected
              </p>
              {result.at_risk_invoices.length === 0 ? (
                <p className="text-xs text-text-secondary">No open invoices.</p>
              ) : (
                <div className="space-y-2">
                  {result.at_risk_invoices.map((inv) => (
                    <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary p-3 text-xs">
                      <div>
                        <p className="font-medium text-text-primary">{inv.invoice_number ?? 'Invoice'} · {inv.customer_name}</p>
                        <p className="text-[11px] text-text-secondary">
                          {inv.service_type} · {inv.days_past_due > 0 ? `${inv.days_past_due}d past due` : 'not yet due'}
                          {inv.disputed ? ' · disputed' : ''}{inv.reminders > 0 ? ` · ${inv.reminders} reminders sent` : ''}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-text-primary">{formatCents(inv.total_cents)}</p>
                        <p className="text-[11px] text-danger-500">{formatCents(inv.at_risk_cents)} at risk · {(inv.collect_prob * 100).toFixed(0)}% likely</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <p className="text-[10px] text-text-secondary">
              Collectability is an estimate: an aging-based likelihood adjusted for disputes and repeated reminders, not a guarantee.
              Timing figures are medians from your own settled invoices.
            </p>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
