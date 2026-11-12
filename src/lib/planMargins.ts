/**
 * List-price gross margin per plan, priced from the provider rate table (pure, no I/O).
 * Rule kept from unitEconomics.ts: a missing or ambiguous rate is "unpriced", never $0 — so a plan is never
 * reported as profitable because a component was left out.
 */
import { grossMargin, resolveRate, type CostComponent, type CostLine, type CostRate } from './unitEconomics';
import { planEconomics } from './staffUsage';
import { PRICING_PLANS } from './pricing';

/** Plans whose gross margin at 100% use of the included minutes is below this are flagged. */
export const GROSS_MARGIN_FLOOR_PCT = 45;

export type CallDirection = 'inbound' | 'outbound';

export function voiceComponents(direction: CallDirection): CostComponent[] {
  return ['voice_platform', direction === 'inbound' ? 'carrier_inbound' : 'carrier_outbound', 'asr', 'llm', 'tts'];
}

/** Badge for a rate's `status`. null status = entered by a human / legacy row: no badge. */
export function rateBadge(status: string | null | undefined): { label: string; tone: 'warn' | 'info' } | null {
  if (status === null || status === undefined || status === 'official') return null;
  if (status === 'assumption') return { label: 'Assumption', tone: 'warn' };
  if (status === 'secondary_source') return { label: 'Secondary source', tone: 'info' };
  return { label: 'Rate not verified', tone: 'warn' }; // 'unverified' and any unknown value: be conservative
}

export const isRateNotVerified = (status: string | null | undefined): boolean => rateBadge(status) !== null;

type Pick = { state: 'ok'; rate: CostRate } | { state: 'missing' } | { state: 'ambiguous' };

/** Exactly one provider with a per_minute rate in effect = priced; none = missing; several = ambiguous. */
function pickPerMinute(rates: CostRate[], component: CostComponent, onDate: string): Pick {
  const providers = [...new Set(rates.filter((r) => r.component === component && r.unit === 'per_minute').map((r) => r.provider))];
  const inEffect = providers.map((p) => resolveRate(rates, component, p, 'per_minute', onDate)).filter((r): r is CostRate => r !== null);
  if (inEffect.length === 0) return { state: 'missing' };
  if (inEffect.length > 1) return { state: 'ambiguous' };
  return { state: 'ok', rate: inEffect[0] };
}

export interface VoiceCostEstimate {
  lines: CostLine[]; // basis is always 'estimated'
  /** null when any component is missing/ambiguous: a partial sum would overstate margin. */
  totalUsd: number | null;
  costPerMinuteUsd: number | null;
  missing: CostComponent[];
  ambiguous: CostComponent[];
  unverified: CostComponent[];
}

export function estimateVoiceCost(rates: CostRate[], args: { minutes: number; direction?: CallDirection }, onDate: string): VoiceCostEstimate {
  const { minutes, direction = 'inbound' } = args;
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError('minutes must be a finite number >= 0');
  const out: VoiceCostEstimate = { lines: [], totalUsd: 0, costPerMinuteUsd: 0, missing: [], ambiguous: [], unverified: [] };
  for (const component of voiceComponents(direction)) {
    const p = pickPerMinute(rates, component, onDate);
    if (p.state === 'missing') { out.missing.push(component); continue; }
    if (p.state === 'ambiguous') { out.ambiguous.push(component); continue; }
    out.lines.push({ component, amountUsd: minutes * p.rate.rateUsd, basis: 'estimated' });
    out.costPerMinuteUsd = (out.costPerMinuteUsd as number) + p.rate.rateUsd;
    out.totalUsd = (out.totalUsd as number) + minutes * p.rate.rateUsd;
    if (isRateNotVerified(p.rate.status)) out.unverified.push(component);
  }
  if (out.missing.length > 0 || out.ambiguous.length > 0) { out.totalUsd = null; out.costPerMinuteUsd = null; }
  return out;
}

export interface PlanInput { id: string; name: string; monthlyPrice: number | null; includedMinutes: number }

export type PlanMarginStatus = 'ok' | 'below_floor' | 'unpriced' | 'not_applicable';

export interface PlanListMargin {
  plan: string; planName: string; priceUsd: number | null; includedMinutes: number | null;
  costAtFullUseUsd: number | null; marginUsd: number | null; marginPct: number | null;
  status: PlanMarginStatus; unverified: CostComponent[]; missing: CostComponent[]; rateNotVerified: boolean;
}

export function defaultPlanInputs(): PlanInput[] {
  return PRICING_PLANS.map((p) => {
    const e = planEconomics(p.id);
    return { id: p.id, name: e.name, monthlyPrice: e.monthlyPrice, includedMinutes: e.includedMinutes };
  });
}

/**
 * Gross margin when a customer uses 100% of the included minutes: revenue = list price, cost = included minutes x the
 * per-minute voice cost from the rate table (+ `smsAllowanceCostUsd`, 0 because no SMS allowance exists in the catalog).
 * Strictly below GROSS_MARGIN_FLOOR_PCT (or negative) = 'below_floor'. Free / custom plans are 'not_applicable'.
 */
export function buildPlanListMargins(
  rates: CostRate[], onDate: string,
  opts: { plans?: PlanInput[]; direction?: CallDirection; smsAllowanceCostUsd?: number; floorPct?: number } = {},
): PlanListMargin[] {
  const { plans = defaultPlanInputs(), direction = 'inbound', smsAllowanceCostUsd = 0, floorPct = GROSS_MARGIN_FLOOR_PCT } = opts;
  return plans.map((p) => {
    const hasTerms = p.monthlyPrice !== null && p.monthlyPrice > 0 && Number.isFinite(p.includedMinutes) && p.includedMinutes > 0;
    const base = { plan: p.id, planName: p.name, priceUsd: p.monthlyPrice, includedMinutes: Number.isFinite(p.includedMinutes) ? p.includedMinutes : null };
    if (!hasTerms) {
      return { ...base, costAtFullUseUsd: null, marginUsd: null, marginPct: null, status: 'not_applicable' as const, unverified: [], missing: [], rateNotVerified: false };
    }
    const est = estimateVoiceCost(rates, { minutes: p.includedMinutes, direction }, onDate);
    if (est.totalUsd === null) {
      return { ...base, costAtFullUseUsd: null, marginUsd: null, marginPct: null, status: 'unpriced' as const, unverified: est.unverified, missing: [...est.missing, ...est.ambiguous], rateNotVerified: est.unverified.length > 0 };
    }
    const cost = est.totalUsd + smsAllowanceCostUsd;
    const g = grossMargin(p.monthlyPrice as number, cost);
    const below = g.marginPct !== null && g.marginPct + 1e-9 < floorPct;
    return {
      ...base, costAtFullUseUsd: cost, marginUsd: g.marginUsd, marginPct: g.marginPct, status: below ? ('below_floor' as const) : ('ok' as const),
      unverified: est.unverified, missing: [], rateNotVerified: est.unverified.length > 0,
    };
  });
}
