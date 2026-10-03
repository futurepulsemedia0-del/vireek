import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, CircleDashed, CircleDot, Gauge, Info, Network, ShieldCheck, Wallet, Zap } from 'lucide-react';
import type { PropertyTwin } from '@/lib/propertyTwin';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatBudgetUsd } from '@/lib/homeBudget';
import { formatMonths } from '@/lib/lifetimeServicePlan';
import { fetchSiteYearBuilt } from '@/lib/lifetimeServicePlanApi';
import { fetchEnergyReadings, saveEnergyReading } from '@/lib/homeIntelligenceGraphApi';
import {
  GRAPH_BASIS_LABELS,
  GRAPH_RISK_LABELS,
  childrenOf,
  computeHomeIntelligenceGraph,
  validateEnergyInput,
  type DataSignal,
  type EnergyReading,
  type GraphConfidence,
  type GraphNode,
  type GraphRiskLevel,
  type HomeIntelligenceGraph,
  type SignalState,
} from '@/lib/homeIntelligenceGraph';

const PILL: Record<GraphRiskLevel, string> = {
  low: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
};
const FILL: Record<GraphRiskLevel, string> = {
  low: 'bg-success-500',
  medium: 'bg-warning-500',
  high: 'bg-danger',
};
const CONFIDENCE_COPY: Record<GraphConfidence, string> = {
  high: 'High confidence — most inputs are connected',
  medium: 'Medium confidence — connect more inputs to sharpen it',
  low: 'Low confidence — mostly estimated from limited records',
};
const SIGNAL_STYLE: Record<SignalState, { icon: typeof CheckCircle2; className: string; label: string }> = {
  connected: { icon: CheckCircle2, className: 'text-success-500', label: 'Connected' },
  partial: { icon: CircleDot, className: 'text-warning-500', label: 'Partial' },
  missing: { icon: CircleDashed, className: 'text-text-secondary', label: 'Missing' },
};

const percent = (value: number) => `${Math.round(value * 100)}%`;
const points = (value: number) => `${Math.round(value * 100)} pts`;
const currentMonth = () => new Date().toISOString().slice(0, 7);

function RiskBar({ value, baseline, level, label }: { value: number; baseline?: number; level: GraphRiskLevel; label: string }) {
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-border/50" role="img" aria-label={`${label}: ${percent(value)}`}>
      <div className={`h-full rounded-full ${FILL[level]}`} style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
      {baseline !== undefined && baseline < value && (
        <div className="absolute top-0 h-full w-0.5 bg-text-primary/50" style={{ left: `${Math.min(99, baseline * 100)}%` }} title={`Typical for its age: ${percent(baseline)}`} />
      )}
    </div>
  );
}

function LevelPill({ level }: { level: GraphRiskLevel }) {
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${PILL[level]}`}>{GRAPH_RISK_LABELS[level]} risk</span>;
}

function Tile({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-text-secondary">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="text-2xl font-semibold leading-none tabular-nums text-text-primary">{value}</p>
      <p className="mt-2 text-[11px] text-text-secondary">{note}</p>
    </div>
  );
}

function WhatIfPanel({ node }: { node: GraphNode }) {
  const w = node.maintenance;
  if (!w) {
    return (
      <p className="rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">
        {node.basis === 'home_age'
          ? 'Estimated from the home’s age, so there is no service-fixable issue to measure. Record the actual equipment to get a precise “act now” estimate.'
          : 'Nothing here can be improved by service right now: service is on schedule and there are no open alerts.'}
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
          <Zap size={13} className="text-cta" />
          If you act now: {w.title}
        </p>
        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${w.recommended ? 'bg-success-500/10 text-success-500' : 'bg-border/60 text-text-secondary'}`}>
          {w.recommended ? 'Pays for itself' : 'Peace of mind'}
        </span>
      </div>
      <p className="mt-1 text-xs text-text-secondary">{w.detail}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Risk, next 12 months', `${percent(w.riskBefore12m)} → ${percent(w.riskAfter12m)}`],
          ['Expected cost avoided', formatBudgetUsd(w.expectedAvoided)],
          ['Service cost', formatBudgetUsd(w.serviceCost)],
          [w.netBenefit >= 0 ? 'Net expected saving' : 'Net expected cost', formatBudgetUsd(Math.abs(w.netBenefit))],
        ].map(([term, value]) => (
          <div key={term} className="rounded-lg bg-bg-primary p-2.5">
            <dt className="text-[10px] font-medium text-text-secondary">{term}</dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>
      {w.extraLifeYears >= 0.3 && <p className="mt-2 text-[11px] text-success-500">Resolving this adds about {w.extraLifeYears.toFixed(1)} years of expected life.</p>}
      {!w.recommended && <p className="mt-2 text-[11px] text-text-secondary">The expected saving does not cover the service price, so this is shown for risk reduction only.</p>}
    </div>
  );
}

