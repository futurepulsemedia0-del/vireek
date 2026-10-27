// Pure card-fee / cash-discount rules shared by the browser (src/lib/paymentPricing.ts re-exports this)
// and the Deno edge functions. No imports, no runtime APIs: keep it that way (same contract as tip.ts).
//
// Money is always integer cents; percentages are integer basis points (300 = 3.00%) so no float drift.

export const PRICING_MODES = ["off", "surcharge", "convenience_fee", "cash_discount"] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

/** Visa / Mastercard ceiling for a credit-card surcharge (lesser of this or the merchant's real cost). */
export const NETWORK_SURCHARGE_CAP_BPS = 300;
export const MAX_CASH_DISCOUNT_BPS = 500;
export const MAX_FLAT_FEE_CENTS = 5_000;
export const MAX_LABEL_LENGTH = 40;
export const MAX_DISCLOSURE_LENGTH = 400;

/** Reviewed 2026-10. Surcharging is prohibited by statute here; cash discounts remain allowed. */
export const BANNED_SURCHARGE_STATES: readonly string[] = ["CT", "MA", "PR"];
/** Sources disagree or rules are narrow: allowed in the UI only with a strong warning. */
export const RESTRICTED_SURCHARGE_STATES: readonly string[] = ["CA", "ME", "OK"];
/** State caps tighter than the card networks. */
export const STATE_SURCHARGE_CAP_BPS: Readonly<Record<string, number>> = { CO: 200 };

export interface PricingSettings {
  mode: PricingMode;
  surchargeBps: number;
  flatFeeCents: number;
  cashDiscountBps: number;
  excludeDebit: boolean;
  businessState: string | null;
  label: string;
  disclosure: string;
}

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  mode: "off",
  surchargeBps: 0,
  flatFeeCents: 0,
  cashDiscountBps: 0,
  excludeDebit: true,
  businessState: null,
  label: "",
  disclosure: "",
};

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

