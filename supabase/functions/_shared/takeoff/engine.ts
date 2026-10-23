// supabase/functions/_shared/takeoff/engine.ts
//
// AI Takeoff & Estimating — pure domain logic.
//
// No Deno / DOM / network APIs: this file runs inside the `takeoff-analyze`
// edge function, inside the dashboard UI (imported by relative path, same
// pattern as microsoft-calendar/engine.ts) and inside Vitest. That is what
// guarantees the number a staff member sees on screen is the number the
// server priced and the number that lands on the quote.
//
// Design rules
//   1. The model only EXTRACTS (rooms, counts, dimensions, quantities, with an
//      honest confidence and the evidence it saw). It never sets a price the
//      business already defines. Pricing, waste, labor and tiering are all
//      deterministic code below, so every figure is explainable and testable.
//   2. Everything the model returns is UNTRUSTED: clamped, enum-checked,
//      cross-checked, and given a calibrated confidence (never 1.0).
//   3. Humans stay in the loop: anything uncertain must be explicitly
//      confirmed / corrected / rejected before the takeoff can become a quote
//      (see evaluateReviewGate), and the quote it creates is always a draft.
//   4. Money is integer cents. Quantities that reach a quote are integers
//      (the quote builder rounds quantities, so rounding up HERE keeps the
//      takeoff total and the quote total identical). Labor is emitted as a
//      flat line (hours x rate, in cents) so fractional hours never round.

// ============================================================
// TYPES
// ============================================================

export type ItemKind = "fixture" | "material" | "labor" | "fee";
export type Basis = "counted" | "measured" | "inferred" | "assumed" | "manual";
export type TierScope = "all" | "better_plus" | "best_only";
export type TierKey = "good" | "better" | "best";
export type ReviewStatus = "pending" | "confirmed" | "edited" | "rejected";
export type PriceSource = "price_book" | "supplier_catalog" | "ai_estimate" | "manual" | "none";
export type MatchStatus = "matched" | "ambiguous" | "unmatched" | "manual";
export type PlanQuality = "clear" | "fair" | "poor";
export type DetailLevel = "itemized" | "summary";

export interface PriceCandidate {
  source: "price_book" | "supplier_catalog";
  /** price_book_items.id for price_book, inventory_parts.id for supplier_catalog. */
  entry_id: string;
  name: string;
  score: number;
  /** Sell price fixed by the price book (null = derive from cost + markup). */
  fixed_sell_cents: number | null;
  cost_cents: number | null;
  price_book_item_id: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_sku: string | null;
  lead_time_days: number | null;
  /** True when the price book price already includes installation labor. */
  labor_included: boolean;
  flags: string[];
}

export interface TakeoffItem {
  id: string;
  room_id: string | null;
  sort_order: number;
  kind: ItemKind;
  description: string;
  category: string;
  unit: string;
  net_quantity: number;
  waste_percent: number;
  /** What is priced and quoted: integer, includes waste. */
  quantity: number;
  /** The model's original net quantity (null for human-added lines). */
  ai_quantity: number | null;
  basis: Basis;
  confidence: number;
  evidence: string;
  source_ref: string | null;
  source: "ai" | "human";
  tier_scope: TierScope;
  labor_hours_each: number | null;
  labor_included: boolean;
  price_source: PriceSource;
  price_locked: boolean;
  price_book_item_id: string | null;
  inventory_part_id: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_sku: string | null;
  lead_time_days: number | null;
  unit_cost_cents: number | null;
  unit_price_cents: number | null;
  price_confidence: number;
  match_status: MatchStatus;
  match_candidates: PriceCandidate[];
  flags: string[];
  review_status: ReviewStatus;
}

/** An item as produced by the analyzer, before the database assigns ids. */
export type TakeoffItemRow = Omit<TakeoffItem, "id" | "room_id"> & { room_ref: string | null };

export interface TakeoffRoom {
  id: string;
  name: string;
  room_type: string;
  level: string;
  length_ft: number | null;
  width_ft: number | null;
  height_ft: number | null;
  area_sqft: number | null;
  confidence: number;
  evidence: string;
  source_ref: string | null;
  flags: string[];
}

export type TakeoffRoomRow = Omit<TakeoffRoom, "id"> & { ref: string; sort_order: number };

export interface ProjectSettings {
  markup_percent: number;
  labor_rate_cents: number;
  labor_cost_rate_cents: number | null;
  tax_percent: number;
  /** category -> total labor hours (replaces the computed figure). */
  labor_overrides: Record<string, number>;
  detail_level: DetailLevel;
}

export interface ProjectInfo {
  name: string;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  lead_id: string | null;
  overall_confidence: number | null;
  ai_summary: string | null;
}

// ---- Catalog (price book + supplier catalog) ------------------------------

export interface PriceBookEntry {
  id: string;
  service_name: string;
  category: string | null;
  pricing_model: "flat" | "starting_at" | "range" | "hourly";
  price_cents: number;
  price_max_cents: number | null;
  cost_cents: number | null;
  unit_label: string | null;
  keywords: string[];
}

export interface PartVendorOffer {
  vendor_id: string;
  vendor_name: string | null;
  vendor_sku: string | null;
  unit_cost_cents: number;
  lead_time_days: number | null;
  is_preferred: boolean;
}

export interface PartEntry {
  id: string;
  part_number: string | null;
  name: string;
  category: string | null;
  unit_label: string | null;
  unit_cost_cents: number;
  price_book_item_id: string | null;
  offers: PartVendorOffer[];
}

export interface Catalog {
  priceBook: PriceBookEntry[];
  parts: PartEntry[];
}

// ---- Normalized model output ----------------------------------------------

export interface NormalizedTakeoff {
  summary: string;
  scale_detected: string | null;
  scale_confidence: number;
  plan_quality: PlanQuality;
  total_area_sqft: number | null;
  rooms: TakeoffRoomRow[];
  items: DraftItem[];
  assumptions: string[];
  missing_info: string[];
  warnings: string[];
}

export interface DraftItem {
  room_ref: string | null;
  kind: "fixture" | "material" | "fee";
  description: string;
  category: string;
  unit: string;
  net_quantity: number;
  basis: Basis;
  model_confidence: number;
  confidence: number;
  evidence: string;
  source_ref: string | null;
  search_terms: string[];
  tier_scope: TierScope;
  labor_hours_each: number | null;
  ballpark_unit_price_cents: number | null;
  flags: string[];
}

// ============================================================
// CONSTANTS
// ============================================================

export const CONFIDENCE = { high: 0.8, medium: 0.55, floor: 0.05, ceiling: 0.97 } as const;
/** Below this a price must be looked at by a human before it can be quoted. */
export const PRICE_CONFIDENCE_REVIEW_BELOW = 0.7;
export const MATCH = { accept: 0.62, ambiguous: 0.4, margin: 0.08 } as const;
export const LIMITS = {
  rooms: 60,
  items: 400,
  upgrades: 12,
  assumptions: 12,
  quantity: 1_000_000,
  unitPriceCents: 50_000_00,
  hoursPerUnit: 40,
} as const;

export const DEFAULT_SETTINGS: ProjectSettings = {
  markup_percent: 30,
  labor_rate_cents: 0,
  labor_cost_rate_cents: null,
  tax_percent: 0,
  labor_overrides: {},
  detail_level: "itemized",
};

/** Setup, protection and clean-up time added on top of per-unit install hours. */
export const LABOR_OVERHEAD_PERCENT = 10;
export const LABOR_ROUNDING_HOURS = 0.25;

export const TIER_ORDER: TierKey[] = ["good", "better", "best"];

const BASIS_PRIOR: Record<Basis, number> = {
  counted: 0.92,
  measured: 0.86,
  inferred: 0.66,
  assumed: 0.42,
  manual: 1,
};

const PLAN_QUALITY_FACTOR: Record<PlanQuality, number> = { clear: 1, fair: 0.93, poor: 0.8 };

