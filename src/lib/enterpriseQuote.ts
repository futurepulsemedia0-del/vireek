/**
 * Enterprise quote calculator — pure (no I/O, no clock, no randomness). STAFF-ONLY pricing tool.
 *
 * Cost-plus floor: price = cost-to-serve / (1 - targetGrossMargin), then rounded UP to a sellable list price.
 * Every output is an ESTIMATE built from the inputs and rates given; it recommends, it never changes prices.
 *
 * Units: inputs are minutes / counts / USD per month; outputs are integer CENTS per month (annual = per year).
 *
 * Default rates are deliberately an explicit constant set in THIS module (not imported from
 * `staffUsage.DEFAULT_VOICE_COST_PER_MIN`, which is a 0.12 blended /staff/margins assumption). Quotes must be
 * reproducible from the documented constants below; override any of them via the `rates` argument.
 *
 * Formulas
 *   nonVoiceMonthlyCost = smsPerMonth × (smsCarrierCostPerMessage + smsPlatformCostPerMessage)
 *                         + phoneNumbers × phoneNumberMonthlyCost + supportMonthly + fixedAllocation
 *   costToServe         = committedMinutes × voiceCostPerMinute + nonVoiceMonthlyCost
 *   monthlyFloor        = costToServe / (1 − targetGrossMargin)
 *   listPrice           = max(minListPrice, monthlyFloor rounded UP to the next listPriceStep)
 *   onboarding          = max(onboardingMin, locations × onboardingPerLocation)
 *   annualContract      = 12 × listPrice × (1 − discount)
 *   grossMarginAtFullUse= (listPrice × (1 − discount) − costToServe) / (listPrice × (1 − discount))
 *   Each extra 1,000 committed minutes raises the floor by 1000 × 0.107 / 0.55 ≈ $194.55.
 */

export interface EnterpriseRates {
  /** USD of provider cost per committed voice minute. */
  voiceCostPerMinute: number;
  /** USD/month non-voice base cost allocated to the account (platform, storage, infra). Default `fixedAllocation`. */
  nonVoiceBase: number;
  /** Required gross margin as a fraction in [0, 1). */
  targetGrossMargin: number;
  /** USD per SMS: carrier cost. */
  smsCarrierCostPerMessage: number;
  /** USD per SMS: platform cost. */
  smsPlatformCostPerMessage: number;
  /** USD per phone number per month. */
  phoneNumberMonthlyCost: number;
  /** Minimum monthly list price, USD. */
  minListPriceUsd: number;
  /** List prices are rounded UP to a multiple of this many USD. */
  listPriceStepUsd: number;
  /** Overage price in cents per minute beyond the committed minutes. */
  overageCentsPerMinute: number;
  /** Minimum one-time onboarding fee, USD. */
  onboardingMinUsd: number;
  /** One-time onboarding USD per location; the fee is the larger of this total and the minimum. */
  onboardingPerLocationUsd: number;
}

export const DEFAULT_ENTERPRISE_RATES: Readonly<EnterpriseRates> = Object.freeze({
  voiceCostPerMinute: 0.107,
  nonVoiceBase: 323,
  targetGrossMargin: 0.45,
  smsCarrierCostPerMessage: 0.0083,
  smsPlatformCostPerMessage: 0.0035,
  phoneNumberMonthlyCost: 1.15,
  minListPriceUsd: 1799,
  listPriceStepUsd: 50,
  overageCentsPerMinute: 20,
  onboardingMinUsd: 2500,
  onboardingPerLocationUsd: 500,
});

/** Staff warning threshold: a quote whose gross margin at full committed use is below this must be flagged. */
export const MARGIN_WARNING_THRESHOLD = 0.4;

export interface EnterpriseQuoteInput {
  committedMinutes: number;
  /** Seats are priced as custom/unmetered by Vireek, so they do not change cost; kept for the quote record. */
  seats: number;
  locations: number;
  phoneNumbers: number;
  smsPerMonth: number;
  /** USD/month of dedicated support cost. */
  supportMonthly: number;
  /** Optional discount fraction in [0, 1) applied to the list price. Default 0. */
  discount?: number;
  /** Optional USD/month fixed allocation; defaults to `rates.nonVoiceBase`. */
  fixedAllocation?: number;
}

export interface EnterpriseQuoteResult {
  /** Minimum monthly price (cents) that meets the target margin, rounded up to a whole cent. */
  monthlyFloorCents: number;
  /** Quoted monthly list price (cents) before any discount. */
  listPriceCents: number;
  overageCentsPerMinute: number;
  onboardingCents: number;
  /** 12 × list × (1 − discount), in cents. */
  annualContractCents: number;
  /** Gross margin fraction (0.46 = 46%) at the discounted monthly price when all committed minutes are used. */
  grossMarginAtFullUse: number;
}

const MAX_COUNT = 10_000_000;

function assertRange(name: string, value: unknown, min: number, max: number, integer = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
}

