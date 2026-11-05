import { UsageCostChart } from '@/components/staff/UsageCostChart';
import { EmptyState } from '@/components/EmptyState';
import { BarChart3 } from 'lucide-react';
import { formatMinutes, formatPct, formatUsd, type DailyCostPoint } from '@/lib/staffUsage';
import type { CohortStat, CostDriver, MarginExtras, MarginSummary, PlanStat, PricedUsage, TenantMargin } from '@/lib/marginDashboard';
import type { AiModelCost, AiPricingSummary } from '@/lib/aiRepricing';
import { BasisTag, Kpi, Section, TableWrap, TD, TDR, TH, THR } from './shared';

export interface OverviewProps {
  summary: MarginSummary; plans: PlanStat[]; negative: TenantMargin[]; drivers: CostDriver[]; cohorts: CohortStat[];
  features: MarginExtras['features']; freeTier: { orgs: number; avgCostUsd: number | null }; daily: DailyCostPoint[];
  coverage: { callsTotal: number; callsWithCost: number }; measuredCpm: number | null; usage: PricedUsage[]; truncated: boolean;
  aiSummary: AiPricingSummary; aiCoverage: AiModelCost[];
}
const AI_BASIS_LABEL = { rate_table: 'Your rate table', code_list_price: 'Code list price', unpriced: 'No price (counts as $0)' } as const;
const COMPONENT_LABEL: Record<string, string> = {
  carrier_inbound: 'Carrier (inbound)', carrier_outbound: 'Carrier (outbound)', carrier_unclassified: 'Carrier (direction unknown)', asr: 'Speech-to-text',
  llm: 'LLM (voice)', tts: 'Text-to-speech', voice_platform: 'Voice platform fee', provider_other: 'Other provider cost', provider_total_unbroken: 'Provider total (no breakdown)',
  ai_llm_list_price: 'AI features (list price)', voice_uncovered_minutes: 'Voice minutes without reported cost', sms_segment: 'SMS segments',
};
const label = (k: string) => COMPONENT_LABEL[k] ?? k;

