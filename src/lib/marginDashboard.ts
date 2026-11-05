/**
 * Margin dashboard — pure view-model builders for /staff/margins (no I/O).
 * Cost bases are never blended silently:
 *   - voice cost from call_cost_components is PROVIDER-REPORTED (webhook), not invoice-reconciled;
 *   - voice minutes WITHOUT a reported cost use a staff-chosen $/min fallback and are ESTIMATED;
 *   - AI cost is a list-price ESTIMATE (ai_usage_logs); revenue is list price prorated + overage (ESTIMATE).
 */
import { THIN_MARGIN_PCT, planEconomics, type Health } from './staffUsage';
import { percentile, grossMargin, resolveRate, type CostComponent, type CostRate } from './unitEconomics';
import { freeTierCostPerSignup, type Projection } from './marginModel';
import type { AiPricingSummary } from './aiRepricing';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export interface UeTenantRow {
  account_id: string; email: string | null; company_name: string | null; plan: string | null;
  voice_seconds: number; voice_calls: number; reported_voice_cost_usd: number; calls_with_cost: number; ai_cost_usd: number;
}
export interface UeComponentRow { component: string; cost_usd: number; calls: number }
export interface UeInvoiceRow { provider: string; period_month: string; invoiced_usd: number; invoice_ref: string | null }
export interface UeReport {
  tenants: UeTenantRow[]; components: UeComponentRow[]; reported_voice_total_usd: number;
  calls_total: number; calls_with_cost: number; invoices: UeInvoiceRow[]; truncated: boolean;
}

export function parseUeReport(raw: unknown): UeReport | null {
  if (!isObj(raw) || !Array.isArray(raw.tenants)) return null;
  const tenants: UeTenantRow[] = [];
  for (const t of raw.tenants) {
    if (!isObj(t)) continue;
    const id = str(t.account_id);
    if (!id) continue;
    tenants.push({
      account_id: id, email: str(t.email), company_name: str(t.company_name), plan: str(t.plan),
      voice_seconds: num(t.voice_seconds), voice_calls: num(t.voice_calls), reported_voice_cost_usd: num(t.reported_voice_cost_usd),
      calls_with_cost: num(t.calls_with_cost), ai_cost_usd: num(t.ai_cost_usd),
    });
  }
  const components = (Array.isArray(raw.components) ? raw.components : []).filter(isObj).map((c) => ({ component: str(c.component) ?? 'unknown', cost_usd: num(c.cost_usd), calls: num(c.calls) }));
  const invoices = (Array.isArray(raw.invoices) ? raw.invoices : []).filter(isObj).map((i) => ({ provider: str(i.provider) ?? '', period_month: str(i.period_month) ?? '', invoiced_usd: num(i.invoiced_usd), invoice_ref: str(i.invoice_ref) }));
  return { tenants, components, reported_voice_total_usd: num(raw.reported_voice_total_usd), calls_total: num(raw.calls_total), calls_with_cost: num(raw.calls_with_cost), invoices, truncated: raw.truncated === true };
}

export interface MarginExtras { signupByAccount: Record<string, string>; features: { task: string; cost_usd: number; calls: number }[] }
export function parseExtras(raw: unknown): MarginExtras {
  const out: MarginExtras = { signupByAccount: {}, features: [] };
  if (!isObj(raw)) return out;
  for (const c of Array.isArray(raw.cohorts) ? raw.cohorts : []) {
    if (isObj(c) && str(c.account_id) && str(c.signup_month)) out.signupByAccount[c.account_id as string] = c.signup_month as string;
  }
  for (const f of Array.isArray(raw.features) ? raw.features : []) {
    if (isObj(f)) out.features.push({ task: str(f.task) ?? 'unknown', cost_usd: num(f.cost_usd), calls: num(f.calls) });
  }
  return out;
}

export type VoiceBasis = 'provider_reported' | 'mixed' | 'estimated' | 'none';

export interface TenantMargin {
  accountId: string; name: string; plan: string; planName: string;
  voiceMinutes: number; voiceCalls: number; callsWithCost: number; voiceBasis: VoiceBasis;
  voiceReportedUsd: number; voiceEstimatedUsd: number; voiceUnpriced: boolean; aiEstimatedUsd: number;
  totalCostUsd: number; revenueUsd: number | null; marginUsd: number | null; marginPct: number | null; health: Health;
}