function NodeDetails({ graph, node }: { graph: HomeIntelligenceGraph; node: GraphNode }) {
  const components = childrenOf(graph, node.id);
  const maxImpact = Math.max(...node.drivers.map((d) => d.impact), 0.01);
  return (
    <div className="space-y-3 pt-3">
      <p className="text-xs text-text-secondary">
        {node.headline}.{' '}
        {node.riskNextYear > 0 && <span>Next year, if nothing changes: {percent(node.riskNextYear)}. </span>}
        {node.replaceInMonths !== null && <span>Median time to replacement: {node.replaceInMonths <= 0 ? 'now' : `about ${formatMonths(node.replaceInMonths)}`}.</span>}
      </p>

      {node.drivers.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">What is driving this risk</p>
          <ul className="space-y-2">
            {node.drivers.map((d) => (
              <li key={d.key}>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="font-medium text-text-primary">{d.label}</span>
                  <span className="shrink-0 tabular-nums text-text-secondary">{d.impact >= 0.005 ? `+${points(d.impact)}` : 'baseline'}</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-border/50">
                  <div className="h-full rounded-full bg-accent/70" style={{ width: `${Math.max(3, (d.impact / maxImpact) * 100)}%` }} />
                </div>
                <p className="mt-0.5 text-[11px] text-text-secondary">{d.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <WhatIfPanel node={node} />

      {node.warranty && (
        <p className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          <ShieldCheck size={12} className={node.warranty.active ? 'text-success-500' : 'text-text-secondary'} />
          {node.warranty.active ? 'Manufacturer warranty active — expected repair cost is reduced.' : 'Manufacturer warranty has expired or ends within six months.'}
        </p>
      )}

      {components.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Equipment on record</p>
          <ul className="space-y-1.5">
            {components.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg-secondary px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-text-primary">{c.label}</p>
                  <p className="text-[11px] text-text-secondary">
                    {c.ageAssumed ? 'Age assumed' : `${c.ageYears?.toFixed(1)} yrs old`}
                    {c.lifespanYears ? ` of ${c.lifespanYears}` : ''} · {percent(c.risk12m)} risk in 12 months
                  </p>
                </div>
                <LevelPill level={c.level} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SignalGrid({ signals }: { signals: DataSignal[] }) {
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {signals.map((s) => {
        const style = SIGNAL_STYLE[s.state];
        const Icon = style.icon;
        return (
          <li key={s.key} className="rounded-xl border border-border bg-bg-primary p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-text-primary">{s.label}</p>
              <span className={`flex items-center gap-1 text-[11px] font-medium ${style.className}`}>
                <Icon size={12} aria-hidden />
                {style.label}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-text-secondary">{s.detail}</p>
            {s.improve && <p className="mt-1 text-[11px] font-medium text-accent">{s.improve}</p>}
          </li>
        );
      })}
    </ul>
  );
}

type EnergyStatus = 'loading' | 'ready' | 'unavailable';

export function HomeIntelligenceGraphCard({ twin }: { twin: PropertyTwin }) {
  const { toast } = useToast();
  const siteId = twin.site?.id ?? null;

  const [yearBuilt, setYearBuilt] = useState<number | null>(null);
  const [readings, setReadings] = useState<EnergyReading[]>([]);
  const [energyStatus, setEnergyStatus] = useState<EnergyStatus>('loading');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [month, setMonth] = useState('');
  const [kwh, setKwh] = useState('');
  const [cost, setCost] = useState('');
  const [formError, setFormError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!siteId) return;
    let cancelled = false;
    // Year built and energy are optional inputs: if either is unavailable the graph still works from equipment.
    fetchSiteYearBuilt(siteId)
      .then((value) => !cancelled && setYearBuilt(value))
      .catch(() => undefined);
    setEnergyStatus('loading');
    fetchEnergyReadings(siteId)
      .then((rows) => {
        if (cancelled) return;
        setReadings(rows);
        setEnergyStatus('ready');
      })
      .catch(() => !cancelled && setEnergyStatus('unavailable'));
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  const graph = useMemo(() => computeHomeIntelligenceGraph(twin, { yearBuilt, energyReadings: readings }), [twin, yearBuilt, readings]);

  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const addReading = useCallback(async () => {
    if (!siteId || saving) return;
    const result = validateEnergyInput(month, kwh, cost);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setFormError(undefined);
    setSaving(true);
    try {
      await saveEnergyReading(siteId, result.periodStart, result.energyKwh, result.costUsd);
      setReadings(await fetchEnergyReadings(siteId));
      setKwh('');
      setCost('');
      toast('Energy reading saved — graph updated.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the energy reading.', 'error');
    } finally {
      setSaving(false);
    }
  }, [siteId, saving, month, kwh, cost, toast]);

  const header = (
    <div className="mb-4 flex items-start gap-2">
      <Network size={16} className="mt-0.5 text-cta" />
      <div>
        <p className="text-sm font-semibold text-text-primary">Home Intelligence Graph</p>
        <p className="text-xs text-text-secondary">
          {graph?.homeAgeYears != null ? `${graph.homeAgeYears}-year-old home · ` : ''}Every system, its history and its risk — and what acting now would change
        </p>
      </div>
    </div>
  );

  if (!graph) {
    return (
      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        {header}
        <p className="text-sm text-text-secondary">
          Record the HVAC, water heater, plumbing, electrical, roof or safety equipment installed here, or add the year built in the Lifetime Service Plan, and Vireek will build this home’s graph.
        </p>
      </div>
    );
  }

  const home = graph.nodes.find((n) => n.kind === 'home') as GraphNode;
  const systems = childrenOf(graph, 'home').sort((a, b) => b.risk12m - a.risk12m);

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      {header}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          icon={<Gauge size={13} />}
          label="Home risk, next 12 months"
          value={percent(graph.risk12m)}
          note={`${percent(graph.risk6m)} within 6 months · ${GRAPH_RISK_LABELS[graph.level].toLowerCase()} overall`}
        />
        <Tile icon={<Wallet size={13} />} label="Expected cost if nothing is done" value={formatBudgetUsd(graph.expectedLoss12m)} note="Probability-weighted repair and replacement cost over 12 months" />
        <Tile
          icon={<Zap size={13} />}
          label="If you act now"
          value={graph.actNow ? `−${points(graph.actNow.riskReduction)}` : '—'}
          note={graph.actNow ? `${percent(graph.actNow.riskBefore12m)} → ${percent(graph.actNow.riskAfter12m)} risk · about ${formatBudgetUsd(graph.actNow.netBenefit)} net saving` : 'No service action is expected to pay for itself right now'}
        />
        <Tile icon={<Network size={13} />} label="Graph completeness" value={`${graph.completenessPct}%`} note={CONFIDENCE_COPY[graph.confidence]} />
      </div>

      {graph.insights.length > 0 && (
        <div className="mt-5 space-y-2">
          <p className="text-sm font-semibold text-text-primary">What Vireek sees</p>
          {graph.insights.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => setOpen((prev) => new Set(prev).add(i.nodeId))}
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary p-3 text-left hover:border-accent/40"
            >
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-text-primary">{i.title}</span>
                <LevelPill level={i.severity} />
              </span>
              <span className="mt-1 block text-xs text-text-secondary">{i.body}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-6 border-t border-border pt-4">
        <p className="mb-3 text-sm font-semibold text-text-primary">The home, system by system</p>
        <div className="rounded-xl border border-border bg-bg-primary p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-text-primary">{home.label}</p>
            <LevelPill level={home.level} />
          </div>
          <div className="mt-2">
            <RiskBar value={home.risk12m} baseline={home.baselineRisk12m} level={home.level} label="Home risk over 12 months" />
          </div>
        </div>

        <ul className="ml-3 mt-2 space-y-2 border-l border-border pl-4">
          {systems.map((s) => {
            const expanded = open.has(s.id);
            return (
              <li key={s.id} className="rounded-xl border border-border bg-bg-primary">
                <button
                  type="button"
                  onClick={() => toggle(s.id)}
                  aria-expanded={expanded}
                  aria-controls={`hig-${s.id}`}
                  className="focus-ring flex w-full items-start justify-between gap-3 rounded-xl p-3 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-text-primary">{s.label}</span>
                      <span className="rounded bg-border/50 px-1.5 py-0.5 text-[10px] text-text-secondary">{GRAPH_BASIS_LABELS[s.basis]}</span>
                    </span>
                    <span className="mt-2 block space-y-1">
                      <span className="flex items-center gap-2 text-[11px] text-text-secondary">
                        <span className="w-14 shrink-0">6 months</span>
                        <span className="flex-1"><RiskBar value={s.risk6m} level={s.level} label={`${s.label} risk over 6 months`} /></span>
                        <span className="w-9 shrink-0 text-right tabular-nums">{percent(s.risk6m)}</span>
                      </span>
                      <span className="flex items-center gap-2 text-[11px] text-text-secondary">
                        <span className="w-14 shrink-0">12 months</span>
                        <span className="flex-1"><RiskBar value={s.risk12m} baseline={s.baselineRisk12m} level={s.level} label={`${s.label} risk over 12 months`} /></span>
                        <span className="w-9 shrink-0 text-right tabular-nums">{percent(s.risk12m)}</span>
                      </span>
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-2">
                    <LevelPill level={s.level} />
                    <ChevronDown size={14} className={`text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />
                  </span>
                </button>
                {expanded && (
                  <div id={`hig-${s.id}`} className="border-t border-border px-3 pb-3">
                    <NodeDetails graph={graph} node={s} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 flex items-center gap-1.5 text-[10px] text-text-secondary">
          <span className="inline-block h-2.5 w-0.5 bg-text-primary/50" aria-hidden />
          Marker = typical 12-month risk for a unit of the same age and climate
        </p>
      </div>

      {graph.outlook && (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-border bg-bg-primary p-4">
          <Wallet size={18} className="mt-0.5 shrink-0 text-cta" />
          <p className="text-sm text-text-secondary">
            Over ten years the expected spend on this home is about <span className="font-semibold tabular-nums text-text-primary">{formatBudgetUsd(graph.outlook.tenYearTotal)}</span>. Setting aside roughly{' '}
            <span className="font-semibold tabular-nums text-text-primary">{formatBudgetUsd(graph.outlook.suggestedMonthlyReserve)}</span> a month would fund every scheduled replacement.
          </p>
        </div>
      )}

      <div className="mt-6 border-t border-border pt-4">
        <p className="text-sm font-semibold text-text-primary">Sharpen the graph</p>
        <p className="mb-3 mt-0.5 text-xs text-text-secondary">The graph reads nine inputs. Connected ones are measured; the rest are assumed and labelled as estimates.</p>
        <SignalGrid signals={graph.signals} />

        <div className="mt-4 rounded-xl border border-border bg-bg-primary p-3">
          <p className="text-xs font-semibold text-text-primary">Energy behaviour</p>
          <p className="mt-0.5 text-[11px] text-text-secondary">{graph.energy.summary}</p>
          {energyStatus === 'unavailable' ? (
            <p className="mt-2 text-[11px] text-text-secondary">Energy tracking becomes available after the latest database update is applied.</p>
          ) : (
            <form
              className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-start"
              onSubmit={(e) => {
                e.preventDefault();
                void addReading();
              }}
            >
              <Input label="Month" type="month" max={currentMonth()} value={month} onChange={(e) => setMonth(e.target.value)} disabled={energyStatus !== 'ready' || saving} />
              <Input label="kWh used" inputMode="decimal" placeholder="e.g. 850" value={kwh} onChange={(e) => setKwh(e.target.value.replace(/[^\d.]/g, ''))} disabled={energyStatus !== 'ready' || saving} error={formError} />
              <Input label="Cost (optional)" inputMode="decimal" placeholder="e.g. 112.40" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.]/g, ''))} disabled={energyStatus !== 'ready' || saving} />
              <div className="sm:pt-[1.625rem]">
                <Button type="submit" size="sm" className="w-full" disabled={energyStatus !== 'ready' || saving}>
                  {saving ? 'Saving…' : 'Add reading'}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>

      <details className="mt-4 text-[11px] text-text-secondary">
        <summary className="flex cursor-pointer items-center gap-1 font-medium text-text-primary">
          <Info size={11} aria-hidden /> How this is estimated
        </summary>
        <div className="mt-2 space-y-1">
          <p>
            Each system is modelled from its age against its expected lifespan, adjusted for climate, property type, repair history, overdue service, open predictive alerts and energy behaviour — the same model as the Lifetime Service Plan. Figures are planning estimates, not quotes.
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {graph.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}
