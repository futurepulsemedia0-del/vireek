/**
 * Revenue Causality Graph — /dashboard/revenue-causality
 *
 * Missed Call -> Delayed Response -> Quote Delay -> Customer Hesitation
 * -> Lost Job -> Lost LTV, each link carrying an estimated economic impact,
 * plus a what-if simulator ("if response time drops from X to 30 min...").
 *
 * Data: compute_revenue_causality_graph RPC (aggregation only).
 * Maths: src/lib/revenueCausalityModel.ts (pure, unit-tested).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown, Clock, Coins, FileText, Hourglass, Info, Network, PhoneMissed, RefreshCw, Target, XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { computeRevenueCausality, fetchRevenueCausality } from '@/lib/revenueCausality';
import {
  QUOTE_TARGETS, RESPONSE_TARGETS, buildRevenueCausalityGraph, formatUsd, runScenario,
  type Bucket, type Confidence, type GraphEdge, type Money, type NodeId, type RcgData,
} from '@/lib/revenueCausalityModel';

const NODE_ICONS: Record<NodeId, LucideIcon> = {
  missed_call: PhoneMissed,
  delayed_response: Clock,
  quote_delay: FileText,
  hesitation: Hourglass,
  lost_job: XCircle,
  lost_ltv: Coins,
};

const CONFIDENCE_STYLES: Record<Confidence, string> = {
  high: 'bg-success-500/15 text-success-500',
  medium: 'bg-warning-500/15 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

const KIND_LABEL: Record<GraphEdge['kind'], string> = {
  estimated: 'Estimated exposure',
  realized: 'Realized loss',
  derived: 'Derived estimate',
};

function ConfidenceChip({ level }: { level: Confidence }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${CONFIDENCE_STYLES[level]}`}>
      {level} confidence
    </span>
  );
}

function range(m: Money): string {
  return Math.round(m.low) === Math.round(m.high) ? '' : `${formatUsd(m.low)} – ${formatUsd(m.high)}`;
}

function EdgeConnector({ edge }: { edge: GraphEdge }) {
  return (
    <div className="flex items-stretch gap-3 px-4 py-2" aria-label={`${edge.label}: ${KIND_LABEL[edge.kind]}`}>
      <div className="flex w-10 flex-col items-center">
        <div className="w-px flex-1 bg-border" />
        <ArrowDown size={14} className="my-0.5 text-text-secondary" />
        <div className="w-px flex-1 bg-border" />
      </div>
      <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-bg-primary px-3 py-2">
        <span className="text-[10px] font-semibold uppercase text-text-secondary">{edge.label}</span>
        {edge.usd && edge.usd.expected > 0 ? (
          <>
            <span className={`text-sm font-bold ${edge.kind === 'realized' ? 'text-danger-500' : 'text-text-primary'}`}>
              {formatUsd(edge.usd.expected)}
            </span>
            {range(edge.usd) && <span className="text-[11px] text-text-secondary">range {range(edge.usd)}</span>}
            <span className="text-[11px] text-text-secondary">{KIND_LABEL[edge.kind]}</span>
            {edge.confidence && <ConfidenceChip level={edge.confidence} />}
          </>
        ) : (
          <span className="text-[11px] text-text-secondary">No measurable impact from the data yet</span>
        )}
      </div>
    </div>
  );
}

function BucketBars({ title, buckets, extra }: { title: string; buckets: Bucket[]; extra?: { label: string; n: number; wins: number } }) {
  const rows = [...buckets.map((b) => ({ label: b.label, n: b.n, wins: b.wins })), ...(extra ? [extra] : [])];
  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-text-primary">{title}</p>
      <div className="space-y-1.5">
        {rows.map((r) => {
          const rate = r.n > 0 ? r.wins / r.n : null;
          return (
            <div key={r.label} className="flex items-center gap-2 text-[11px]">
              <span className="w-24 shrink-0 text-text-secondary">{r.label}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
                <div className="h-full rounded-full bg-cta" style={{ width: `${Math.round((rate ?? 0) * 100)}%` }} />
              </div>
              <span className="w-24 shrink-0 text-right text-text-secondary">
                {rate === null ? '—' : `${Math.round(rate * 100)}% win`} · n={r.n}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScenarioCard({
  title, subtitle, buckets, targets, perWin, ltvMultiplier, defaultTarget,
}: {
  title: string; subtitle: string; buckets: Bucket[]; targets: { hours: number; label: string }[];
  perWin: number | null; ltvMultiplier: number | null; defaultTarget: number;
}) {
  const [target, setTarget] = useState(defaultTarget);
  const [reach, setReach] = useState(80);
  const result = useMemo(
    () => runScenario(buckets, target, reach / 100, perWin, ltvMultiplier),
    [buckets, target, reach, perWin, ltvMultiplier],
  );
  const targetLabel = targets.find((t) => t.hours === target)?.label ?? `${target} h`;

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2">
        <Target size={16} className="text-cta" />
        <p className="text-sm font-semibold text-text-primary">{title}</p>
      </div>
      <p className="mt-1 text-xs text-text-secondary">{subtitle}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-xs text-text-secondary">
          Target
          <select
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
            className="focus-ring mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
          >
            {targets.map((t) => (
              <option key={t.hours} value={t.hours}>Within {t.label}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-text-secondary">
          Achievable on {reach}% of cases
          <input
            type="range" min={50} max={100} step={5} value={reach}
            onChange={(e) => setReach(Number(e.target.value))}
            className="focus-ring mt-3 w-full"
          />
        </label>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-bg-primary p-4">
        <p className="text-[11px] text-text-secondary">
          Today typically: <span className="font-semibold text-text-primary">{result.currentTypical}</span> → target:{' '}
          <span className="font-semibold text-text-primary">{targetLabel}</span>
        </p>
        {result.revenue && result.sim.reference ? (
          <>
            <p className="mt-2 text-2xl font-bold text-text-primary">+{formatUsd(result.revenue.expected)}</p>
            <p className="text-xs text-text-secondary">
              expected recovered revenue
              {range(result.revenue) && ` (range ${range(result.revenue)})`} · ≈ {result.sim.wins.expected.toFixed(1)} extra jobs
            </p>
            {result.ltv && (
              <p className="mt-1 text-xs text-text-secondary">
                plus ≈ <span className="font-semibold text-text-primary">{formatUsd(result.ltv.expected)}</span> in lifetime value
              </p>
            )}
            <div className="mt-2"><ConfidenceChip level={result.sim.confidence} /></div>
          </>
        ) : (
          <p className="mt-2 text-sm text-text-secondary">
            {perWin ? 'Not enough fast-handled history to estimate this target yet.' : 'Needs completed jobs with invoice amounts to price the impact.'}
          </p>
        )}
        <p className="mt-2 text-[11px] text-text-secondary">{result.evidence}</p>
      </div>
    </Card>
  );
}

export function RevenueCausalityGraphPage() {
  const { toast } = useToast();
  const [data, setData] = useState<RcgData | null>(null);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);
  const [days, setDays] = useState(180);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await fetchRevenueCausality();
      setData(snap);
      if (snap) setDays(snap.window_days);
    } catch {
      toast('Could not load the revenue causality graph.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const recalc = async () => {
    setComputing(true);
    try {
      setData(await computeRevenueCausality(days));
      toast('Revenue causality graph updated.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not compute the graph.', 'error');
    } finally {
      setComputing(false);
    }
  };

  const graph = useMemo(() => (data ? buildRevenueCausalityGraph(data) : null), [data]);
  const edgeAfter = (id: NodeId) => graph?.edges.find((e) => e.from === id);

  return (
    <DashboardLayout activeLabel="Revenue Causality Graph">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Network className="text-cta" size={20} />
            <div>
              <p className="text-sm font-semibold text-text-primary">Revenue Causality Graph</p>
              <p className="text-xs text-text-secondary">Where the funnel leaks — and what each leak costs.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select
              aria-label="Analysis window"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary"
            >
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 180 days</option>
              <option value={365}>Last 12 months</option>
            </select>
            <Button size="sm" disabled={computing} onClick={recalc}>
              <RefreshCw size={14} className={computing ? 'animate-spin' : ''} /> {data ? 'Recalculate' : 'Analyze'}
            </Button>
          </div>
        </div>

        {loading && (
          <div className="space-y-4">
            <SkeletonCard rows={3} />
            <SkeletonCard rows={4} />
          </div>
        )}

        {!loading && !graph && (
          <EmptyState
            icon={Network}
            title="No analysis yet"
            description="Run the analysis to trace missed calls through to lost lifetime value using your own history."
            action={{ label: 'Analyze my funnel', onClick: () => void recalc() }}
          />
        )}

        {!loading && graph && data && (
          <>
            {graph.totals ? (
              <Card className="p-6">
                <p className="text-xs font-semibold uppercase text-text-secondary">
                  Estimated revenue exposure · last {data.window_days} days
                </p>
                <p className="mt-1 text-3xl font-bold text-text-primary">{formatUsd(graph.totals.revenue.expected)}</p>
                <p className="text-xs text-text-secondary">
                  range {formatUsd(graph.totals.revenue.low)} – {formatUsd(graph.totals.revenue.high)}
                  {graph.totals.ltv && <> · plus ≈ {formatUsd(graph.totals.ltv.expected)} lifetime value</>}
                </p>
                <ul className="mt-4 space-y-1.5">
                  {graph.narrative.map((line) => (
                    <li key={line} className="text-sm text-text-primary">{line}</li>
                  ))}
                </ul>
              </Card>
            ) : (
              <EmptyState
                icon={Info}
                title="Not enough data to price the leaks yet"
                description={graph.notes[0] ?? 'Keep logging calls, leads and quotes — the graph fills in automatically.'}
              />
            )}

            <div>
              {graph.nodes.map((node) => {
                const Icon = NODE_ICONS[node.id];
                const edge = edgeAfter(node.id);
                return (
                  <div key={node.id}>
                    <Card className="p-5">
                      <div className="flex items-start gap-3">
                        <div className="rounded-xl bg-cta/15 p-2 text-cta"><Icon size={18} /></div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold uppercase text-text-secondary">{node.label}</p>
                          <p className="text-lg font-bold text-text-primary">{node.headline}</p>
                          <p className="text-xs text-text-secondary">{node.detail}</p>
                        </div>
                      </div>
                    </Card>
                    {edge && <EdgeConnector edge={edge} />}
                  </div>
                );
              })}
            </div>

            <Card className="p-6">
              <p className="mb-4 text-sm font-semibold text-text-primary">The evidence: speed vs. win rate</p>
              <div className="grid gap-6 md:grid-cols-2">
                <BucketBars
                  title="Inbound call → first follow-up"
                  buckets={graph.responseBuckets}
                  extra={{ label: 'No follow-up', n: graph.neverBucket.n, wins: graph.neverBucket.wins }}
                />
                <BucketBars title="Lead → quote sent" buckets={graph.quoteBuckets} />
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <ScenarioCard
                title="What if we respond faster?"
                subtitle="Simulates handling every missed / callback-request call within the target."
                buckets={graph.responseBuckets}
                targets={RESPONSE_TARGETS}
                defaultTarget={0.5}
                perWin={data.avg_job_value}
                ltvMultiplier={data.ltv_multiplier}
              />
              <ScenarioCard
                title="What if we quote faster?"
                subtitle="Simulates sending every quote within the target after the lead arrives."
                buckets={graph.quoteBuckets}
                targets={QUOTE_TARGETS}
                defaultTarget={4}
                perWin={data.quotes.avg_value ?? data.avg_job_value}
                ltvMultiplier={data.ltv_multiplier}
              />
            </div>

            <Card className="p-5">
              <div className="flex items-start gap-2">
                <Info size={14} className="mt-0.5 shrink-0 text-text-secondary" />
                <div className="space-y-1 text-[11px] text-text-secondary">
                  <p>
                    <span className="font-semibold text-text-primary">How this is estimated.</span> Win rates are measured per speed bucket
                    on your own resolved history (opportunities older than 14 days), shrunk toward your overall rate so small samples
                    can&apos;t exaggerate. Exposure = slower-bucket volume × (best evidenced win rate − that bucket&apos;s rate) × average job value.
                  </p>
                  <p>This is observational: faster responders can also be easier leads, so treat results as estimates with the stated range — not guarantees.</p>
                  {graph.notes.map((n) => <p key={n}>{n}</p>)}
                </div>
              </div>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