/** `fallbackVoiceCpm` prices ONLY the voice minutes that have no provider-reported cost; null = leave them unpriced. */
export function buildTenantMargins(rows: UeTenantRow[], opts: { fallbackVoiceCpm: number | null; days: number }): TenantMargin[] {
  return rows.map((r) => {
    const plan = planEconomics(r.plan);
    const voiceMinutes = r.voice_seconds / 60;
    const uncoveredShare = r.voice_calls > 0 ? Math.min(1, Math.max(0, (r.voice_calls - r.calls_with_cost) / r.voice_calls)) : 0;
    const uncoveredMinutes = voiceMinutes * uncoveredShare;
    const voiceUnpriced = uncoveredMinutes > 0 && opts.fallbackVoiceCpm === null;
    const voiceEstimatedUsd = opts.fallbackVoiceCpm === null ? 0 : uncoveredMinutes * opts.fallbackVoiceCpm;
    const voiceBasis: VoiceBasis = r.voice_calls === 0 ? 'none' : uncoveredShare === 0 ? 'provider_reported' : r.calls_with_cost === 0 ? 'estimated' : 'mixed';
    const totalCostUsd = r.reported_voice_cost_usd + voiceEstimatedUsd + r.ai_cost_usd;

    let revenueUsd: number | null = null;
    if (plan.monthlyPrice !== null) {
      const sub = (plan.monthlyPrice * opts.days) / 30;
      const included = (plan.includedMinutes * opts.days) / 30;
      const over = plan.overageRate !== null ? Math.max(0, voiceMinutes - included) : 0;
      revenueUsd = sub + over * (plan.overageRate ?? 0);
    }
    const g = revenueUsd === null ? null : grossMargin(revenueUsd, totalCostUsd);
    let health: Health;
    if (revenueUsd === null) health = 'unpriced';
    else if (g && g.marginUsd < 0) health = 'loss';
    else if (g && g.marginPct !== null && g.marginPct < THIN_MARGIN_PCT) health = 'thin';
    else health = 'healthy';
    return {
      accountId: r.account_id, name: r.company_name || r.email || `Account ${r.account_id.slice(0, 8)}`, plan: r.plan ?? 'unknown', planName: plan.name,
      voiceMinutes, voiceCalls: r.voice_calls, callsWithCost: r.calls_with_cost, voiceBasis,
      voiceReportedUsd: r.reported_voice_cost_usd, voiceEstimatedUsd, voiceUnpriced, aiEstimatedUsd: r.ai_cost_usd,
      totalCostUsd, revenueUsd, marginUsd: g?.marginUsd ?? null, marginPct: g?.marginPct ?? null, health,
    };
  });
}

/** Paying orgs (revenue > 0) that lose money. Free-tier orgs are tracked separately via freeTierSummary. */
const isPayingLoss = (m: TenantMargin): boolean => (m.revenueUsd ?? 0) > 0 && m.marginUsd !== null && m.marginUsd < 0;

export interface PlanStat {
  plan: string; planName: string; tenants: number; revenueUsd: number; costUsd: number; marginUsd: number; marginPct: number | null;
  marginPctP10: number | null; marginPctP50: number | null; marginPctP90: number | null;
  costP10: number | null; costP50: number | null; costP90: number | null; lossTenants: number;
}

export function buildPlanStats(ms: TenantMargin[]): PlanStat[] {
  const groups = new Map<string, TenantMargin[]>();
  for (const m of ms) groups.set(m.plan, [...(groups.get(m.plan) ?? []), m]);
  const out: PlanStat[] = [];
  for (const [plan, g] of groups) {
    const revenueUsd = g.reduce((s, m) => s + (m.revenueUsd ?? 0), 0);
    const costUsd = g.reduce((s, m) => s + m.totalCostUsd, 0);
    const pcts = g.filter((m) => m.marginPct !== null).map((m) => m.marginPct as number);
    const costs = g.map((m) => m.totalCostUsd);
    out.push({
      plan, planName: g[0].planName, tenants: g.length, revenueUsd, costUsd, marginUsd: revenueUsd - costUsd,
      marginPct: grossMargin(revenueUsd, costUsd).marginPct,
      marginPctP10: percentile(pcts, 10), marginPctP50: percentile(pcts, 50), marginPctP90: percentile(pcts, 90),
      costP10: percentile(costs, 10), costP50: percentile(costs, 50), costP90: percentile(costs, 90),
      lossTenants: g.filter(isPayingLoss).length,
    });
  }
  return out.sort((a, b) => b.revenueUsd - a.revenueUsd);
}

