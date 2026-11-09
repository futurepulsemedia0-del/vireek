// supabase/functions/_shared/vertical-ai/pricing.ts
//
// Deterministic price resolution. The LLM never computes or invents a number: it only chooses among the
// candidates this function returns, and every dollar amount in a candidate's `spoken` text is derivable from
// the tenant's own price-book row (+ the tenant's own after-hours fee). PURE: no I/O, integer cents only.
//
// What the repo's schema supports (verified): price_book_items.pricing_model in flat|starting_at|range|hourly,
// business_profile.after_hours_fee (dollars). What it does NOT support, so this module never invents it:
// membership discount percentages (membership_plans only has benefits text[]) and emergency multipliers.
// Those are accepted as OPTIONAL inputs; when absent the candidate says so ("not_configured") and the caller must
// not promise a discount. Tax is surfaced as a note (taxable true/false/unknown), never computed here.

import { formatPriceLine, matchPriceItems, moneyLabel, type PriceItemLite } from "../price-book/match.ts";

export type PricingMode = "flat_rate" | "time_and_materials";

export interface PriceContext {
  afterHours: boolean;
  emergency: boolean;
  /** business_profile.after_hours_fee converted to integer cents; null/0 = no fee configured. */
  afterHoursFeeCents?: number | null;
  /** Optional tenant-configured emergency multiplier (>=1). Not in the current schema: null in production today. */
  emergencyMultiplier?: number | null;
  /** Optional tenant-configured membership discount percent (0..100). Not in the current schema: null today. */
  membershipDiscountPct?: number | null;
  isMember?: boolean;
  /** From tax_classes.default_taxable when the item has a tax class; null = unknown. */
  taxable?: boolean | null;
}

export interface PriceAdjustment { kind: "after_hours_fee" | "emergency_multiplier" | "membership_discount"; cents: number }

export interface PriceCandidate {
  /** price_book_items.id when present: the evidence id is `price_book:<id>`. */
  itemId: string | null;
  serviceName: string;
  model: string;
  /** Book price, integer cents. */
  baseCents: number;
  baseMaxCents: number | null;
  adjustments: PriceAdjustment[];
  /** Quote to speak, integer cents; for ranges this is the low end. */
  totalFromCents: number;
  totalToCents: number | null;
  /** Exact sentence the assistant may say. Every $ amount in it comes from this candidate's numbers. */
  spoken: string;
  membershipNote: "applied" | "not_configured" | "not_member" | "n/a";
  taxNote: "plus_tax" | "tax_exempt_class" | "unknown";
}

export type PriceStatus = "resolved" | "ambiguous" | "no_match" | "no_price_book";

export interface PriceResolution {
  status: PriceStatus;
  /** 1 candidate when resolved; up to 3 when ambiguous (the assistant must ask which one); [] otherwise. */
  candidates: PriceCandidate[];
  /** Decision path for observability, e.g. ["match:exact","adjust:after_hours_fee"]. */
  path: string[];
}

const MAX_CANDIDATES = 3;

