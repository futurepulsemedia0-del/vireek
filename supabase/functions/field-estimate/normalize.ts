// supabase/functions/field-estimate/normalize.ts
//
// Pure, dependency-free post-processing of the model's JSON. Everything the
// model returns is treated as UNTRUSTED input: clamped, enum-checked, and -
// most importantly - priced from the business's own price book wherever a
// line matches. The model never gets to set a price that the price book
// already defines.

export type Severity = "low" | "medium" | "high" | "emergency";
export type TierKey = "good" | "better" | "best";
export type LineKind = "labor" | "part" | "fee" | "other";
export type LineSource = "price_book" | "ai_estimate";

export interface PriceItem {
  id: string;
  service_name: string;
  category: string | null;
  pricing_model: string;
  price_cents: number;
  price_max_cents: number | null;
  unit_label: string | null;
}

export interface NormalizedLine {
  description: string;
  kind: LineKind;
  quantity: number;
  unit_price_cents: number;
  source: LineSource;
  price_book_item_id: string | null;
  /** True when a human must confirm this line (AI ballpark, or a price-book range). */
  needs_review: boolean;
}

export interface NormalizedTier {
  tier: TierKey;
  name: string;
  summary: string;
  highlights: string[];
  warranty_label: string | null;
  labor_hours: number | null;
  crew_size: number | null;
  line_items: NormalizedLine[];
  total_cents: number;
}

export interface NormalizedEstimate {
  transcript: string;
  diagnosis: {
    summary: string;
    probable_cause: string;
    customer_summary: string;
    service_type: string;
    severity: Severity;
    confidence: number;
    evidence: string[];
  };
  safety_flags: string[];
  missing_info: string[];
  scope_of_work: string[];
  parts: { name: string; quantity: number; source: LineSource }[];
  tiers: NormalizedTier[];
  recommended_tier: TierKey;
  warnings: string[];
}

const SEVERITIES: Severity[] = ["low", "medium", "high", "emergency"];
const TIERS: TierKey[] = ["good", "better", "best"];
const KINDS: LineKind[] = ["labor", "part", "fee", "other"];
const SERVICE_TYPES = [
  "plumbing", "hvac", "electrical", "roofing", "fencing",
  "landscaping", "general_handyman", "other",
];

const MAX_LINES_PER_TIER = 8;
const MAX_UNIT_PRICE_CENTS = 50_000_00; // $50,000 sanity ceiling per unit
const MAX_QUANTITY = 999;