export interface MarginSummary {
  tenants: number; unpricedTenants: number; revenueUsd: number; voiceReportedUsd: number; voiceEstimatedUsd: number; aiEstimatedUsd: number;
  totalCostUsd: number; marginUsd: number; marginPct: number | null; lossTenants: number; voiceUnpricedTenants: number;
}

export function summarizeMargins(ms: TenantMargin[]): MarginSummary {
  const revenueUsd = ms.reduce((s, m) => s + (m.revenueUsd ?? 0), 0);
  const voiceReportedUsd = ms.reduce((s, m) => s + m.voiceReportedUsd, 0);
  const voiceEstimatedUsd = ms.reduce((s, m) => s + m.voiceEstimatedUsd, 0);
  const aiEstimatedUsd = ms.reduce((s, m) => s + m.aiEstimatedUsd, 0);
  const totalCostUsd = voiceReportedUsd + voiceEstimatedUsd + aiEstimatedUsd;
  const g = grossMargin(revenueUsd, totalCostUsd);
  return {
    tenants: ms.length, unpricedTenants: ms.filter((m) => m.health === 'unpriced').length, revenueUsd, voiceReportedUsd, voiceEstimatedUsd, aiEstimatedUsd,
    totalCostUsd, marginUsd: g.marginUsd, marginPct: g.marginPct, lossTenants: ms.filter(isPayingLoss).length, voiceUnpricedTenants: ms.filter((m) => m.voiceUnpriced).length,
  };
}

/** Provider-reported cost per voice minute over the calls that HAVE a reported cost; null if < 1 covered minute. */
export function measuredCostPerMinute(ms: TenantMargin[]): number | null {
  let covered = 0;
  let cost = 0;
  for (const m of ms) {
    if (m.voiceCalls <= 0) continue;
    covered += m.voiceMinutes * (m.callsWithCost / m.voiceCalls);
    cost += m.voiceReportedUsd;
  }
  return covered >= 1 ? cost / covered : null;
}

export interface CostDriver { label: string; usd: number; basis: 'provider_reported' | 'estimated' }

export function topCostDrivers(report: UeReport, summary: MarginSummary, limit = 8): CostDriver[] {
  const d: CostDriver[] = report.components.filter((c) => c.cost_usd > 0).map((c) => ({ label: c.component, usd: c.cost_usd, basis: 'provider_reported' as const }));
  if (summary.aiEstimatedUsd > 0) d.push({ label: 'ai_llm_list_price', usd: summary.aiEstimatedUsd, basis: 'estimated' });
  if (summary.voiceEstimatedUsd > 0) d.push({ label: 'voice_uncovered_minutes', usd: summary.voiceEstimatedUsd, basis: 'estimated' });
  return d.sort((a, b) => b.usd - a.usd).slice(0, limit);
}

export function negativeMarginOrgs(ms: TenantMargin[], limit = 15): TenantMargin[] {
  return ms.filter(isPayingLoss).sort((a, b) => (a.marginUsd as number) - (b.marginUsd as number)).slice(0, limit);
}

export function freeTierSummary(ms: TenantMargin[]): { orgs: number; avgCostUsd: number | null } {
  const free = ms.filter((m) => m.plan === 'free');
  return { orgs: free.length, avgCostUsd: freeTierCostPerSignup(free.map((m) => m.totalCostUsd)) };
}

export interface CohortStat { cohort: string; tenants: number; revenueUsd: number; costUsd: number; marginPct: number | null }

export function cohortStats(ms: TenantMargin[], signupByAccount: Record<string, string>): CohortStat[] {
  const g = new Map<string, TenantMargin[]>();
  for (const m of ms) { const k = signupByAccount[m.accountId] ?? 'unknown'; g.set(k, [...(g.get(k) ?? []), m]); }
  return [...g.entries()].map(([cohort, rows]) => {
    const revenueUsd = rows.reduce((s, m) => s + (m.revenueUsd ?? 0), 0);
    const costUsd = rows.reduce((s, m) => s + m.totalCostUsd, 0);
    return { cohort, tenants: rows.length, revenueUsd, costUsd, marginPct: grossMargin(revenueUsd, costUsd).marginPct };
  }).sort((a, b) => (a.cohort < b.cohort ? 1 : -1));
}

/** Monthly-normalised minutes per org on a plan; the usage distribution the simulator projects with. */
export function monthlyMinutesSamples(ms: TenantMargin[], plan: string, days: number): number[] {
  return ms.filter((m) => m.plan === plan).map((m) => (m.voiceMinutes * 30) / Math.max(1, days));
}