function resolveRates(overrides: Partial<EnterpriseRates> | undefined): EnterpriseRates {
  const merged: EnterpriseRates = { ...DEFAULT_ENTERPRISE_RATES };
  if (overrides) {
    for (const key of Object.keys(DEFAULT_ENTERPRISE_RATES) as (keyof EnterpriseRates)[]) {
      const v = overrides[key];
      if (v !== undefined) merged[key] = v;
    }
  }
  assertRange('voiceCostPerMinute', merged.voiceCostPerMinute, 0, 1000);
  assertRange('nonVoiceBase', merged.nonVoiceBase, 0, 1e9);
  if (typeof merged.targetGrossMargin !== 'number' || !Number.isFinite(merged.targetGrossMargin) || merged.targetGrossMargin < 0 || merged.targetGrossMargin >= 1) {
    throw new RangeError('targetGrossMargin must be in [0, 1)');
  }
  assertRange('smsCarrierCostPerMessage', merged.smsCarrierCostPerMessage, 0, 1000);
  assertRange('smsPlatformCostPerMessage', merged.smsPlatformCostPerMessage, 0, 1000);
  assertRange('phoneNumberMonthlyCost', merged.phoneNumberMonthlyCost, 0, 1e6);
  assertRange('minListPriceUsd', merged.minListPriceUsd, 0, 1e9);
  assertRange('listPriceStepUsd', merged.listPriceStepUsd, 0.01, 1e9);
  assertRange('overageCentsPerMinute', merged.overageCentsPerMinute, 0, 1e6, true);
  assertRange('onboardingMinUsd', merged.onboardingMinUsd, 0, 1e9);
  assertRange('onboardingPerLocationUsd', merged.onboardingPerLocationUsd, 0, 1e9);
  return merged;
}

/** Rounds up to a whole cent, ignoring binary floating-point noise (e.g. 1754.4999999999 vs 1754.5). */
const ceilCents = (cents: number): number => Math.ceil(cents - 1e-6);

export function quoteEnterprise(input: EnterpriseQuoteInput, rates?: Partial<EnterpriseRates>): EnterpriseQuoteResult {
  const r = resolveRates(rates);
  assertRange('committedMinutes', input.committedMinutes, 0, MAX_COUNT);
  assertRange('seats', input.seats, 0, MAX_COUNT, true);
  assertRange('locations', input.locations, 0, MAX_COUNT, true);
  assertRange('phoneNumbers', input.phoneNumbers, 0, MAX_COUNT, true);
  assertRange('smsPerMonth', input.smsPerMonth, 0, 1e9);
  assertRange('supportMonthly', input.supportMonthly, 0, 1e9);
  const discount = input.discount ?? 0;
  if (typeof discount !== 'number' || !Number.isFinite(discount) || discount < 0 || discount >= 1) throw new RangeError('discount must be in [0, 1)');
  const fixedAllocation = input.fixedAllocation ?? r.nonVoiceBase;
  assertRange('fixedAllocation', fixedAllocation, 0, 1e9);

  const nonVoiceMonthlyCost =
    input.smsPerMonth * (r.smsCarrierCostPerMessage + r.smsPlatformCostPerMessage) +
    input.phoneNumbers * r.phoneNumberMonthlyCost +
    input.supportMonthly +
    fixedAllocation;
  const costToServeCents = (input.committedMinutes * r.voiceCostPerMinute + nonVoiceMonthlyCost) * 100;

  const monthlyFloorCents = ceilCents(costToServeCents / (1 - r.targetGrossMargin));
  const stepCents = Math.round(r.listPriceStepUsd * 100);
  const listPriceCents = Math.max(Math.round(r.minListPriceUsd * 100), Math.ceil(monthlyFloorCents / stepCents) * stepCents);
  const onboardingCents = Math.round(Math.max(r.onboardingMinUsd, input.locations * r.onboardingPerLocationUsd) * 100);
  const annualContractCents = Math.round(12 * listPriceCents * (1 - discount));
  const effectiveMonthlyCents = listPriceCents * (1 - discount);
  const grossMarginAtFullUse = effectiveMonthlyCents > 0 ? (effectiveMonthlyCents - costToServeCents) / effectiveMonthlyCents : 0;

  const out: EnterpriseQuoteResult = {
    monthlyFloorCents,
    listPriceCents,
    overageCentsPerMinute: r.overageCentsPerMinute,
    onboardingCents,
    annualContractCents,
    grossMarginAtFullUse,
  };
  if (![monthlyFloorCents, listPriceCents, onboardingCents, annualContractCents].every(Number.isSafeInteger) || !Number.isFinite(grossMarginAtFullUse)) {
    throw new RangeError('quote exceeds supported range');
  }
  return out;
}

/** True when the quote's gross margin at full committed use is below the 40% staff warning threshold. */
export function isBelowMarginWarning(q: Pick<EnterpriseQuoteResult, 'grossMarginAtFullUse'>, threshold = MARGIN_WARNING_THRESHOLD): boolean {
  return q.grossMarginAtFullUse < threshold;
}
