// Pure tipping rules shared by the browser (src/lib/tipping.ts re-exports this)
// and the Deno edge functions. No imports, no runtime APIs: keep it that way.

export const TIP_PRESET_PERCENTS = [15, 18, 20, 25] as const;
export const MAX_TIP_CENTS = 100_000; // hard ceiling: $1,000
export const MIN_CUSTOM_TIP_CAP_CENTS = 5_000; // small invoices may still take up to $50

export type TipSelection =
  | { kind: "none" }
  | { kind: "percent"; percent: number }
  | { kind: "custom"; cents: number };

export type TipResult =
  | { ok: true; tipCents: number; percent: number | null }
  | { ok: false; error: string };

/** Largest tip we accept for a given base: 100% of the invoice, floor $50, ceiling $1,000. */
export function maxTipCents(baseCents: number): number {
  return Math.min(MAX_TIP_CENTS, Math.max(baseCents, MIN_CUSTOM_TIP_CAP_CENTS));
}

/** Server-authoritative tip calculation. Never trust a client-supplied cents value for presets. */
export function computeTip(baseCents: number, selection: TipSelection | null | undefined): TipResult {
  if (!Number.isInteger(baseCents) || baseCents <= 0) return { ok: false, error: "Invalid invoice amount." };
  if (!selection || selection.kind === "none") return { ok: true, tipCents: 0, percent: null };

  if (selection.kind === "percent") {
    if (!(TIP_PRESET_PERCENTS as readonly number[]).includes(selection.percent)) {
      return { ok: false, error: "Unsupported tip percentage." };
    }
    return { ok: true, tipCents: Math.round((baseCents * selection.percent) / 100), percent: selection.percent };
  }

  if (selection.kind === "custom") {
    const cents = selection.cents;
    if (!Number.isInteger(cents) || cents < 0) return { ok: false, error: "Enter a valid tip amount." };
    if (cents === 0) return { ok: true, tipCents: 0, percent: null };
    if (cents > maxTipCents(baseCents)) return { ok: false, error: "That tip amount is too large." };
    return { ok: true, tipCents: cents, percent: Math.round((cents / baseCents) * 10000) / 100 };
  }

  return { ok: false, error: "Unsupported tip selection." };
}

/** "12", "12.5", "12.50" -> cents. Returns null for anything else (negatives, 3 decimals, text). */
export function dollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Customer-facing label only ever shows a first name. */
export function firstName(fullName: string | null | undefined): string {
  return (fullName ?? "").trim().split(/\s+/)[0] ?? "";
}