// ============================================================
// SMALL HELPERS
// ============================================================

type Loose = Record<string, unknown>;

function isObj(v: unknown): v is Loose {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function extractJson(text: string): unknown {
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

// ============================================================
// UNITS
// ============================================================

const UNIT_ALIASES: Record<string, string> = {
  ea: "ea", each: "ea", pc: "ea", pcs: "ea", piece: "ea", pieces: "ea", unit: "ea", units: "ea", count: "ea", no: "ea",
  sf: "sqft", sqft: "sqft", "sq ft": "sqft", "sq.ft.": "sqft", "sq. ft.": "sqft", "square feet": "sqft", "square foot": "sqft", ft2: "sqft",
  lf: "lf", "lin ft": "lf", "linear ft": "lf", "linear feet": "lf", "linear foot": "lf", ft: "lf", feet: "lf", foot: "lf",
  sheet: "sheet", sheets: "sheet", sht: "sheet",
  hr: "hr", hrs: "hr", hour: "hr", hours: "hr",
  cy: "cy", "cu yd": "cy", "cubic yard": "cy", "cubic yards": "cy",
  gal: "gal", gallon: "gal", gallons: "gal",
  bag: "bag", bags: "bag", box: "box", boxes: "box", roll: "roll", rolls: "roll", set: "set", sets: "set",
  bundle: "bundle", bundles: "bundle", sq: "sq", square: "sq", pair: "pair", pairs: "pair",
};

export function normalizeUnit(raw: unknown): string {
  const s = typeof raw === "string" ? raw.toLowerCase().replace(/\s+/g, " ").trim() : "";
  if (!s) return "ea";
  const stripped = s.replace(/^(per|\/)\s*/, "");
  return UNIT_ALIASES[stripped] ?? UNIT_ALIASES[s] ?? (stripped.replace(/[^a-z0-9 ./]/g, "").slice(0, 12) || "ea");
}

const KNOWN_UNITS = new Set(Object.values(UNIT_ALIASES));

/** true / false when both units are recognised, null when we can't tell. */
export function unitsCompatible(a: string | null | undefined, b: string | null | undefined): boolean | null {
  if (!a || !b) return null;
  const ua = normalizeUnit(a);
  const ub = normalizeUnit(b);
  if (!KNOWN_UNITS.has(ua) || !KNOWN_UNITS.has(ub)) return null;
  return ua === ub;
}

// ============================================================
// CONFIDENCE
// ============================================================

export interface ConfidenceInput {
  model: number;
  basis: Basis;
  hasEvidence: boolean;
  planQuality: PlanQuality;
  scaleConfidence: number;
  /** 0..1 multiplicative haircut from cross-checks (mismatched areas, outliers). */
  penalty?: number;
}

/**
 * Model self-reported confidence is only half the story: a count read off a
 * symbol legend is more trustworthy than a quantity inferred from a scale
 * that was never confirmed. Blend the two, then apply deterministic haircuts.
 * Never returns 1.0 — an AI extraction is never certain.
 */
export function calibrateConfidence(input: ConfidenceInput): number {
  if (input.basis === "manual") return 1;
  let c = 0.5 * clamp(input.model, 0, 1) + 0.5 * BASIS_PRIOR[input.basis];
  if (!input.hasEvidence) c *= 0.85;
  c *= PLAN_QUALITY_FACTOR[input.planQuality];
  if (input.basis === "inferred" && input.scaleConfidence < 0.6) c *= 0.85;
  if (input.penalty) c *= 1 - clamp(input.penalty, 0, 0.9);
  return round(clamp(c, CONFIDENCE.floor, CONFIDENCE.ceiling), 2);
}

export type ConfidenceBand = "high" | "medium" | "low";

export function confidenceBand(c: number): ConfidenceBand {
  if (c >= CONFIDENCE.high) return "high";
  if (c >= CONFIDENCE.medium) return "medium";
  return "low";
}

// ============================================================
// NORMALIZE THE MODEL'S JSON
// ============================================================

const BASES = ["counted", "measured", "inferred", "assumed"] as const;
const PLAN_QUALITIES = ["clear", "fair", "poor"] as const;
const TIER_SCOPES = ["all", "better_plus", "best_only"] as const;
const AI_KINDS = ["fixture", "material", "fee"] as const;

export function normalizeCategory(raw: unknown): string {
  const s = str(raw, 40);
  if (!s) return "General";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normalizeRooms(raw: unknown, planQuality: PlanQuality, scaleConfidence: number): TakeoffRoomRow[] {
  if (!Array.isArray(raw)) return [];
  const rooms: TakeoffRoomRow[] = [];
  const seen = new Set<string>();

  for (const r of raw) {
    if (!isObj(r) || rooms.length >= LIMITS.rooms) continue;
    const name = str(r.name, 80);
    if (!name) continue;

    let ref = str(r.ref, 20) || `R${rooms.length + 1}`;
    if (seen.has(ref)) ref = `${ref}_${rooms.length + 1}`;
    seen.add(ref);

    const length = num(r.length_ft);
    const width = num(r.width_ft);
    const height = num(r.height_ft);
    let area = num(r.area_sqft);
    const flags: string[] = [];
    let penalty = 0;

    const L = length != null && length > 0 && length <= 1000 ? round(length, 2) : null;
    const W = width != null && width > 0 && width <= 1000 ? round(width, 2) : null;
    const H = height != null && height > 0 && height <= 60 ? round(height, 2) : null;

    if (area != null && (area <= 0 || area > 1_000_000)) area = null;
    if (L != null && W != null) {
      const computed = L * W;
      if (area == null) {
        area = round(computed, 1);
        flags.push("area_derived");
      } else if (Math.abs(area - computed) / Math.max(area, computed) > 0.15) {
        flags.push("area_mismatch");
        penalty = 0.2;
      }
    }

    const hasDims = L != null && W != null;
    rooms.push({
      ref,
      sort_order: rooms.length,
      name,
      room_type: str(r.room_type, 40) || "other",
      level: str(r.level, 30) || "Main",
      length_ft: L,
      width_ft: W,
      height_ft: H,
      area_sqft: area != null ? round(area, 1) : null,
      confidence: calibrateConfidence({
        model: clamp(num(r.confidence) ?? 0.5, 0, 1),
        basis: hasDims ? "measured" : "inferred",
        hasEvidence: Boolean(str(r.evidence, 200)),
        planQuality,
        scaleConfidence,
        penalty,
      }),
      evidence: str(r.evidence, 240),
      source_ref: str(r.source_ref, 40) || null,
      flags,
    });
  }
  return rooms;
}

export function normalizeTakeoff(raw: unknown): NormalizedTakeoff | null {
  if (!isObj(raw)) return null;

  const project = isObj(raw.project) ? raw.project : {};
  const planQuality = oneOf(project.plan_quality, PLAN_QUALITIES, "fair");
  const scaleDetected = str(project.scale_detected, 60) || null;
  let scaleConfidence = clamp(num(project.scale_confidence) ?? 0.5, 0, 1);
  if (!scaleDetected) scaleConfidence = Math.min(scaleConfidence, 0.3);
  const totalAreaRaw = num(project.total_area_sqft);
  const totalArea = totalAreaRaw != null && totalAreaRaw > 0 && totalAreaRaw < 1_000_000 ? round(totalAreaRaw, 1) : null;

  const rooms = normalizeRooms(raw.rooms, planQuality, scaleConfidence);
  const roomRefs = new Set(rooms.map((r) => r.ref));
  const warnings: string[] = [];

  const items: DraftItem[] = [];
  const dupKeys = new Map<string, DraftItem>();
  let upgrades = 0;
  let upgradesDropped = 0;
  const rawItems = Array.isArray(raw.items) ? raw.items : [];

  for (const it of rawItems) {
    if (!isObj(it) || items.length >= LIMITS.items) continue;
    const description = str(it.description, 160);
    const net = num(it.net_quantity ?? it.quantity);
    if (!description || net == null || net <= 0) continue;

    const kind = oneOf(it.kind, AI_KINDS, "material");
    const basis = oneOf(it.basis, BASES, "inferred");
    const unit = normalizeUnit(it.unit);
    const tier_scope = oneOf(it.tier_scope, TIER_SCOPES, "all");
    if (tier_scope !== "all") {
      if (upgrades >= LIMITS.upgrades) {
        upgradesDropped++;
        continue;
      }
      upgrades++;
    }

    const roomRef = typeof it.room_ref === "string" && roomRefs.has(it.room_ref.trim()) ? it.room_ref.trim() : null;
    const flags: string[] = [];
    let penalty = 0;

    if (unit === "sqft" && totalArea != null && net > totalArea * 6) {
      flags.push("quantity_outlier");
      penalty = 0.4;
    }

    const modelConfidence = clamp(num(it.confidence) ?? 0.5, 0, 1);
    const evidence = str(it.evidence, 240);
    const labor = num(it.labor_hours_each);
    const ballpark = num(it.ballpark_unit_price_cents);

    const draft: DraftItem = {
      room_ref: roomRef,
      kind,
      description,
      category: normalizeCategory(it.category),
      unit,
      net_quantity: round(clamp(net, 0.01, LIMITS.quantity), 2),
      basis,
      model_confidence: modelConfidence,
      confidence: calibrateConfidence({ model: modelConfidence, basis, hasEvidence: Boolean(evidence), planQuality, scaleConfidence, penalty }),
      evidence,
      source_ref: str(it.source_ref, 40) || null,
      search_terms: strList(it.search_terms, 4, 40),
      tier_scope,
      labor_hours_each: labor != null && labor >= 0 ? round(clamp(labor, 0, LIMITS.hoursPerUnit), 3) : null,
      ballpark_unit_price_cents:
        ballpark != null && ballpark > 0 ? Math.round(clamp(ballpark, 1, LIMITS.unitPriceCents)) : null,
      flags,
    };

    const key = `${draft.room_ref ?? ""}|${tokenize(draft.description).sort().join(" ")}|${draft.unit}`;
    const prior = dupKeys.get(key);
    if (prior) {
      if (prior.evidence === draft.evidence && prior.source_ref === draft.source_ref) continue; // exact repeat
      prior.flags.push("possible_duplicate");
      draft.flags.push("possible_duplicate");
    } else {
      dupKeys.set(key, draft);
    }
    items.push(draft);
  }

  if (upgradesDropped > 0) warnings.push(`${upgradesDropped} extra upgrade suggestion(s) were dropped (limit ${LIMITS.upgrades}).`);
  if (rawItems.length > LIMITS.items) warnings.push(`Only the first ${LIMITS.items} items were kept.`);
  if (items.length === 0 && rooms.length === 0) return null;

  const missing = strList(raw.missing_info, 12, 200);
  if (!scaleDetected && !missing.some((m) => /scale/i.test(m))) {
    missing.push("No drawing scale was found; inferred measurements are unreliable until a scale or key dimension is confirmed.");
  }

  return {
    summary: str(project.summary, 600),
    scale_detected: scaleDetected,
    scale_confidence: round(scaleConfidence, 2),
    plan_quality: planQuality,
    total_area_sqft: totalArea,
    rooms,
    items,
    assumptions: strList(raw.assumptions, LIMITS.assumptions, 200),
    missing_info: missing,
    warnings,
  };
}

// ============================================================
// QUANTITY: WASTE + ROUNDING
// ============================================================

const WASTE_RULES: { pattern: RegExp; percent: number }[] = [
  { pattern: /drywall|gypsum|sheetrock|wallboard/, percent: 10 },
  { pattern: /tile|grout|backsplash/, percent: 12 },
  { pattern: /flooring|laminate|lvp|vinyl plank|hardwood|carpet|underlayment/, percent: 10 },
  { pattern: /paint|primer|stain|caulk/, percent: 5 },
  { pattern: /shingle|roofing|felt|flashing|soffit|fascia|siding/, percent: 10 },
  { pattern: /lumber|stud|joist|rafter|plywood|osb|framing|trim|baseboard|molding|crown/, percent: 8 },
  { pattern: /wire|cable|romex|conduit|pipe|tubing|duct/, percent: 8 },
  { pattern: /insulation|batt/, percent: 7 },
  { pattern: /fence|decking|mulch|gravel|sod|soil/, percent: 8 },
];

/** Waste is never applied to counted fixtures, fees or things a person typed in. */
export function defaultWastePercent(item: Pick<TakeoffItem, "kind" | "basis" | "description" | "category" | "unit">): number {
  if (item.kind !== "material" || item.basis === "counted" || item.basis === "manual") return 0;
  if (item.unit === "ea" || item.unit === "set" || item.unit === "pair" || item.unit === "hr") return 0;
  const text = `${item.description} ${item.category}`.toLowerCase();
  return WASTE_RULES.find((r) => r.pattern.test(text))?.percent ?? 0;
}

/** Integer quantity that is actually bought, priced and quoted. */
export function finalQuantity(netQuantity: number, wastePercent: number): number {
  if (!(netQuantity > 0)) return 0;
  const gross = netQuantity * (1 + clamp(wastePercent, 0, 100) / 100);
  return Math.min(LIMITS.quantity, Math.max(1, Math.ceil(gross - 1e-9)));
}

// ============================================================
// LABOR
// ============================================================

interface LaborRule {
  pattern: RegExp;
  unit: string;
  hours: number;
}

/** Conservative journeyman install hours per unit, used to sanity-check the model. */
const LABOR_RULES: LaborRule[] = [
  { pattern: /outlet|receptacle|gfci/, unit: "ea", hours: 0.4 },
  { pattern: /switch|dimmer/, unit: "ea", hours: 0.35 },
  { pattern: /recessed|can light|downlight/, unit: "ea", hours: 0.6 },
  { pattern: /ceiling fan/, unit: "ea", hours: 1.25 },
  { pattern: /light fixture|luminaire|pendant|vanity light|sconce/, unit: "ea", hours: 0.75 },
  { pattern: /smoke|co detector|carbon monoxide/, unit: "ea", hours: 0.3 },
  { pattern: /breaker/, unit: "ea", hours: 0.4 },
  { pattern: /(electrical|service) panel|subpanel/, unit: "ea", hours: 6 },
  { pattern: /toilet|commode/, unit: "ea", hours: 1.5 },
  { pattern: /sink|lavatory/, unit: "ea", hours: 1.75 },
  { pattern: /faucet/, unit: "ea", hours: 1 },
  { pattern: /shower (valve|pan|base|door)|tub/, unit: "ea", hours: 5 },
  { pattern: /water heater/, unit: "ea", hours: 3.5 },
  { pattern: /dishwasher|disposal/, unit: "ea", hours: 1.5 },
  { pattern: /(interior|exterior|entry|pocket|barn)? ?door/, unit: "ea", hours: 1.5 },
  { pattern: /window/, unit: "ea", hours: 1.75 },
  { pattern: /cabinet/, unit: "ea", hours: 0.75 },
  { pattern: /drywall|gypsum|sheetrock/, unit: "sheet", hours: 0.4 },
  { pattern: /drywall|gypsum|sheetrock/, unit: "sqft", hours: 0.012 },
  { pattern: /paint|primer/, unit: "sqft", hours: 0.008 },
  { pattern: /tile/, unit: "sqft", hours: 0.1 },
  { pattern: /flooring|laminate|lvp|vinyl plank|hardwood|carpet/, unit: "sqft", hours: 0.04 },
  { pattern: /insulation|batt/, unit: "sqft", hours: 0.012 },
  { pattern: /shingle|roofing/, unit: "sqft", hours: 0.015 },
  { pattern: /baseboard|trim|molding|crown/, unit: "lf", hours: 0.05 },
  { pattern: /pipe|tubing/, unit: "lf", hours: 0.12 },
  { pattern: /duct/, unit: "lf", hours: 0.15 },
  { pattern: /wire|cable|romex|conduit/, unit: "lf", hours: 0.025 },
  { pattern: /fence/, unit: "lf", hours: 0.25 },
];

const LABOR_UNIT_FALLBACK: Record<string, number> = {
  ea: 0.5, sqft: 0.015, lf: 0.06, sheet: 0.35, set: 1, pair: 0.75, sq: 1.5, bundle: 0.2,
  bag: 0.1, box: 0.1, roll: 0.15, gal: 0.1, cy: 1,
};

export function laborTableHours(description: string, category: string, unit: string): number | null {
  const text = `${description} ${category}`.toLowerCase();
  const rule = LABOR_RULES.find((r) => r.unit === unit && r.pattern.test(text));
  return rule ? rule.hours : null;
}

/**
 * Install hours per unit. The model's figure is trusted only within 0.5x-2x of
 * the built-in table (when the table knows the item); outside that band the
 * item is clamped and flagged so a human sees it.
 */
export function resolveLaborHours(input: {
  kind: ItemKind;
  description: string;
  category: string;
  unit: string;
  ai_hours: number | null;
  labor_included: boolean;
}): { hours: number; flag: string | null } {
  if (input.labor_included || input.kind === "fee" || input.kind === "labor" || input.unit === "hr") {
    return { hours: 0, flag: null };
  }
  const table = laborTableHours(input.description, input.category, input.unit);
  const fallback = LABOR_UNIT_FALLBACK[input.unit] ?? 0.1;

  if (input.ai_hours == null) return { hours: round(table ?? fallback, 3), flag: null };
  if (table == null) return { hours: round(clamp(input.ai_hours, 0, LIMITS.hoursPerUnit), 3), flag: null };

  const lo = table * 0.5;
  const hi = table * 2;
  if (input.ai_hours < lo || input.ai_hours > hi) {
    return { hours: round(clamp(input.ai_hours, lo, hi), 3), flag: "labor_clamped" };
  }
  return { hours: round(input.ai_hours, 3), flag: null };
}

export interface LaborGroup {
  category: string;
  computedHours: number;
  hours: number;
  overridden: boolean;
  sellCents: number;
  costCents: number | null;
}

export interface LaborSummary {
  groups: LaborGroup[];
  totalHours: number;
  sellCents: number;
  costCents: number | null;
  /** True when there is labor to bill but no hourly rate has been set. */
  missingRate: boolean;
}

function roundUpHours(h: number): number {
  return Math.ceil(h / LABOR_ROUNDING_HOURS - 1e-9) * LABOR_ROUNDING_HOURS;
}

export function activeItems(items: TakeoffItem[]): TakeoffItem[] {
  return items.filter((i) => i.review_status !== "rejected");
}

export function inTier(scope: TierScope, tier: TierKey): boolean {
  if (scope === "all") return true;
  if (scope === "better_plus") return tier === "better" || tier === "best";
  return tier === "best";
}

export function itemsForTier(items: TakeoffItem[], tier: TierKey): TakeoffItem[] {
  return activeItems(items).filter((i) => inTier(i.tier_scope, tier));
}

export function computeLabor(
  items: TakeoffItem[],
  settings: Pick<ProjectSettings, "labor_rate_cents" | "labor_cost_rate_cents" | "labor_overrides">,
): LaborSummary {
  const byCategory = new Map<string, number>();
  for (const it of items) {
    if (it.kind === "fee" || it.kind === "labor" || it.labor_included) continue;
    const hours = (it.labor_hours_each ?? 0) * it.quantity;
    if (hours <= 0) continue;
    byCategory.set(it.category, (byCategory.get(it.category) ?? 0) + hours);
  }

  const groups: LaborGroup[] = [];
  for (const [category, raw] of byCategory) {
    const computedHours = roundUpHours(raw * (1 + LABOR_OVERHEAD_PERCENT / 100));
    const override = settings.labor_overrides[category];
    const overridden = typeof override === "number" && Number.isFinite(override) && override >= 0;
    const hours = overridden ? round(override, 2) : computedHours;
    groups.push({
      category,
      computedHours,
      hours,
      overridden,
      sellCents: Math.round(hours * settings.labor_rate_cents),
      costCents: settings.labor_cost_rate_cents != null ? Math.round(hours * settings.labor_cost_rate_cents) : null,
    });
  }
  groups.sort((a, b) => a.category.localeCompare(b.category));

  const totalHours = round(groups.reduce((s, g) => s + g.hours, 0), 2);
  return {
    groups,
    totalHours,
    sellCents: groups.reduce((s, g) => s + g.sellCents, 0),
    costCents: settings.labor_cost_rate_cents != null ? groups.reduce((s, g) => s + (g.costCents ?? 0), 0) : null,
    missingRate: totalHours > 0 && settings.labor_rate_cents <= 0,
  };
}

/** Best hourly price-book entry for the trade -> default labor rate for a new takeoff. */
export function pickLaborRate(
  priceBook: PriceBookEntry[],
  trade: string,
): { rate_cents: number; cost_cents: number | null; name: string } | null {
  const hourly = priceBook.filter((p) => p.pricing_model === "hourly" && p.price_cents > 0);
  if (hourly.length === 0) return null;
  const tradeTokens = new Set(tokenize(trade));
  let best = hourly[0];
  let bestScore = -1;
  for (const p of hourly) {
    const t = new Set([...tokenize(p.service_name), ...tokenize(p.category ?? ""), ...p.keywords.flatMap(tokenize)]);
    let s = 0;
    for (const tok of tradeTokens) if (t.has(tok)) s++;
    if (/labor|labour|technician|journeyman|crew|rate/.test(p.service_name.toLowerCase())) s += 0.5;
    if (s > bestScore) {
      best = p;
      bestScore = s;
    }
  }
  return { rate_cents: best.price_cents, cost_cents: best.cost_cents, name: best.service_name };
}

// ============================================================
// CATALOG MATCHING (price book + supplier catalog)
// ============================================================

const STOP = new Set([
  "the", "a", "an", "of", "and", "or", "for", "with", "to", "in", "on", "per", "new", "install", "installation",
  "installed", "supply", "furnish", "standard", "std", "type", "ft", "inch", "inches", "feet", "foot", "w", "pkg",
]);

const SYNONYMS: Record<string, string> = {
  receptacle: "outlet", recept: "outlet", socket: "outlet", sheetrock: "drywall", gypsum: "drywall", gwb: "drywall",
  wallboard: "drywall", commode: "toilet", wc: "toilet", lavatory: "sink", lav: "sink", luminaire: "light",
  lighting: "light", lamp: "light", romex: "cable", nmb: "cable", pvc: "pvc", hardwood: "wood", lvp: "vinyl",
  laminate: "laminate", moulding: "molding", skirting: "baseboard", breaker: "breaker", cb: "breaker",
};

function stem(w: string): string {
  if (w.length > 4 && /(ses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !/^\d/.test(w)) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/["”“]/g, " in ")
    .replace(/['’]/g, " ft ")
    .replace(/[^a-z0-9/.\s-]/g, " ");
  const out = new Set<string>();
  for (const part of cleaned.split(/[\s-]+/)) {
    const w = part.replace(/^[./]+|[./]+$/g, "");
    if (!w || STOP.has(w)) continue;
    const mapped = SYNONYMS[w] ?? SYNONYMS[stem(w)] ?? stem(w);
    if (!STOP.has(mapped)) out.add(mapped);
  }
  return [...out];
}

const hasDigit = (t: string) => /\d/.test(t);

interface IndexedEntry {
  source: "price_book" | "supplier_catalog";
  id: string;
  name: string;
  tokens: Set<string>;
  sizeTokens: Set<string>;
  category: string;
  unit: string | null;
  keywordSets: Set<string>[];
  partNumber: string | null;
  priceBook?: PriceBookEntry;
  part?: PartEntry;
}

export interface CatalogIndex {
  entries: IndexedEntry[];
  priceBookById: Map<string, PriceBookEntry>;
}

export function buildCatalogIndex(catalog: Catalog): CatalogIndex {
  const entries: IndexedEntry[] = [];
  const priceBookById = new Map<string, PriceBookEntry>();

  for (const pb of catalog.priceBook) {
    priceBookById.set(pb.id, pb);
    if (pb.pricing_model === "hourly") continue; // hourly entries are labor rates, not items
    const tokens = new Set(tokenize(`${pb.service_name} ${pb.category ?? ""}`));
    entries.push({
      source: "price_book",
      id: pb.id,
      name: pb.service_name,
      tokens,
      sizeTokens: new Set([...tokens].filter(hasDigit)),
      category: (pb.category ?? "").toLowerCase(),
      unit: pb.unit_label,
      keywordSets: pb.keywords.map((k) => new Set(tokenize(k))).filter((s) => s.size > 0),
      partNumber: null,
      priceBook: pb,
    });
  }

  for (const part of catalog.parts) {
    const tokens = new Set(tokenize(`${part.name} ${part.category ?? ""}`));
    entries.push({
      source: "supplier_catalog",
      id: part.id,
      name: part.name,
      tokens,
      sizeTokens: new Set([...tokens].filter(hasDigit)),
      category: (part.category ?? "").toLowerCase(),
      unit: part.unit_label,
      keywordSets: [],
      partNumber: part.part_number ? part.part_number.toLowerCase() : null,
      part,
    });
  }
  return { entries, priceBookById };
}

function diceAndCover(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  if (inter === 0) return 0;
  const dice = (2 * inter) / (a.size + b.size);
  const cover = inter / a.size;
  return 0.6 * dice + 0.4 * cover;
}

export interface MatchQuery {
  description: string;
  category: string;
  unit: string;
  search_terms: string[];
}

function scoreEntry(
  q: { desc: Set<string>; search: Set<string>; text: string; category: string; unit: string },
  e: IndexedEntry,
): number {
  if (e.partNumber && e.partNumber.length >= 4 && q.text.includes(e.partNumber)) return 1;

  let score = Math.max(diceAndCover(q.desc, e.tokens), 0.9 * diceAndCover(q.search, e.tokens));
  if (score === 0) return 0;

  // Price-book keywords are how the business says the service in its own words.
  const all = new Set([...q.desc, ...q.search]);
  if (e.keywordSets.some((k) => [...k].every((t) => all.has(t)))) score += 0.15;

  // Whole search-term phrases contained in the entry.
  let searchHits = 0;
  for (const term of q.search) if (e.tokens.has(term)) searchHits++;
  score += Math.min(0.06, searchHits * 0.02);

  const catTokens = new Set(tokenize(q.category));
  if (e.category && catTokens.size > 0 && tokenize(e.category).some((t) => catTokens.has(t))) score += 0.05;

  const compat = unitsCompatible(q.unit, e.unit);
  if (compat === true) score += 0.05;
  else if (compat === false) score -= 0.15;

  // Sizes are discriminators: 5/8" drywall must not price 1/2" drywall.
  const qSizes = [...q.desc].filter(hasDigit);
  if (qSizes.length > 0 && e.sizeTokens.size > 0 && !qSizes.some((t) => e.sizeTokens.has(t))) score *= 0.6;

  return clamp(score, 0, 1);
}

function priceBookSell(pb: PriceBookEntry): { cents: number; flags: string[] } {
  if (pb.pricing_model === "range" && pb.price_max_cents != null) {
    return { cents: Math.round((pb.price_cents + pb.price_max_cents) / 2), flags: ["price_range"] };
  }
  if (pb.pricing_model === "starting_at") return { cents: pb.price_cents, flags: ["starting_at"] };
  return { cents: pb.price_cents, flags: [] };
}

function chooseOffer(part: PartEntry): PartVendorOffer | null {
  const usable = part.offers.filter((o) => o.unit_cost_cents > 0);
  if (usable.length === 0) return null;
  const preferred = usable.find((o) => o.is_preferred);
  if (preferred) return preferred;
  return [...usable].sort((a, b) => a.unit_cost_cents - b.unit_cost_cents || (a.lead_time_days ?? 99) - (b.lead_time_days ?? 99))[0];
}

function toCandidate(e: IndexedEntry, score: number, index: CatalogIndex): PriceCandidate {
  if (e.source === "price_book" && e.priceBook) {
    const sell = priceBookSell(e.priceBook);
    return {
      source: "price_book",
      entry_id: e.id,
      name: e.name,
      score: round(score, 3),
      fixed_sell_cents: sell.cents,
      cost_cents: e.priceBook.cost_cents,
      price_book_item_id: e.id,
      vendor_id: null,
      vendor_name: null,
      vendor_sku: null,
      lead_time_days: null,
      labor_included: true,
      flags: sell.flags,
    };
  }

  const part = e.part as PartEntry;
  const offer = chooseOffer(part);
  const cost = offer?.unit_cost_cents ?? (part.unit_cost_cents > 0 ? part.unit_cost_cents : null);
  const linked = part.price_book_item_id ? index.priceBookById.get(part.price_book_item_id) : undefined;
  const linkedSell = linked && linked.pricing_model !== "hourly" ? priceBookSell(linked) : null;
  return {
    source: "supplier_catalog",
    entry_id: e.id,
    name: e.name,
    score: round(score, 3),
    fixed_sell_cents: linkedSell?.cents ?? null,
    cost_cents: cost,
    price_book_item_id: linkedSell ? linked!.id : null,
    vendor_id: offer?.vendor_id ?? null,
    vendor_name: offer?.vendor_name ?? null,
    vendor_sku: offer?.vendor_sku ?? null,
    lead_time_days: offer?.lead_time_days ?? null,
    labor_included: false,
    flags: [...(linkedSell?.flags ?? []), ...(cost == null && !linkedSell ? ["cost_missing"] : [])],
  };
}

export interface MatchResult {
  status: "matched" | "ambiguous" | "unmatched";
  best: PriceCandidate | null;
  candidates: PriceCandidate[];
}

export function matchItem(query: MatchQuery, index: CatalogIndex): MatchResult {
  const q = {
    desc: new Set(tokenize(query.description)),
    search: new Set(tokenize(query.search_terms.join(" "))),
    text: query.description.toLowerCase(),
    category: query.category,
    unit: query.unit,
  };

  const scored = index.entries
    .map((e) => ({ e, score: scoreEntry(q, e) }))
    .filter((s) => s.score >= 0.25)
    // price book is the business's own sell price: it wins near-ties
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.e.source === b.e.source) return 0;
      return a.e.source === "price_book" ? -1 : 1;
    });

  // Prefer the price book when it is within a hair of the best supplier match.
  if (scored.length > 1 && scored[0].e.source === "supplier_catalog") {
    const pbIdx = scored.findIndex((s) => s.e.source === "price_book" && scored[0].score - s.score <= 0.05);
    if (pbIdx > 0) scored.unshift(...scored.splice(pbIdx, 1));
  }

  const candidates = scored.slice(0, 3).map((s) => toCandidate(s.e, s.score, index));
  if (candidates.length === 0) return { status: "unmatched", best: null, candidates: [] };

  const best = candidates[0];
  const second = candidates[1];
  if (best.score >= MATCH.accept && (!second || best.score - second.score >= MATCH.margin)) {
    return { status: "matched", best, candidates };
  }
  if (best.score >= MATCH.ambiguous) return { status: "ambiguous", best, candidates };
  return { status: "unmatched", best: null, candidates };
}

// ============================================================
// PRICING
// ============================================================

export interface PricedFields {
  price_source: PriceSource;
  price_book_item_id: string | null;
  inventory_part_id: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_sku: string | null;
  lead_time_days: number | null;
  unit_cost_cents: number | null;
  unit_price_cents: number | null;
  price_confidence: number;
  labor_included: boolean;
  match_status: MatchStatus;
  match_candidates: PriceCandidate[];
  flags: string[];
}

export function sellFromCandidate(c: PriceCandidate, markupPercent: number): number | null {
  if (c.fixed_sell_cents != null) return c.fixed_sell_cents;
  if (c.cost_cents == null || c.cost_cents <= 0) return null;
  return Math.round(c.cost_cents * (1 + clamp(markupPercent, 0, 500) / 100));
}

export function pricedFieldsFromCandidate(
  c: PriceCandidate,
  status: MatchStatus,
  candidates: PriceCandidate[],
  markupPercent: number,
): PricedFields {
  const sell = sellFromCandidate(c, markupPercent);
  const flags = [...c.flags];
  let confidence = c.score * 0.95 + (c.source === "price_book" ? 0.05 : 0);
  if (status === "ambiguous") confidence = c.score * 0.8;
  if (flags.includes("starting_at")) confidence *= 0.85;
  if (flags.includes("price_range")) confidence *= 0.9;
  if (sell == null) confidence = 0;
  if (status === "ambiguous") flags.push("ambiguous_match");

  return {
    price_source: sell == null ? "none" : c.source,
    price_book_item_id: c.price_book_item_id,
    inventory_part_id: c.source === "supplier_catalog" ? c.entry_id : null,
    vendor_id: c.vendor_id,
    vendor_name: c.vendor_name,
    vendor_sku: c.vendor_sku,
    lead_time_days: c.lead_time_days,
    unit_cost_cents: c.cost_cents,
    unit_price_cents: sell,
    price_confidence: round(clamp(confidence, 0, 0.99), 2),
    labor_included: c.labor_included && sell != null,
    match_status: status,
    match_candidates: candidates,
    flags,
  };
}

export function pricedFieldsFromBallpark(ballpark: number | null, candidates: PriceCandidate[]): PricedFields {
  return {
    price_source: ballpark != null ? "ai_estimate" : "none",
    price_book_item_id: null,
    inventory_part_id: null,
    vendor_id: null,
    vendor_name: null,
    vendor_sku: null,
    lead_time_days: null,
    unit_cost_cents: null,
    unit_price_cents: ballpark,
    price_confidence: ballpark != null ? 0.3 : 0,
    labor_included: false,
    match_status: "unmatched",
    match_candidates: candidates,
    flags: [ballpark != null ? "price_estimated" : "no_price"],
  };
}

/** Turns normalized model output + catalog into insert-ready item rows. */
export function buildItemRows(
  draft: DraftItem[],
  index: CatalogIndex,
  settings: Pick<ProjectSettings, "markup_percent">,
): TakeoffItemRow[] {
  return draft.map((d, i) => {
    const m = matchItem(d, index);
    const priced =
      m.best != null
        ? pricedFieldsFromCandidate(m.best, m.status === "matched" ? "matched" : "ambiguous", m.candidates, settings.markup_percent)
        : pricedFieldsFromBallpark(d.ballpark_unit_price_cents, m.candidates);

    const partial = { kind: d.kind, basis: d.basis, description: d.description, category: d.category, unit: d.unit };
    const waste = defaultWastePercent(partial);
    const labor = resolveLaborHours({
      kind: d.kind,
      description: d.description,
      category: d.category,
      unit: d.unit,
      ai_hours: d.labor_hours_each,
      labor_included: priced.labor_included,
    });

    return {
      room_ref: d.room_ref,
      sort_order: i,
      kind: d.kind,
      description: d.description,
      category: d.category,
      unit: d.unit,
      net_quantity: d.net_quantity,
      waste_percent: waste,
      quantity: finalQuantity(d.net_quantity, waste),
      ai_quantity: d.net_quantity,
      basis: d.basis,
      confidence: d.confidence,
      evidence: d.evidence,
      source_ref: d.source_ref,
      source: "ai",
      tier_scope: d.tier_scope,
      labor_hours_each: labor.hours,
      labor_included: priced.labor_included,
      price_source: priced.price_source,
      price_locked: false,
      price_book_item_id: priced.price_book_item_id,
      inventory_part_id: priced.inventory_part_id,
      vendor_id: priced.vendor_id,
      vendor_name: priced.vendor_name,
      vendor_sku: priced.vendor_sku,
      lead_time_days: priced.lead_time_days,
      unit_cost_cents: priced.unit_cost_cents,
      unit_price_cents: priced.unit_price_cents,
      price_confidence: priced.price_confidence,
      match_status: priced.match_status,
      match_candidates: priced.match_candidates,
      flags: [...new Set([...d.flags, ...priced.flags, ...(labor.flag ? [labor.flag] : [])])],
      review_status: "pending",
    };
  });
}

// ============================================================
// HUMAN CORRECTIONS (pure, so UI and tests share them)
// ============================================================

export type ItemPatch = Partial<Omit<TakeoffItem, "id">>;

/** Staff edit net quantity and/or waste. Waste edits never touch AI provenance. */
export function applyQuantityEdit(
  item: TakeoffItem,
  edit: { net_quantity?: number; waste_percent?: number },
): ItemPatch {
  const net = edit.net_quantity != null ? clamp(round(edit.net_quantity, 2), 0.01, LIMITS.quantity) : item.net_quantity;
  const waste = edit.waste_percent != null ? clamp(round(edit.waste_percent, 1), 0, 100) : item.waste_percent;
  return { net_quantity: net, waste_percent: waste, quantity: finalQuantity(net, waste), review_status: "edited" };
}

export function applyManualPrice(item: TakeoffItem, unitPriceCents: number): ItemPatch {
  const cents = Math.round(clamp(unitPriceCents, 0, LIMITS.unitPriceCents));
  return {
    unit_price_cents: cents,
    price_source: "manual",
    price_locked: true,
    price_confidence: 1,
    match_status: item.match_status === "unmatched" ? "manual" : item.match_status,
    flags: item.flags.filter((f) => f !== "price_estimated" && f !== "no_price" && f !== "ambiguous_match"),
    review_status: "edited",
  };
}

/** Staff pick a different catalog match (from the stored top-3). */
export function applyCandidate(item: TakeoffItem, candidate: PriceCandidate, markupPercent: number): ItemPatch {
  const priced = pricedFieldsFromCandidate(candidate, "matched", item.match_candidates, markupPercent);
  // Labor was folded into a price-book price before? Then re-derive it from the table.
  const keepHours = !item.labor_included && item.labor_hours_each != null;
  const labor = resolveLaborHours({
    kind: item.kind,
    description: item.description,
    category: item.category,
    unit: item.unit,
    ai_hours: keepHours ? item.labor_hours_each : null,
    labor_included: priced.labor_included,
  });
  return {
    ...priced,
    price_confidence: Math.max(priced.price_confidence, priced.unit_price_cents != null ? 0.9 : 0),
    price_locked: false,
    labor_hours_each: labor.hours,
    flags: [...new Set([...item.flags.filter((f) => f !== "ambiguous_match" && f !== "price_estimated" && f !== "no_price"), ...priced.flags.filter((f) => f !== "ambiguous_match")])],
    review_status: "edited",
  };
}

/** Markup changed: re-derive sell prices that come from supplier cost (never locked/manual ones). */
export function repriceForMarkup(items: TakeoffItem[], markupPercent: number): { id: string; unit_price_cents: number }[] {
  const changes: { id: string; unit_price_cents: number }[] = [];
  for (const it of items) {
    if (it.price_locked || it.price_source !== "supplier_catalog" || it.unit_cost_cents == null) continue;
    const cand = it.match_candidates.find((c) => c.entry_id === it.inventory_part_id);
    if (cand?.fixed_sell_cents != null) continue; // price book decides this one
    const next = Math.round(it.unit_cost_cents * (1 + clamp(markupPercent, 0, 500) / 100));
    if (next !== it.unit_price_cents) changes.push({ id: it.id, unit_price_cents: next });
  }
  return changes;
}

export function createManualItem(input: {
  description: string;
  category?: string;
  unit?: string;
  kind?: ItemKind;
  quantity: number;
  unit_price_cents: number;
  room_id?: string | null;
  tier_scope?: TierScope;
  sort_order?: number;
}): Omit<TakeoffItem, "id"> {
  const net = clamp(round(input.quantity, 2), 0.01, LIMITS.quantity);
  return {
    room_id: input.room_id ?? null,
    sort_order: input.sort_order ?? 9999,
    kind: input.kind ?? "material",
    description: str(input.description, 160),
    category: normalizeCategory(input.category),
    unit: normalizeUnit(input.unit),
    net_quantity: net,
    waste_percent: 0,
    quantity: finalQuantity(net, 0),
    ai_quantity: null,
    basis: "manual",
    confidence: 1,
    evidence: "Added by staff",
    source_ref: null,
    source: "human",
    tier_scope: input.tier_scope ?? "all",
    labor_hours_each: null,
    labor_included: input.kind === "labor" || input.kind === "fee",
    price_source: "manual",
    price_locked: true,
    price_book_item_id: null,
    inventory_part_id: null,
    vendor_id: null,
    vendor_name: null,
    vendor_sku: null,
    lead_time_days: null,
    unit_cost_cents: null,
    unit_price_cents: Math.round(clamp(input.unit_price_cents, 0, LIMITS.unitPriceCents)),
    price_confidence: 1,
    match_status: "manual",
    match_candidates: [],
    flags: [],
    review_status: "confirmed",
  };
}

// ============================================================
// HUMAN-IN-THE-LOOP GATE
// ============================================================

/** Does this line still need a person to look at it? */
export function requiresReview(item: TakeoffItem): boolean {
  if (item.review_status !== "pending") return false;
  return (
    item.confidence < CONFIDENCE.high ||
    item.price_confidence < PRICE_CONFIDENCE_REVIEW_BELOW ||
    item.unit_price_cents == null ||
    item.match_status !== "matched" ||
    item.basis === "assumed"
  );
}

export function isUnpriced(item: TakeoffItem): boolean {
  if (item.kind === "fee" && item.unit_price_cents === 0) return false;
  return item.unit_price_cents == null || item.unit_price_cents <= 0;
}

export interface GateBlocker {
  code: "no_items" | "pending_review" | "missing_price" | "missing_labor_rate" | "no_customer";
  message: string;
  itemIds: string[];
}

export interface ReviewGate {
  canConvert: boolean;
  blockers: GateBlocker[];
  warnings: string[];
  counts: { total: number; active: number; rejected: number; pendingReview: number; unpriced: number; lowConfidence: number; edited: number; confirmed: number };
}

export function evaluateReviewGate(
  items: TakeoffItem[],
  settings: Pick<ProjectSettings, "labor_rate_cents" | "labor_cost_rate_cents" | "labor_overrides">,
  project: Pick<ProjectInfo, "customer_name">,
): ReviewGate {
  const active = activeItems(items);
  const pending = active.filter(requiresReview);
  const unpriced = active.filter(isUnpriced);
  const low = active.filter((i) => i.confidence < CONFIDENCE.medium);
  const blockers: GateBlocker[] = [];
  const warnings: string[] = [];

  if (active.length === 0) blockers.push({ code: "no_items", message: "There are no active line items to quote.", itemIds: [] });
  if (!project.customer_name.trim()) blockers.push({ code: "no_customer", message: "Add the customer's name before creating a quote.", itemIds: [] });
  if (pending.length > 0) {
    blockers.push({
      code: "pending_review",
      message: `${pending.length} line${pending.length === 1 ? "" : "s"} need a human decision (confirm, correct or remove).`,
      itemIds: pending.map((i) => i.id),
    });
  }
  if (unpriced.length > 0) {
    blockers.push({
      code: "missing_price",
      message: `${unpriced.length} line${unpriced.length === 1 ? " has" : "s have"} no price. Pick a catalog match or enter a price.`,
      itemIds: unpriced.map((i) => i.id),
    });
  }
  const labor = computeLabor(active, settings);
  if (labor.missingRate) {
    blockers.push({ code: "missing_labor_rate", message: "Set an hourly labor rate so installation labor is billed.", itemIds: [] });
  }

  const confirmedLow = active.filter((i) => i.confidence < CONFIDENCE.medium && i.review_status !== "pending").length;
  if (confirmedLow > 0) warnings.push(`${confirmedLow} low-confidence line(s) were confirmed by a person.`);
  if (active.some((i) => i.flags.includes("possible_duplicate"))) warnings.push("Some lines look like possible duplicates.");

  return {
    canConvert: blockers.length === 0,
    blockers,
    warnings,
    counts: {
      total: items.length,
      active: active.length,
      rejected: items.length - active.length,
      pendingReview: pending.length,
      unpriced: unpriced.length,
      lowConfidence: low.length,
      edited: active.filter((i) => i.review_status === "edited").length,
      confirmed: active.filter((i) => i.review_status === "confirmed").length,
    },
  };
}

// ============================================================
// TOTALS
// ============================================================

export function lineTotalCents(item: Pick<TakeoffItem, "quantity" | "unit_price_cents">): number {
  return item.quantity * (item.unit_price_cents ?? 0);
}

export interface TierTotals {
  tier: TierKey;
  itemCount: number;
  materialsCents: number;
  feesCents: number;
  laborCents: number;
  laborHours: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Cost we actually know (items with a cost + labor cost rate). */
  knownCostCents: number;
  /** Share (0-1) of revenue whose cost is known — qualifies the margin figure. */
  costCoverage: number;
  marginPercent: number | null;
}

export function computeTierTotals(
  items: TakeoffItem[],
  settings: Pick<ProjectSettings, "labor_rate_cents" | "labor_cost_rate_cents" | "labor_overrides" | "tax_percent">,
  tier: TierKey,
): TierTotals {
  const set = itemsForTier(items, tier);
  let materials = 0;
  let fees = 0;
  let manualLabor = 0;
  let knownCost = 0;
  let revenueWithCost = 0;

  for (const it of set) {
    const total = lineTotalCents(it);
    if (it.kind === "fee") fees += total;
    else if (it.kind === "labor") manualLabor += total;
    else materials += total;
    if (it.unit_cost_cents != null) {
      knownCost += it.quantity * it.unit_cost_cents;
      revenueWithCost += total;
    }
  }

  const labor = computeLabor(set, settings);
  const laborCents = labor.sellCents + manualLabor;
  if (labor.costCents != null) {
    knownCost += labor.costCents;
    revenueWithCost += labor.sellCents;
  }

  const subtotal = materials + fees + laborCents;
  const tax = Math.round((subtotal * clamp(settings.tax_percent, 0, 100)) / 100);
  return {
    tier,
    itemCount: set.length,
    materialsCents: materials,
    feesCents: fees,
    laborCents,
    laborHours: labor.totalHours,
    subtotalCents: subtotal,
    taxCents: tax,
    totalCents: subtotal + tax,
    knownCostCents: knownCost,
    costCoverage: subtotal > 0 ? round(revenueWithCost / subtotal, 2) : 0,
    marginPercent: subtotal > 0 && revenueWithCost > 0 ? round(((revenueWithCost - knownCost) / revenueWithCost) * 100, 1) : null,
  };
}

/** Value-weighted overall confidence of the active lines (a $5 screw can't drag a $9k panel). */
export function computeOverallConfidence(items: TakeoffItem[]): number | null {
  const act = activeItems(items);
  if (act.length === 0) return null;
  let weighted = 0;
  let weights = 0;
  for (const it of act) {
    const w = Math.max(lineTotalCents(it), 500);
    const c = it.review_status === "confirmed" || it.review_status === "edited" ? Math.max(it.confidence, 0.95) : it.confidence;
    weighted += c * w;
    weights += w;
  }
  return round(weighted / weights, 2);
}

export interface AccuracyStats {
  aiLines: number;
  unchanged: number;
  edited: number;
  rejected: number;
  addedByStaff: number;
  /** Share of AI lines accepted without a quantity or price change. */
  hitRate: number | null;
  /** Mean absolute % quantity error across lines whose net quantity was corrected. */
  meanQuantityErrorPercent: number | null;
}

export function summarizeAccuracy(items: TakeoffItem[]): AccuracyStats {
  const ai = items.filter((i) => i.source === "ai");
  const decided = ai.filter((i) => i.review_status !== "pending");
  const rejected = ai.filter((i) => i.review_status === "rejected").length;
  const edited = ai.filter((i) => i.review_status === "edited");
  const unchanged = ai.filter((i) => i.review_status === "confirmed").length;
  const errs = edited
    .filter((i) => i.ai_quantity != null && i.ai_quantity > 0 && i.net_quantity !== i.ai_quantity)
    .map((i) => Math.abs(i.net_quantity - (i.ai_quantity as number)) / (i.ai_quantity as number));
  return {
    aiLines: ai.length,
    unchanged,
    edited: edited.length,
    rejected,
    addedByStaff: items.filter((i) => i.source === "human").length,
    hitRate: decided.length > 0 ? round(unchanged / decided.length, 2) : null,
    meanQuantityErrorPercent: errs.length > 0 ? round((errs.reduce((a, b) => a + b, 0) / errs.length) * 100, 1) : null,
  };
}

// ============================================================
// TIERED QUOTE
// ============================================================

export interface QuoteLine {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface QuoteOptionDraft {
  id: string;
  tier: TierKey;
  name: string;
  summary: string;
  line_items: QuoteLine[];
  highlights: string[];
  warranty_label: string | null;
  photo_ids: string[];
  recommended: boolean;
}

export interface QuoteDraft {
  /** Empty = classic single-price quote (no optional scope exists). */
  options: QuoteOptionDraft[];
  recommended_option_id: string | null;
  /** Mirrors the recommended option (or everything, for a classic quote). */
  line_items: QuoteLine[];
  totals: Record<TierKey, TierTotals>;
  warnings: string[];
}

const TIER_COPY: Record<TierKey, { name: string; summary: string }> = {
  good: { name: "Essential scope", summary: "Everything required to complete the work shown on the plans." },
  better: { name: "Recommended scope", summary: "The essential scope plus the upgrades we recommend for this project." },
  best: { name: "Complete scope", summary: "The full scope with every available upgrade." },
};

function lineDescription(it: TakeoffItem): string {
  return it.unit === "ea" ? it.description : `${it.description} (${it.unit})`;
}

export function buildTierLines(
  items: TakeoffItem[],
  settings: Pick<ProjectSettings, "labor_rate_cents" | "labor_cost_rate_cents" | "labor_overrides" | "detail_level">,
  tier: TierKey,
): QuoteLine[] {
  const set = itemsForTier(items, tier);
  const lines: QuoteLine[] = [];

  if (settings.detail_level === "summary") {
    const byCat = new Map<string, number>();
    for (const it of set) {
      if (it.kind === "fee" || it.kind === "labor") continue;
      byCat.set(it.category, (byCat.get(it.category) ?? 0) + lineTotalCents(it));
    }
    for (const [cat, cents] of [...byCat].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (cents > 0) lines.push({ description: `${cat} — materials & fixtures`, quantity: 1, unit_price_cents: cents });
    }
  } else {
    const merged = new Map<string, QuoteLine>();
    for (const it of set) {
      if (it.kind === "fee" || it.kind === "labor") continue;
      const price = it.unit_price_cents ?? 0;
      const key = `${lineDescription(it)}|${price}`;
      const prior = merged.get(key);
      if (prior) prior.quantity += it.quantity;
      else merged.set(key, { description: lineDescription(it), quantity: it.quantity, unit_price_cents: price });
    }
    lines.push(...[...merged.values()].sort((a, b) => a.description.localeCompare(b.description)));
  }

  for (const it of set) {
    if (it.kind === "labor") lines.push({ description: lineDescription(it), quantity: it.quantity, unit_price_cents: it.unit_price_cents ?? 0 });
  }

  const labor = computeLabor(set, settings);
  for (const g of labor.groups) {
    if (g.sellCents <= 0) continue;
    lines.push({
      description: `${g.category} — installation labor (${round(g.hours, 2)} hrs)`,
      quantity: 1,
      unit_price_cents: g.sellCents,
    });
  }

  for (const it of set) {
    if (it.kind === "fee") lines.push({ description: lineDescription(it), quantity: it.quantity, unit_price_cents: it.unit_price_cents ?? 0 });
  }
  return lines.filter((l) => l.quantity > 0 && l.unit_price_cents >= 0);
}

export function buildQuoteDraft(
  items: TakeoffItem[],
  settings: ProjectSettings,
  newId: () => string,
): QuoteDraft {
  const totals = Object.fromEntries(TIER_ORDER.map((t) => [t, computeTierTotals(items, settings, t)])) as Record<TierKey, TierTotals>;
  const warnings: string[] = [];

  // A tier that adds nothing over the previous one is dropped (no duplicate prices).
  const present: TierKey[] = [];
  let prevCount = -1;
  for (const t of TIER_ORDER) {
    const count = itemsForTier(items, t).length;
    if (count > prevCount) present.push(t);
    prevCount = count;
  }

  if (present.length < 2) {
    const lines = buildTierLines(items, settings, "best");
    warnings.push("No optional upgrades exist, so this becomes a single-price quote. Mark items as 'Better' or 'Best' to offer choices.");
    return { options: [], recommended_option_id: null, line_items: lines, totals, warnings };
  }

  const recommendedTier: TierKey = present.includes("better") ? "better" : present[present.length - 1];
  const options: QuoteOptionDraft[] = present.map((tier, i) => {
    const added = i === 0 ? [] : itemsForTier(items, tier).filter((it) => !itemsForTier(items, present[i - 1]).some((p) => p.id === it.id));
    const names = added.map((a) => a.description).slice(0, 3);
    const copy = TIER_COPY[tier];
    return {
      id: newId(),
      tier,
      name: copy.name,
      summary: copy.summary,
      line_items: buildTierLines(items, settings, tier),
      highlights: i === 0 ? [] : [...names.map((n) => `Adds ${n}`), ...(added.length > names.length ? [`+${added.length - names.length} more upgrade(s)`] : [])],
      warranty_label: null,
      photo_ids: [],
      recommended: tier === recommendedTier,
    };
  });

  const recommended = options.find((o) => o.recommended) ?? options[0];
  return { options, recommended_option_id: recommended.id, line_items: recommended.line_items, totals, warnings };
}

export interface QuotePayloadInput {
  userId: string;
  projectId: string;
  project: ProjectInfo;
  settings: ProjectSettings;
  draft: QuoteDraft;
}

/** Row for `quotes` — always a DRAFT; a human sends it from the normal quote flow. */
export function buildQuotePayload(input: QuotePayloadInput) {
  const { project, settings, draft } = input;
  return {
    user_id: input.userId,
    lead_id: project.lead_id,
    customer_name: project.customer_name.trim(),
    customer_phone: project.customer_phone?.trim() || null,
    customer_email: project.customer_email?.trim() || null,
    line_items: draft.line_items,
    options: draft.options,
    recommended_option_id: draft.recommended_option_id,
    tax_percent: settings.tax_percent,
    status: "draft" as const,
    ai_generated: true,
    ai_detected_issue: (project.ai_summary || project.name).slice(0, 300),
    ai_confidence: project.overall_confidence,
    takeoff_project_id: input.projectId,
  };
}