/** Dollars (number|string from numeric columns) to integer cents; null when not a finite non-negative number. */
export function dollarsToCents(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function applyAdjustments(base: number, max: number | null, ctx: PriceContext, path: string[]): { from: number; to: number | null; adj: PriceAdjustment[]; member: PriceCandidate["membershipNote"] } {
  let from = base;
  let to = max;
  const adj: PriceAdjustment[] = [];

  const mult = ctx.emergency && ctx.emergencyMultiplier && ctx.emergencyMultiplier > 1 ? Math.min(ctx.emergencyMultiplier, 10) : null;
  if (mult) {
    const nf = Math.round(from * mult);
    adj.push({ kind: "emergency_multiplier", cents: nf - from });
    from = nf;
    if (to !== null) to = Math.round(to * mult);
    path.push("adjust:emergency_multiplier");
  }

  const fee = ctx.afterHours && ctx.afterHoursFeeCents && ctx.afterHoursFeeCents > 0 ? Math.floor(ctx.afterHoursFeeCents) : 0;
  if (fee > 0) {
    adj.push({ kind: "after_hours_fee", cents: fee });
    from += fee;
    if (to !== null) to += fee;
    path.push("adjust:after_hours_fee");
  }

  let member: PriceCandidate["membershipNote"] = "n/a";
  if (ctx.isMember) {
    const pct = ctx.membershipDiscountPct;
    if (typeof pct === "number" && pct > 0 && pct <= 100) {
      const df = Math.round(from * (pct / 100));
      adj.push({ kind: "membership_discount", cents: -df });
      from -= df;
      if (to !== null) to -= Math.round(to * (pct / 100));
      member = "applied";
      path.push("adjust:membership_discount");
    } else {
      member = "not_configured";
      path.push("membership:not_configured");
    }
  }
  // Floor: an adjustment can never push a quote below zero or make a range inverted.
  from = Math.max(0, from);
  if (to !== null) to = Math.max(from, to);
  return { from, to, adj, member };
}

function spokenLine(item: PriceItemLite, from: number, to: number | null, adj: PriceAdjustment[], tax: PriceCandidate["taxNote"]): string {
  // With no adjustments the sentence is the SAME one the live voice tool has always used (formatPriceLine).
  const hasAdj = adj.length > 0;
  let line: string;
  if (!hasAdj) {
    line = formatPriceLine(item);
  } else {
    const unit = item.unit_label ? ` ${item.unit_label}` : "";
    switch (item.pricing_model) {
      case "starting_at": line = `${item.service_name}: starting at ${moneyLabel(from)}${unit}.`; break;
      case "range": line = `${item.service_name}: ${moneyLabel(from)} to ${moneyLabel(to ?? from)}${unit}.`; break;
      case "hourly": line = `${item.service_name}: ${moneyLabel(from)}${unit || "/hour"}.`; break;
      default: line = `${item.service_name}: ${moneyLabel(from)}${unit}.`;
    }
    const fee = adj.find((a) => a.kind === "after_hours_fee");
    if (fee) line += ` That includes a ${moneyLabel(fee.cents)} after-hours fee.`;
  }
  if (tax === "plus_tax") line += " Plus applicable tax.";
  return line;
}

export function resolvePrice(items: readonly PriceItemLite[], query: string, ctx: PriceContext): PriceResolution {
  const path: string[] = [];
  if (!items || items.length === 0) return { status: "no_price_book", candidates: [], path: ["book:empty"] };

  const q = (query ?? "").trim();
  // The shared matcher treats very short needles as partial matches of almost everything: refuse them.
  if (q.length < 3) return { status: "no_match", candidates: [], path: ["match:query_too_short"] };

  // Deterministic order: matcher score, then stable by service name, then id (never insertion/DB order).
  const scored = matchPriceItems([...items], q).sort((a, b) =>
    b.score - a.score || a.item.service_name.localeCompare(b.item.service_name) || String(a.item.id ?? "").localeCompare(String(b.item.id ?? "")));
  if (scored.length === 0) {
    // Fallback: stemmed token overlap (replace/replacing/replacement, outlet/outlets). Only for multi-token tenant
    // phrases, and every token must be present, so it can never match on a single generic word.
    const stem = (w: string) => w.replace(/(?:ing|ment|ed|es|s|e)$/, "");
    const qTokens = new Set(q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter(Boolean).map(stem));
    const viaStem = items.filter((it) => [it.service_name, ...(it.keywords ?? [])].some((h) => {
      const ht = h.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((t) => t.length > 2).map(stem);
      return ht.length >= 2 && ht.every((t) => qTokens.has(t));
    }));
    if (viaStem.length === 0) return { status: "no_match", candidates: [], path: ["match:none"] };
    scored.push(...viaStem.map((item) => ({ item, score: 1 })));
    path.push("match:stem");
  }

  const top = scored[0].score;
  const tied = scored.filter((s) => s.score === top);
  // Distinct services at the same score => ambiguous. (Duplicate rows of the same service name are not ambiguity.)
  const distinctNames = new Set(tied.map((s) => s.item.service_name.trim().toLowerCase()));
  const chosen = distinctNames.size > 1 ? tied.slice(0, MAX_CANDIDATES) : [tied[0]];
  path.push(top === 2 ? "match:exact" : "match:partial", distinctNames.size > 1 ? "match:ambiguous" : "match:single");

  const taxNote: PriceCandidate["taxNote"] = ctx.taxable === true ? "plus_tax" : ctx.taxable === false ? "tax_exempt_class" : "unknown";

  const candidates = chosen.map(({ item }) => {
    const local: string[] = [];
    const r = applyAdjustments(item.price_cents, item.price_max_cents, ctx, local);
    if (chosen.length === 1) path.push(...local);
    return {
      itemId: item.id ?? null,
      serviceName: item.service_name,
      model: item.pricing_model,
      baseCents: item.price_cents,
      baseMaxCents: item.price_max_cents,
      adjustments: r.adj,
      totalFromCents: r.from,
      totalToCents: r.to,
      spoken: spokenLine(item, r.from, r.to, r.adj, taxNote),
      membershipNote: r.member,
      taxNote,
    } satisfies PriceCandidate;
  });

  return { status: chosen.length === 1 ? "resolved" : "ambiguous", candidates, path };
}

/** Every `$` amount that appears in `text`, as integer cents. Used by tests and the grounding verifier. */
export function extractDollarAmountsCents(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)) {
    const whole = Number(m[1].replace(/,/g, ""));
    const frac = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
    out.push(whole * 100 + frac);
  }
  return out;
}

/** Cents the assistant is allowed to say for a resolution: only numbers present in its candidates. */
export function allowedCents(res: PriceResolution): Set<number> {
  const s = new Set<number>();
  for (const c of res.candidates) {
    s.add(c.baseCents); s.add(c.totalFromCents);
    if (c.baseMaxCents !== null) s.add(c.baseMaxCents);
    if (c.totalToCents !== null) s.add(c.totalToCents);
    for (const a of c.adjustments) s.add(Math.abs(a.cents));
  }
  return s;
}

/** True when `spokenText` contains no dollar amount outside the allowed set. */
export function pricesAreGrounded(spokenText: string, res: PriceResolution): boolean {
  const allowed = allowedCents(res);
  return extractDollarAmountsCents(spokenText).every((c) => allowed.has(c));
}