export function defaultAssumptions(a: { fallbackVoiceCpm: number | null; days: number; callsTotal: number; callsWithCost: number; ai?: AiPricingSummary }): string[] {
  const cov = a.callsTotal > 0 ? Math.round((a.callsWithCost / a.callsTotal) * 100) : 0;
  return [
    `Window: ${a.days} days. Monthly prices are prorated to the window (days / 30).`,
    `Revenue (ESTIMATE): plan list price prorated plus metered overage. Not read from Stripe invoices.`,
    `Voice cost (MEASURED by provider, not invoice-reconciled): ${a.callsWithCost} of ${a.callsTotal} calls (${cov}%) have a provider-reported cost.`,
    a.fallbackVoiceCpm === null
      ? 'Voice minutes without a reported cost are left UNPRICED (no fallback rate set); margins are overstated by that amount.'
      : `Voice minutes without a reported cost use a fallback of $${a.fallbackVoiceCpm.toFixed(4)}/min (ESTIMATE, staff-entered assumption).`,
    a.ai
      ? `AI cost (ESTIMATE): ${a.ai.rateTableUsd.toFixed(2)} USD priced from your provider rate table, ${a.ai.codeListUsd.toFixed(2)} USD from the list prices hard-coded in costTracking.ts; ${a.ai.unpricedCalls} of ${a.ai.totalCalls} calls (e.g. Cloudflare) have NO price and count as $0; ${a.ai.estimatedTokenCalls} calls use token counts estimated by us (under-counts non-Latin text).`
      : 'AI cost (ESTIMATE): token counts x list prices in costTracking.ts; Cloudflare is priced at $0 there, so true AI cost is likely higher.',
    'SMS segments, storage, embeddings and vision are not included in tenant margins unless metered in cost_usage_events and priced in provider_cost_rates.',
    'Percentiles are across organisations in this window, including dormant ones.',
  ];
}

// ---------------------------------------------------------------------------
// Metered usage (SMS segments, storage, embeddings, vision): quantity x provider_cost_rates = ESTIMATE
// ---------------------------------------------------------------------------
export interface UsageEventTotal { component: string; unit: string; quantity: number; events: number }
export interface PricedUsage extends UsageEventTotal { costUsd: number | null; status: 'priced' | 'unpriced' | 'ambiguous' }

export function parseUsageEvents(raw: unknown): UsageEventTotal[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).map((r) => ({ component: str(r.component) ?? 'unknown', unit: str(r.unit) ?? '', quantity: num(r.quantity), events: num(r.events) }));
}

/** A component+unit is priced only when exactly ONE provider has a rate in effect; several providers = ambiguous, none = unpriced. */
export function priceUsageEvents(events: UsageEventTotal[], rates: CostRate[], onDate: string): PricedUsage[] {
  return events.map((e) => {
    const providers = [...new Set(rates.filter((r) => r.component === e.component && r.unit === e.unit).map((r) => r.provider))];
    const inEffect = providers.map((p) => resolveRate(rates, e.component as CostComponent, p, e.unit, onDate)).filter((r): r is CostRate => r !== null);
    if (inEffect.length === 0) return { ...e, costUsd: null, status: 'unpriced' as const };
    if (inEffect.length > 1) return { ...e, costUsd: null, status: 'ambiguous' as const };
    return { ...e, costUsd: e.quantity * inEffect[0].rateUsd, status: 'priced' as const };
  });
}

/** Plain-language recommendations only; this module never changes prices. */
export function planAdvice(p: Projection, breakEven: number | null, includedMinutes: number): string[] {
  const out: string[] = [];
  if (p.sampleSize === 0) return ['No usage history for this plan in the selected window, so no projection is possible.'];
  if (p.p50 && p.p50.marginPct !== null && p.p50.marginPct < THIN_MARGIN_PCT) out.push(`Median org margin is ${p.p50.marginPct.toFixed(0)}%, below the ${THIN_MARGIN_PCT}% thin-margin line: consider a higher price or a lower rate on included minutes.`);
  if (p.negativeShare !== null && p.negativeShare > 0.1) out.push(`${Math.round(p.negativeShare * 100)}% of orgs would lose money at these terms.`);
  if (breakEven !== null && breakEven < includedMinutes) out.push(`Margin turns negative at ${Math.round(breakEven)} min/month, inside the ${includedMinutes} included minutes: included minutes cost more than the price recovers.`);
  if (breakEven === null) out.push('Overage revenue covers cost per minute, so margin never turns negative at these inputs.');
  if (out.length === 0) out.push('Margins look healthy at these inputs. Check the sensitivity table before relying on them.');
  return out;
}
