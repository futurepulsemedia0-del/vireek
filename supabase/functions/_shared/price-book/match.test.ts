import { describe, expect, it } from "vitest";
import { formatPriceLine, matchPriceItems, type PriceItemLite } from "./match.ts";

const item = (o: Partial<PriceItemLite>): PriceItemLite => ({ service_name: "Drain Cleaning", category: "Plumbing", pricing_model: "starting_at", price_cents: 12900, price_max_cents: null, unit_label: null, keywords: ["clogged drain"], ...o });

describe("matchPriceItems", () => {
  it("ranks exact above partial and drops non-matches", () => {
    const r = matchPriceItems([item({}), item({ service_name: "Water Heater", category: "Plumbing", keywords: [] })], "clogged drain");
    expect(r).toHaveLength(1);
    expect(r[0].score).toBe(2);
  });
  it("returns nothing for an empty query", () => expect(matchPriceItems([item({})], "  ")).toEqual([]));
});

describe("formatPriceLine (wording unchanged from lookup_price)", () => {
  it("starting at / range / hourly / flat", () => {
    expect(formatPriceLine(item({}))).toBe("Drain Cleaning: starting at $129.");
    expect(formatPriceLine(item({ pricing_model: "range", price_cents: 10000, price_max_cents: 25050 }))).toBe("Drain Cleaning: $100–$250.50.");
    expect(formatPriceLine(item({ pricing_model: "hourly", price_cents: 9500 }))).toBe("Drain Cleaning: $95/hour.");
    expect(formatPriceLine(item({ pricing_model: "flat", price_cents: 5000, unit_label: "per visit" }))).toBe("Drain Cleaning: $50 per visit.");
  });
});