export function normalizeState(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

/** Defensive: turns a DB row (snake_case, maybe null) into a safe PricingSettings. */
export function settingsFromRow(row: Record<string, unknown> | null | undefined): PricingSettings {
  if (!row) return { ...DEFAULT_PRICING_SETTINGS };
  const mode = (PRICING_MODES as readonly string[]).includes(row.mode as string) ? (row.mode as PricingMode) : "off";
  const int = (v: unknown) => (isInt(v) && v >= 0 ? v : 0);
  return {
    mode,
    surchargeBps: int(row.surcharge_bps),
    flatFeeCents: int(row.flat_fee_cents),
    cashDiscountBps: int(row.cash_discount_bps),
    excludeDebit: row.exclude_debit !== false,
    businessState: normalizeState(row.business_state),
    label: typeof row.label === "string" ? row.label.trim().slice(0, MAX_LABEL_LENGTH) : "",
    disclosure: typeof row.disclosure === "string" ? row.disclosure.trim().slice(0, MAX_DISCLOSURE_LENGTH) : "",
  };
}

export type StateRuleKind = "banned" | "restricted" | "capped" | "ok" | "unknown";

export function stateRule(state: string | null): { kind: StateRuleKind; capBps: number } {
  const s = normalizeState(state);
  if (!s) return { kind: "unknown", capBps: NETWORK_SURCHARGE_CAP_BPS };
  if (BANNED_SURCHARGE_STATES.includes(s)) return { kind: "banned", capBps: 0 };
  const cap = STATE_SURCHARGE_CAP_BPS[s];
  if (cap !== undefined) return { kind: "capped", capBps: Math.min(cap, NETWORK_SURCHARGE_CAP_BPS) };
  if (RESTRICTED_SURCHARGE_STATES.includes(s)) return { kind: "restricted", capBps: NETWORK_SURCHARGE_CAP_BPS };
  return { kind: "ok", capBps: NETWORK_SURCHARGE_CAP_BPS };
}

export function bpsToPercent(bps: number): string {
  return String(Number((bps / 100).toFixed(2)));
}

/** "3", "2.5", "0.75" -> basis points. Null for anything else (negatives, 3 decimals, text). */
export function percentToBps(input: string): number | null {
  const t = input.trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function defaultLabel(mode: PricingMode): string {
  if (mode === "surcharge") return "Credit card surcharge";
  if (mode === "convenience_fee") return "Convenience fee";
  if (mode === "cash_discount") return "Cash discount";
  return "";
}

export function pricingLabel(s: PricingSettings): string {
  return s.label.trim() || defaultLabel(s.mode);
}

export type SettingsErrors = Partial<Record<"mode" | "surcharge" | "flat" | "cash" | "state" | "label" | "disclosure", string>>;

export function validatePricingSettings(s: PricingSettings): { ok: boolean; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  if (s.label.trim().length > MAX_LABEL_LENGTH) errors.label = `Keep the label under ${MAX_LABEL_LENGTH} characters.`;
  if (s.disclosure.trim().length > MAX_DISCLOSURE_LENGTH) errors.disclosure = `Keep this under ${MAX_DISCLOSURE_LENGTH} characters.`;

  if (s.mode === "surcharge" || s.mode === "convenience_fee") {
    const rule = stateRule(s.businessState);
    if (rule.kind === "unknown") errors.state = "Choose the state your business operates in.";
    else if (rule.kind === "banned") errors.mode = "Card surcharges and fees are prohibited in this state. Use a cash discount instead.";
    if (s.mode === "surcharge" && !errors.state && !errors.mode) {
      if (!isInt(s.surchargeBps) || s.surchargeBps < 1) errors.surcharge = "Enter a percentage like 3 or 2.5.";
      else if (s.surchargeBps > rule.capBps) errors.surcharge = `The maximum allowed${rule.kind === "capped" ? " in your state" : ""} is ${bpsToPercent(rule.capBps)}%.`;
    }
    if (s.mode === "convenience_fee" && !errors.mode) {
      if (!isInt(s.flatFeeCents) || s.flatFeeCents < 1) errors.flat = "Enter a fee amount greater than $0.";
      else if (s.flatFeeCents > MAX_FLAT_FEE_CENTS) errors.flat = "The fee can't be more than $50.00.";
    }
  }
  if (s.mode === "cash_discount") {
    if (!isInt(s.cashDiscountBps) || s.cashDiscountBps < 1) errors.cash = "Enter a percentage like 3 or 2.5.";
    else if (s.cashDiscountBps > MAX_CASH_DISCOUNT_BPS) errors.cash = `The discount can't be more than ${bpsToPercent(MAX_CASH_DISCOUNT_BPS)}%.`;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export interface CardFee {
  feeCents: number;
  mode: PricingMode;
  label: string;
  bps: number | null;
}

const NO_FEE: CardFee = { feeCents: 0, mode: "off", label: "", bps: null };

/**
 * Server-authoritative card fee. Fail-safe: any invalid configuration (banned state, over the cap,
 * missing state) charges NOTHING rather than something unlawful. Rounds DOWN so the fee can never
 * exceed the stated percentage.
 */
export function computeCardFee(baseCents: number, s: PricingSettings): CardFee {
  if (!isInt(baseCents) || baseCents <= 0) return NO_FEE;
  if (s.mode !== "surcharge" && s.mode !== "convenience_fee") return NO_FEE;
  if (!validatePricingSettings(s).ok) return NO_FEE;
  if (s.mode === "surcharge") {
    const fee = Math.floor((baseCents * s.surchargeBps) / 10_000);
    return fee > 0 ? { feeCents: fee, mode: "surcharge", label: pricingLabel(s), bps: s.surchargeBps } : NO_FEE;
  }
  return { feeCents: s.flatFeeCents, mode: "convenience_fee", label: pricingLabel(s), bps: null };
}

/** Discount for a given rate: half-up on the cent. */
export function cashDiscountForBps(settledCents: number, bps: number): number {
  if (!isInt(settledCents) || settledCents <= 0 || !isInt(bps) || bps <= 0) return 0;
  const d = Math.floor((settledCents * bps + 5_000) / 10_000);
  return d < settledCents ? d : 0;
}

export function cashDiscountCents(settledCents: number, s: PricingSettings): number {
  if (s.mode !== "cash_discount" || !validatePricingSettings(s).ok) return 0;
  return cashDiscountForBps(settledCents, s.cashDiscountBps);
}

export interface CheckoutPricing {
  baseCents: number;
  tipCents: number;
  feeCents: number;
  feeLabel: string;
  feeMode: PricingMode;
  totalCents: number;
  /** Dual pricing only: what the same invoice costs when paid by cash or check. */
  cashPriceCents: number | null;
  cashDiscountCents: number;
}

export function checkoutPricing(baseCents: number, tipCents: number, s: PricingSettings, feeEligible = true): CheckoutPricing {
  const fee = feeEligible ? computeCardFee(baseCents, s) : NO_FEE;
  const discount = feeEligible ? cashDiscountCents(baseCents, s) : 0;
  return {
    baseCents,
    tipCents,
    feeCents: fee.feeCents,
    feeLabel: fee.label,
    feeMode: fee.mode,
    totalCents: baseCents + tipCents + fee.feeCents,
    cashPriceCents: discount > 0 ? baseCents - discount : null,
    cashDiscountCents: discount,
  };
}

export type FeeReason = "kept" | "none" | "not_card" | "debit_card" | "prepaid_card" | "unknown_funding" | "invalid_mode";

export interface FeeOutcome {
  keepCents: number;
  refundCents: number;
  reason: FeeReason;
}

/**
 * After the money lands: may we KEEP the fee that was added to the charge?
 * - surcharge: only on a credit card (never debit / prepaid / bank / other methods).
 * - convenience fee: kept on any method (it pays for the online channel).
 * `mode` and `excludeDebit` come from the snapshot stamped on the PaymentIntent, not live settings.
 */
export function decideFeeOutcome(input: {
  feeCents: number;
  mode: string | null | undefined;
  excludeDebit: boolean;
  methodType: string | null | undefined;
  funding: string | null | undefined;
}): FeeOutcome {
  const fee = isInt(input.feeCents) && input.feeCents > 0 ? input.feeCents : 0;
  if (fee === 0) return { keepCents: 0, refundCents: 0, reason: "none" };
  if (input.mode === "convenience_fee") return { keepCents: fee, refundCents: 0, reason: "kept" };
  if (input.mode !== "surcharge") return { keepCents: 0, refundCents: fee, reason: "invalid_mode" };
  if (input.methodType !== "card") return { keepCents: 0, refundCents: fee, reason: "not_card" };
  if (input.funding === "credit") return { keepCents: fee, refundCents: 0, reason: "kept" };
  if (!input.excludeDebit) return { keepCents: fee, refundCents: 0, reason: "kept" };
  const reason: FeeReason = input.funding === "debit" ? "debit_card" : input.funding === "prepaid" ? "prepaid_card" : "unknown_funding";
  return { keepCents: 0, refundCents: fee, reason };
}

export interface ReceiptLine {
  key: "invoice" | "fee" | "fee_refund" | "tip";
  label: string;
  cents: number;
}

/** Itemised receipt: invoice + fee charged - fee refunded + tip. The total always equals what the card was charged. */
export function buildReceiptLines(input: {
  baseCents: number;
  tipCents: number;
  feeCents: number;
  feeRefundedCents: number;
  feeLabel: string;
}): { lines: ReceiptLine[]; totalCents: number } {
  const fee = Math.max(0, input.feeCents);
  const refunded = Math.min(Math.max(0, input.feeRefundedCents), fee);
  const label = input.feeLabel.trim() || "Fee";
  const lines: ReceiptLine[] = [{ key: "invoice", label: "Invoice", cents: input.baseCents }];
  if (fee > 0) lines.push({ key: "fee", label, cents: fee });
  if (refunded > 0) lines.push({ key: "fee_refund", label: `${label} refunded`, cents: -refunded });
  if (input.tipCents > 0) lines.push({ key: "tip", label: "Tip", cents: input.tipCents });
  return { lines, totalCents: input.baseCents + input.tipCents + fee - refunded };
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Text Stripe prints on its own receipt email and the dashboard: the customer sees the same breakdown. */
export function itemizedDescription(description: string, p: { baseCents: number; tipCents: number; feeCents: number; feeLabel: string }): string {
  const parts = [`${usd(p.baseCents)} invoice`];
  if (p.feeCents > 0) parts.push(`${usd(p.feeCents)} ${p.feeLabel.trim().toLowerCase() || "fee"}`);
  if (p.tipCents > 0) parts.push(`${usd(p.tipCents)} tip`);
  return parts.length === 1 ? description : `${description} (${parts.join(" + ")})`;
}

/** Customer-facing notice shown before they pay. The owner's own wording is appended, never replaced. */
export function buildPricingDisclosure(s: PricingSettings): string {
  const label = pricingLabel(s).toLowerCase();
  let base = "";
  if (s.mode === "surcharge") {
    base = `A ${bpsToPercent(s.surchargeBps)}% ${label} is added to credit card payments.${
      s.excludeDebit ? " It is not charged on debit cards or bank payments; if you pay that way it is refunded automatically." : ""
    }`;
  } else if (s.mode === "convenience_fee") {
    base = `A ${usd(s.flatFeeCents)} ${label} applies to online payments.`;
  } else if (s.mode === "cash_discount") {
    base = `Our listed prices include card processing. Pay by cash or check and save ${bpsToPercent(s.cashDiscountBps)}%.`;
  }
  const extra = s.disclosure.trim();
  return [base, extra].filter(Boolean).join(" ");
}
