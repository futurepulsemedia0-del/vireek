// supabase/functions/_shared/price-book/match.ts
//
// Pure price-book matching + wording. Extracted from vapi-webhook's lookup_price so the human receptionist and
// the AI-agent-caller protocol quote from ONE implementation (no parallel matcher, no second price format).

export interface PriceItemLite {
  id?: string;
  service_name: string;
  category: string | null;
  pricing_model: string;
  price_cents: number;
  price_max_cents: number | null;
  unit_label: string | null;
  keywords: string[] | null;
  /** Set by the agent-callers feature; undefined for plain price-book rows (treated as quotable). */
  agent_quotable?: boolean | null;
}

export interface ScoredItem<T extends PriceItemLite = PriceItemLite> {
  item: T;
  /** 2 = exact name/category/keyword, 1 = partial. */
  score: number;
}

/** Same scoring the voice tool has always used: exact beats partial; nothing else is "close enough". */
export function matchPriceItems<T extends PriceItemLite>(items: T[], query: string): ScoredItem<T>[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return items
    .map((item) => {
      const haystacks = [item.service_name, item.category ?? "", ...(item.keywords ?? [])].map((s) => s.toLowerCase()).filter((s) => s.length > 0);
      const exact = haystacks.some((h) => h === needle);
      const partial = haystacks.some((h) => h.includes(needle) || needle.includes(h));
      return { item, score: exact ? 2 : partial ? 1 : 0 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function moneyLabel(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function formatPriceLine(item: Pick<PriceItemLite, "service_name" | "pricing_model" | "price_cents" | "price_max_cents" | "unit_label">): string {
  const unit = item.unit_label ? ` ${item.unit_label}` : "";
  switch (item.pricing_model) {
    case "starting_at":
      return `${item.service_name}: starting at ${moneyLabel(item.price_cents)}${unit}.`;
    case "range":
      return `${item.service_name}: ${moneyLabel(item.price_cents)}–${moneyLabel(item.price_max_cents ?? item.price_cents)}${unit}.`;
    case "hourly":
      return `${item.service_name}: ${moneyLabel(item.price_cents)}${unit || "/hour"}.`;
    default:
      return `${item.service_name}: ${moneyLabel(item.price_cents)}${unit}.`;
  }
}