// deno-lint-ignore no-explicit-any
type Loose = any;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function int(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function extractJson(text: string): Loose | null {
  const cleaned = text.replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/** Compact, token-cheap catalog text. Refs (P1, P2...) replace UUIDs. */
export function buildCatalog(items: PriceItem[]): { text: string; refMap: Map<string, PriceItem> } {
  const refMap = new Map<string, PriceItem>();
  const usd = (c: number) => `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`;
  const lines = items.map((it, i) => {
    const ref = `P${i + 1}`;
    refMap.set(ref, it);
    const price =
      it.pricing_model === "range" && it.price_max_cents != null
        ? `${usd(it.price_cents)}-${usd(it.price_max_cents)}`
        : it.pricing_model === "starting_at"
          ? `from ${usd(it.price_cents)}`
          : it.pricing_model === "hourly"
            ? `${usd(it.price_cents)}/hr`
            : usd(it.price_cents);
    const unit = it.unit_label && it.pricing_model !== "hourly" ? ` ${it.unit_label}` : "";
    return `${ref}|${it.service_name.slice(0, 80)}|${(it.category ?? "").slice(0, 30)}|${price}${unit}`;
  });
  return { text: lines.join("\n"), refMap };
}

function normalizeLine(raw: Loose, refMap: Map<string, PriceItem>): NormalizedLine | null {
  if (!raw || typeof raw !== "object") return null;
  const description = str(raw.description, 200);
  if (!description) return null;

  const kind: LineKind = KINDS.includes(raw.kind) ? raw.kind : "other";
  const quantity = int(raw.quantity, 1, MAX_QUANTITY, 1);

  const ref = typeof raw.price_book_ref === "string" ? raw.price_book_ref.trim().toUpperCase() : "";
  const item = ref ? refMap.get(ref) : undefined;

  if (item) {
    // Price-book price ALWAYS wins over whatever the model wrote.
    const isRangeLike = item.pricing_model === "range" || item.pricing_model === "starting_at";
    return {
      description,
      kind,
      quantity,
      unit_price_cents: item.price_cents,
      source: "price_book",
      price_book_item_id: item.id,
      needs_review: isRangeLike,
    };
  }

  return {
    description,
    kind,
    quantity,
    unit_price_cents: int(raw.unit_price_cents, 0, MAX_UNIT_PRICE_CENTS, 0),
    source: "ai_estimate",
    price_book_item_id: null,
    needs_review: true,
  };
}

function totalOf(lines: NormalizedLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity * l.unit_price_cents, 0);
}

export function normalizeEstimate(
  parsed: Loose,
  refMap: Map<string, PriceItem>,
): NormalizedEstimate | null {
  if (!parsed || typeof parsed !== "object") return null;

  const warnings: string[] = [];
  const seen = new Set<TierKey>();
  const tiers: NormalizedTier[] = [];

  for (const rawTier of Array.isArray(parsed.tiers) ? parsed.tiers : []) {
    if (!rawTier || !TIERS.includes(rawTier.tier) || seen.has(rawTier.tier)) continue;
    const lines = (Array.isArray(rawTier.line_items) ? rawTier.line_items : [])
      .slice(0, MAX_LINES_PER_TIER)
      .map((l: Loose) => normalizeLine(l, refMap))
      .filter((l: NormalizedLine | null): l is NormalizedLine => l !== null);
    if (lines.length === 0) continue;

    seen.add(rawTier.tier);
    const hours = Number(rawTier.labor_hours);
    tiers.push({
      tier: rawTier.tier,
      name: str(rawTier.name, 80) || rawTier.tier,
      summary: str(rawTier.summary, 200),
      highlights: strList(rawTier.highlights, 5, 120),
      warranty_label: str(rawTier.warranty_label, 80) || null,
      labor_hours: Number.isFinite(hours) && hours > 0 ? Math.min(200, Math.round(hours * 10) / 10) : null,
      crew_size: rawTier.crew_size ? int(rawTier.crew_size, 1, 10, 1) : null,
      line_items: lines,
      total_cents: totalOf(lines),
    });
  }

  if (tiers.length === 0) return null;
  tiers.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));

  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].total_cents < tiers[i - 1].total_cents) {
      warnings.push(
        `"${tiers[i].name}" costs less than "${tiers[i - 1].name}" - check the pricing before sending.`,
      );
    }
  }
  if (tiers.some((t) => t.line_items.some((l) => l.source === "ai_estimate" && l.unit_price_cents === 0))) {
    warnings.push("Some lines have no price. Enter them from your price book before sending.");
  }

  const d = parsed.diagnosis && typeof parsed.diagnosis === "object" ? parsed.diagnosis : {};
  const severity: Severity = SEVERITIES.includes(d.severity) ? d.severity : "low";
  const confidenceRaw = Number(d.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0;

  const recommended: TierKey = tiers.some((t) => t.tier === "better")
    ? "better"
    : tiers[tiers.length - 1].tier;

  const recommendedTier = tiers.find((t) => t.tier === recommended)!;
  const parts = recommendedTier.line_items
    .filter((l) => l.kind === "part")
    .map((l) => ({ name: l.description, quantity: l.quantity, source: l.source }));

  const safety_flags = strList(parsed.safety_flags, 6, 160);
  // A safety flag with a "low" severity is contradictory - never under-report.
  const finalSeverity: Severity =
    safety_flags.length > 0 && (severity === "low" || severity === "medium") ? "high" : severity;

  return {
    transcript: str(parsed.transcript, 6000),
    diagnosis: {
      summary: str(d.summary, 300),
      probable_cause: str(d.probable_cause, 400),
      customer_summary: str(d.customer_summary, 600),
      service_type: SERVICE_TYPES.includes(d.service_type) ? d.service_type : "other",
      severity: finalSeverity,
      confidence,
      evidence: strList(d.evidence, 8, 200),
    },
    safety_flags,
    missing_info: strList(parsed.missing_info, 8, 200),
    scope_of_work: strList(parsed.scope_of_work, 10, 220),
    parts,
    tiers,
    recommended_tier: recommended,
    warnings,
  };
}