export function MarginOverview(p: OverviewProps) {
  const s = p.summary;
  const cov = p.coverage.callsTotal > 0 ? Math.round((p.coverage.callsWithCost / p.coverage.callsTotal) * 100) : 0;
  if (s.tenants === 0) return <EmptyState icon={BarChart3} title="No tenants yet" description="Once tenant accounts exist, their margins appear here." />;
  return (
    <div className="space-y-6">
      {p.truncated && <p role="status" className="rounded-xl border border-warning bg-warning/10 p-3 text-sm text-text-primary">Only the 5,000 highest-cost organisations are shown; totals exclude the rest.</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Revenue (estimate)" value={formatUsd(s.revenueUsd, { compact: true })} sub={`${s.tenants} orgs · ${s.unpricedTenants} unpriced plan`} />
        <Kpi label="Total cost" value={formatUsd(s.totalCostUsd, { compact: true })} sub={`Measured voice ${formatUsd(s.voiceReportedUsd, { compact: true })} · estimated ${formatUsd(s.voiceEstimatedUsd + s.aiEstimatedUsd, { compact: true })}`} />
        <Kpi label="Gross margin" value={formatPct(s.marginPct)} sub={`${formatUsd(s.marginUsd, { compact: true })} · ${s.lossTenants} paying orgs losing money`} tone={s.marginUsd < 0 ? 'bad' : 'good'} />
        <Kpi label="Cost data coverage" value={`${cov}%`} sub={`${p.coverage.callsWithCost} of ${p.coverage.callsTotal} calls have a provider-reported cost`} tone={cov < 90 ? 'bad' : undefined} />
      </div>
      {s.voiceUnpricedTenants > 0 && <p role="status" className="rounded-xl border border-warning bg-warning/10 p-3 text-sm text-text-primary">{s.voiceUnpricedTenants} orgs have voice minutes with no reported cost and no fallback rate set, so their margin is overstated. Set a fallback $/min in the header{p.measuredCpm !== null ? ` (measured so far: ${formatUsd(p.measuredCpm)}/min)` : ''}.</p>}

      <Section title="Margin by plan" aside={<span className="text-xs text-text-secondary">p10 / p50 / p90 of org margin %</span>}>
        <TableWrap caption="Margin by plan">
          <thead><tr><th scope="col" className={TH}>Plan</th><th scope="col" className={THR}>Orgs</th><th scope="col" className={THR}>Revenue</th><th scope="col" className={THR}>Cost</th><th scope="col" className={THR}>Margin</th><th scope="col" className={THR}>p10 / p50 / p90</th><th scope="col" className={THR}>Cost p50 / p90</th><th scope="col" className={THR}>Losing</th></tr></thead>
          <tbody>{p.plans.map((r) => (
            <tr key={r.plan} className="border-t border-border">
              <th scope="row" className={`${TD} font-medium`}>{r.planName}</th><td className={TDR}>{r.tenants}</td><td className={TDR}>{formatUsd(r.revenueUsd, { compact: true })}</td><td className={TDR}>{formatUsd(r.costUsd, { compact: true })}</td>
              <td className={TDR}>{formatPct(r.marginPct)}</td><td className={TDR}>{formatPct(r.marginPctP10)} / {formatPct(r.marginPctP50)} / {formatPct(r.marginPctP90)}</td>
              <td className={TDR}>{formatUsd(r.costP50)} / {formatUsd(r.costP90)}</td><td className={TDR}>{r.lossTenants}</td>
            </tr>))}</tbody>
        </TableWrap>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Top cost drivers">
          <TableWrap caption="Top cost drivers">
            <thead><tr><th scope="col" className={TH}>Driver</th><th scope="col" className={THR}>Cost</th><th scope="col" className={TH}>Basis</th></tr></thead>
            <tbody>{p.drivers.map((d) => <tr key={d.label} className="border-t border-border"><td className={TD}>{label(d.label)}</td><td className={TDR}>{formatUsd(d.usd)}</td><td className={TD}><BasisTag basis={d.basis} /></td></tr>)}</tbody>
          </TableWrap>
        </Section>
        <Section title="Free tier">
          <p className="text-2xl font-bold tabular-nums text-text-primary">{formatUsd(p.freeTier.avgCostUsd)}</p>
          <p className="mt-1 text-sm text-text-secondary">average cost per free organisation in this window ({p.freeTier.orgs} orgs, estimate + measured voice). Signup time is not part of this figure.</p>
        </Section>
      </div>

      <Section title="Negative-margin organisations" aside={<span className="text-xs text-text-secondary">paying orgs only</span>}>
        {p.negative.length === 0 ? <p className="text-sm text-text-secondary">None in this window.</p> : (
          <TableWrap caption="Negative-margin organisations">
            <thead><tr><th scope="col" className={TH}>Organisation</th><th scope="col" className={TH}>Plan</th><th scope="col" className={THR}>Minutes</th><th scope="col" className={THR}>Revenue</th><th scope="col" className={THR}>Cost</th><th scope="col" className={THR}>Margin</th><th scope="col" className={TH}>Voice basis</th></tr></thead>
            <tbody>{p.negative.map((o) => (
              <tr key={o.accountId} className="border-t border-border"><th scope="row" className={`${TD} font-medium`}>{o.name}</th><td className={TD}>{o.planName}</td><td className={TDR}>{formatMinutes(o.voiceMinutes)}</td>
                <td className={TDR}>{formatUsd(o.revenueUsd)}</td><td className={TDR}>{formatUsd(o.totalCostUsd)}</td><td className={`${TDR} text-danger`}>{formatUsd(o.marginUsd)}</td><td className={TD}><BasisTag basis={o.voiceBasis} /></td></tr>))}</tbody>
          </TableWrap>)}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Margin by signup cohort">
          <TableWrap caption="Margin by signup cohort">
            <thead><tr><th scope="col" className={TH}>Cohort</th><th scope="col" className={THR}>Orgs</th><th scope="col" className={THR}>Revenue</th><th scope="col" className={THR}>Cost</th><th scope="col" className={THR}>Margin</th></tr></thead>
            <tbody>{p.cohorts.slice(0, 12).map((c) => <tr key={c.cohort} className="border-t border-border"><th scope="row" className={`${TD} font-medium`}>{c.cohort}</th><td className={TDR}>{c.tenants}</td><td className={TDR}>{formatUsd(c.revenueUsd, { compact: true })}</td><td className={TDR}>{formatUsd(c.costUsd, { compact: true })}</td><td className={TDR}>{formatPct(c.marginPct)}</td></tr>)}</tbody>
          </TableWrap>
        </Section>
        <Section title="AI cost by feature (estimate)">
          {p.features.length === 0 ? <p className="text-sm text-text-secondary">No AI usage in this window.</p> : (
            <TableWrap caption="AI cost by feature">
              <thead><tr><th scope="col" className={TH}>Task</th><th scope="col" className={THR}>Calls</th><th scope="col" className={THR}>Cost</th></tr></thead>
              <tbody>{p.features.slice(0, 12).map((f) => <tr key={f.task} className="border-t border-border"><td className={TD}>{f.task}</td><td className={TDR}>{f.calls}</td><td className={TDR}>{formatUsd(f.cost_usd)}</td></tr>)}</tbody>
            </TableWrap>)}
        </Section>
      </div>

      <Section title="AI pricing coverage (estimate)" aside={<span className="text-xs text-text-secondary">{formatUsd(p.aiSummary.rateTableUsd)} from your rates · {formatUsd(p.aiSummary.codeListUsd)} from code list prices · {p.aiSummary.unpricedCalls} unpriced calls</span>}>
        {p.aiCoverage.length === 0 ? <p className="text-sm text-text-secondary">No AI usage in this window.</p> : (
          <TableWrap caption="AI pricing coverage by provider and model">
            <thead><tr><th scope="col" className={TH}>Provider / model</th><th scope="col" className={THR}>Calls</th><th scope="col" className={THR}>Input tokens</th><th scope="col" className={THR}>Output tokens</th><th scope="col" className={THR}>Cost</th><th scope="col" className={TH}>Priced from</th><th scope="col" className={THR}>Tokens estimated</th></tr></thead>
            <tbody>{p.aiCoverage.slice(0, 15).map((m) => <tr key={`${m.provider}-${m.model}`} className="border-t border-border"><th scope="row" className={`${TD} font-medium`}>{m.provider} / {m.model}</th><td className={TDR}>{m.calls}</td><td className={TDR}>{String(Math.round(m.inputTokens))}</td><td className={TDR}>{String(Math.round(m.outputTokens))}</td><td className={TDR}>{formatUsd(m.costUsd)}</td><td className={TD}>{AI_BASIS_LABEL[m.basis]}</td><td className={TDR}>{formatPct(m.estimatedTokenShare * 100)}</td></tr>)}</tbody>
          </TableWrap>)}
        <p className="mt-2 text-xs text-text-secondary">Add per-provider token rates (component “llm”, units per_1m_input_tokens and per_1m_output_tokens) under Inputs to price a provider from your own numbers. Estimated token counts under-count non-Latin text.</p>
      </Section>
      <Section title="Metered usage (quantity × your rates = estimate)">
        {p.usage.length === 0 ? <p className="text-sm text-text-secondary">No metered usage events in this window.</p> : (
          <TableWrap caption="Metered usage">
            <thead><tr><th scope="col" className={TH}>Component</th><th scope="col" className={TH}>Unit</th><th scope="col" className={THR}>Quantity</th><th scope="col" className={THR}>Est. cost</th><th scope="col" className={TH}>Status</th></tr></thead>
            <tbody>{p.usage.map((u) => <tr key={`${u.component}-${u.unit}`} className="border-t border-border"><td className={TD}>{label(u.component)}</td><td className={TD}>{u.unit}</td><td className={TDR}>{String(Math.round(u.quantity))}</td><td className={TDR}>{formatUsd(u.costUsd)}</td><td className={TD}>{u.status === 'priced' ? 'Priced from your rates' : u.status === 'ambiguous' ? 'Several providers have a rate: pick one by ending the others' : 'No rate entered'}</td></tr>)}</tbody>
          </TableWrap>)}
      </Section>

      <Section title="Daily cost trend (estimate)"><UsageCostChart points={p.daily} /></Section>
    </div>
  );
}
