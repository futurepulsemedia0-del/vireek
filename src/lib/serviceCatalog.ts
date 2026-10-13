/**
 * Vireek Service Catalog — pure domain logic (no network, no React).
 */

import { formatCents } from '@/lib/priceBook';

export type CatalogPricingModel = 'flat' | 'hourly';
export type CatalogTaxClass = 'taxable' | 'non_taxable' | 'labor_taxable' | 'materials_taxable';
export type AiQuoteMode = 'quote' | 'range' | 'visit_required' | 'never';

export interface CatalogCategory {
  id: string;
  name: string;
  sort_order: number;
}

export interface CatalogItem {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  pricing_model: CatalogPricingModel;
  price_cents: number;
  min_charge_cents: number | null;
  duration_minutes: number;
  required_skills: string[];
  tax_class: CatalogTaxClass;
  bookable: boolean;
  ai_quote_mode: AiQuoteMode;
  ai_range_pct: number;
  ai_max_discount_pct: number;
  ai_price_floor_cents: number | null;
  ai_approval_above_cents: number | null;
  ai_keywords: string[];
  ai_notes: string | null;
  sort_order: number;
}

/** Writable columns (user_id / id / timestamps are owned by the database). */
export type CatalogItemPayload = Omit<CatalogItem, 'id' | 'sort_order'>;

export const CATALOG_LIMITS = {
  nameMin: 2,
  nameMax: 120,
  descriptionMax: 1000,
  notesMax: 500,
  categoryNameMax: 80,
  tagsMax: 20,
  tagMax: 40,
  durationMin: 5,
  durationMax: 1440,
  maxCents: 100_000_000,
  maxDiscountPct: 50,
} as const;

export const ITEM_COLUMNS =
  'id, category_id, name, description, pricing_model, price_cents, min_charge_cents, duration_minutes, required_skills, tax_class, bookable, ai_quote_mode, ai_range_pct, ai_max_discount_pct, ai_price_floor_cents, ai_approval_above_cents, ai_keywords, ai_notes, sort_order';
export const CATEGORY_COLUMNS = 'id, name, sort_order';

export const PRICING_MODEL_LABELS: Record<CatalogPricingModel, string> = {
  flat: 'Flat price',
  hourly: 'Hourly rate',
};

export const TAX_CLASS_LABELS: Record<CatalogTaxClass, string> = {
  taxable: 'Taxable',
  non_taxable: 'Non-taxable',
  labor_taxable: 'Labor taxable only',
  materials_taxable: 'Materials taxable only',
};

export const AI_QUOTE_MODE_LABELS: Record<AiQuoteMode, string> = {
  quote: 'Quote the exact price',
  range: 'Quote a price range',
  visit_required: 'Offer a site visit instead',
  never: 'Never quote — hand off to a person',
};

export const AI_QUOTE_MODE_BADGES: Record<AiQuoteMode, string> = {
  quote: 'AI quotes price',
  range: 'AI quotes range',
  visit_required: 'Site visit first',
  never: 'AI hands off',
};

const PRICING_MODELS = Object.keys(PRICING_MODEL_LABELS) as CatalogPricingModel[];
const TAX_CLASSES = Object.keys(TAX_CLASS_LABELS) as CatalogTaxClass[];
const AI_MODES = Object.keys(AI_QUOTE_MODE_LABELS) as AiQuoteMode[];

// ---------------------------------------------------------------------------
// Parsing & formatting helpers
// ---------------------------------------------------------------------------

/** "$1,250.50" -> 125050. Returns null for anything that is not a non-negative amount with <= 2 decimals. */
export function parseMoneyToCents(input: string): number | null {
  const raw = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const [whole, frac = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= CATALOG_LIMITS.maxCents ? cents : null;
}

export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function parseIntInRange(input: string, min: number, max: number): number | null {
  const raw = input.trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

/** "HVAC, refrigerant\nhvac" -> ['HVAC', 'refrigerant'] (trimmed, de-duplicated case-insensitively, order kept). */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of input.split(/[,\n]/)) {
    const tag = part.trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function appendTag(current: string, tag: string): string {
  const tags = parseTags(current);
  if (tags.some((t) => t.toLowerCase() === tag.trim().toLowerCase())) return current;
  return [...tags, tag.trim()].join(', ');
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatCatalogPrice(
  item: Pick<CatalogItem, 'pricing_model' | 'price_cents' | 'min_charge_cents'>,
): string {
  if (item.pricing_model === 'flat') return formatCents(item.price_cents);
  const base = `${formatCents(item.price_cents)}/hr`;
  return item.min_charge_cents ? `${base} · ${formatCents(item.min_charge_cents)} min` : base;
}

/** Expected invoice for one default-duration visit (hourly respects the minimum charge). */
export function estimateTotalCents(
  item: Pick<CatalogItem, 'pricing_model' | 'price_cents' | 'min_charge_cents' | 'duration_minutes'>,
): number {
  if (item.pricing_model === 'flat') return item.price_cents;
  const timed = Math.round((item.price_cents * item.duration_minutes) / 60);
  return Math.max(item.min_charge_cents ?? 0, timed);
}

// ---------------------------------------------------------------------------
// Form state <-> payload
// ---------------------------------------------------------------------------

export interface CatalogFormState {
  name: string;
  description: string;
  category_id: string;
  pricing_model: CatalogPricingModel;
  price: string;
  min_charge: string;
  duration: string;
  required_skills: string;
  tax_class: CatalogTaxClass;
  bookable: boolean;
  ai_quote_mode: AiQuoteMode;
  ai_range_pct: string;
  ai_max_discount_pct: string;
  ai_price_floor: string;
  ai_approval_above: string;
  ai_keywords: string;
  ai_notes: string;
}

export const EMPTY_CATALOG_FORM: CatalogFormState = {
  name: '',
  description: '',
  category_id: '',
  pricing_model: 'flat',
  price: '',
  min_charge: '',
  duration: '60',
  required_skills: '',
  tax_class: 'taxable',
  bookable: true,
  ai_quote_mode: 'quote',
  ai_range_pct: '15',
  ai_max_discount_pct: '0',
  ai_price_floor: '',
  ai_approval_above: '',
  ai_keywords: '',
  ai_notes: '',
};

export function itemToForm(item: CatalogItem): CatalogFormState {
  return {
    name: item.name,
    description: item.description ?? '',
    category_id: item.category_id ?? '',
    pricing_model: item.pricing_model,
    price: centsToInput(item.price_cents),
    min_charge: centsToInput(item.min_charge_cents),
    duration: String(item.duration_minutes),
    required_skills: item.required_skills.join(', '),
    tax_class: item.tax_class,
    bookable: item.bookable,
    ai_quote_mode: item.ai_quote_mode,
    ai_range_pct: String(item.ai_range_pct),
    ai_max_discount_pct: String(item.ai_max_discount_pct),
    ai_price_floor: centsToInput(item.ai_price_floor_cents),
    ai_approval_above: centsToInput(item.ai_approval_above_cents),
    ai_keywords: item.ai_keywords.join(', '),
    ai_notes: item.ai_notes ?? '',
  };
}

export type CatalogFormErrors = Partial<Record<keyof CatalogFormState, string>>;

export interface CatalogValidation {
  errors: CatalogFormErrors;
  payload: CatalogItemPayload | null;
}

export function validateCatalogForm(form: CatalogFormState): CatalogValidation {
  const errors: CatalogFormErrors = {};
  const L = CATALOG_LIMITS;

  const name = form.name.trim();
  if (name.length < L.nameMin) errors.name = `Enter a service name (at least ${L.nameMin} characters).`;
  else if (name.length > L.nameMax) errors.name = `Keep the name under ${L.nameMax} characters.`;

  const description = form.description.trim();
  if (description.length > L.descriptionMax) errors.description = `Keep the description under ${L.descriptionMax} characters.`;

  if (!PRICING_MODELS.includes(form.pricing_model)) errors.pricing_model = 'Choose a pricing model.';
  if (!TAX_CLASSES.includes(form.tax_class)) errors.tax_class = 'Choose a tax class.';
  if (!AI_MODES.includes(form.ai_quote_mode)) errors.ai_quote_mode = 'Choose how the AI should quote.';

  const price = parseMoneyToCents(form.price);
  if (price === null) errors.price = 'Enter an amount like 149 or 149.50.';

  let minCharge: number | null = null;
  if (form.pricing_model === 'hourly' && form.min_charge.trim() !== '') {
    minCharge = parseMoneyToCents(form.min_charge);
    if (minCharge === null) errors.min_charge = 'Enter an amount like 75 or 75.50.';
  }

  const duration = parseIntInRange(form.duration, L.durationMin, L.durationMax);
  if (duration === null) errors.duration = `Enter whole minutes between ${L.durationMin} and ${L.durationMax}.`;

  const skills = parseTags(form.required_skills);
  if (skills.length > L.tagsMax) errors.required_skills = `Add at most ${L.tagsMax} skills.`;
  else if (skills.some((s) => s.length > L.tagMax)) errors.required_skills = `Each skill must be under ${L.tagMax} characters.`;

  const keywords = parseTags(form.ai_keywords);
  if (keywords.length > L.tagsMax) errors.ai_keywords = `Add at most ${L.tagsMax} phrases.`;
  else if (keywords.some((k) => k.length > L.tagMax)) errors.ai_keywords = `Each phrase must be under ${L.tagMax} characters.`;

  const rangePct = parseIntInRange(form.ai_range_pct, 1, 100);
  if (rangePct === null) errors.ai_range_pct = 'Enter a whole percentage from 1 to 100.';

  const discountPct = parseIntInRange(form.ai_max_discount_pct, 0, L.maxDiscountPct);
  if (discountPct === null) errors.ai_max_discount_pct = `Enter a whole percentage from 0 to ${L.maxDiscountPct}.`;

  let floor: number | null = null;
  if (form.ai_price_floor.trim() !== '') {
    floor = parseMoneyToCents(form.ai_price_floor);
    if (floor === null) errors.ai_price_floor = 'Enter an amount like 99 or 99.50.';
    else if (price !== null && floor > price) errors.ai_price_floor = 'The floor cannot be higher than the price.';
  }

  let approval: number | null = null;
  if (form.ai_approval_above.trim() !== '') {
    approval = parseMoneyToCents(form.ai_approval_above);
    if (approval === null) errors.ai_approval_above = 'Enter an amount like 500 or 500.50.';
  }

  const notes = form.ai_notes.trim();
  if (notes.length > L.notesMax) errors.ai_notes = `Keep the notes under ${L.notesMax} characters.`;

  if (Object.keys(errors).length > 0 || price === null || duration === null || rangePct === null || discountPct === null) {
    return { errors, payload: null };
  }

  return {
    errors,
    payload: {
      category_id: form.category_id || null,
      name,
      description: description || null,
      pricing_model: form.pricing_model,
      price_cents: price,
      min_charge_cents: form.pricing_model === 'hourly' ? minCharge : null,
      duration_minutes: duration,
      required_skills: skills,
      tax_class: form.tax_class,
      bookable: form.bookable,
      ai_quote_mode: form.ai_quote_mode,
      ai_range_pct: rangePct,
      ai_max_discount_pct: discountPct,
      ai_price_floor_cents: floor,
      ai_approval_above_cents: approval,
      ai_keywords: keywords,
      ai_notes: notes || null,
    },
  };
}

// ---------------------------------------------------------------------------
// AI quoting rules (deterministic reference resolver)
// ---------------------------------------------------------------------------

export type AiQuoteAction = 'quote' | 'range' | 'visit' | 'handoff';

export type AiQuoteRuleInput = Pick<
  CatalogItemPayload,
  | 'name'
  | 'pricing_model'
  | 'price_cents'
  | 'min_charge_cents'
  | 'ai_quote_mode'
  | 'ai_range_pct'
  | 'ai_max_discount_pct'
  | 'ai_price_floor_cents'
  | 'ai_approval_above_cents'
>;

export interface AiQuoteDecision {
  action: AiQuoteAction;
  minCents: number | null;
  maxCents: number | null;
  unit: 'job' | 'hour';
  requiresApproval: boolean;
  message: string;
}

const roundToDollar = (cents: number) => Math.round(cents / 100) * 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function resolveAiQuote(rule: AiQuoteRuleInput, opts: { requestedDiscountPct?: number } = {}): AiQuoteDecision {
  const unit = rule.pricing_model === 'hourly' ? 'hour' : 'job';
  const per = unit === 'hour' ? '/hr' : '';
  const floor = rule.ai_price_floor_cents ?? 0;
  const approvalAbove = rule.ai_approval_above_cents;

  if (rule.ai_quote_mode === 'never') {
    return {
      action: 'handoff',
      minCents: null,
      maxCents: null,
      unit,
      requiresApproval: false,
      message: `The assistant will not quote ${rule.name}. It takes the caller's details and hands off to your team.`,
    };
  }

  if (rule.ai_quote_mode === 'visit_required') {
    return {
      action: 'visit',
      minCents: null,
      maxCents: null,
      unit,
      requiresApproval: false,
      message: `The assistant will not give a price for ${rule.name} up front. It offers to book a site visit first.`,
    };
  }

  const minChargeNote = rule.min_charge_cents ? ` (minimum charge ${formatCents(rule.min_charge_cents)})` : '';

  if (rule.ai_quote_mode === 'range') {
    const pct = clamp(rule.ai_range_pct, 1, 100);
    const lo = Math.min(rule.price_cents, Math.max(floor, roundToDollar((rule.price_cents * (100 - pct)) / 100)));
    const hi = Math.max(rule.price_cents, roundToDollar((rule.price_cents * (100 + pct)) / 100));
    return {
      action: 'range',
      minCents: lo,
      maxCents: hi,
      unit,
      requiresApproval: approvalAbove !== null && hi > approvalAbove,
      message: `${rule.name} is typically ${formatCents(lo)}–${formatCents(hi)}${per}${minChargeNote}.`,
    };
  }

  const discountPct = clamp(Math.floor(opts.requestedDiscountPct ?? 0), 0, rule.ai_max_discount_pct);
  const discounted = Math.max(floor, Math.round((rule.price_cents * (100 - discountPct)) / 100));
  const discountNote = discountPct > 0 ? ` after a ${discountPct}% discount` : '';
  return {
    action: 'quote',
    minCents: discounted,
    maxCents: discounted,
    unit,
    requiresApproval: approvalAbove !== null && discounted > approvalAbove,
    message: `${rule.name} is ${formatCents(discounted)}${per}${discountNote}${minChargeNote}.`,
  };
}

// ---------------------------------------------------------------------------
// Grouping, filtering, stats
// ---------------------------------------------------------------------------

export interface CatalogSection {
  id: string | null;
  name: string;
  items: CatalogItem[];
}

export const UNCATEGORIZED_FILTER = '__none__';

const byOrderThenName = <T extends { sort_order: number; name: string }>(a: T, b: T) =>
  a.sort_order - b.sort_order || a.name.localeCompare(b.name);

export function groupCatalog(items: CatalogItem[], categories: CatalogCategory[]): CatalogSection[] {
  const known = new Set(categories.map((c) => c.id));
  const sections: CatalogSection[] = [...categories].sort(byOrderThenName).map((c) => ({
    id: c.id,
    name: c.name,
    items: items.filter((i) => i.category_id === c.id).sort(byOrderThenName),
  }));
  const loose = items.filter((i) => !i.category_id || !known.has(i.category_id)).sort(byOrderThenName);
  if (loose.length > 0) sections.push({ id: null, name: 'Uncategorized', items: loose });
  return sections.filter((s) => s.items.length > 0);
}

export interface CatalogFilters {
  query: string;
  /** '' = all, UNCATEGORIZED_FILTER = no category, otherwise a category id. */
  categoryId: string;
  bookable: 'all' | 'yes' | 'no';
}

export const EMPTY_FILTERS: CatalogFilters = { query: '', categoryId: '', bookable: 'all' };

export function filterCatalog(items: CatalogItem[], f: CatalogFilters): CatalogItem[] {
  const q = f.query.trim().toLowerCase();
  return items.filter((i) => {
    if (f.bookable === 'yes' && !i.bookable) return false;
    if (f.bookable === 'no' && i.bookable) return false;
    if (f.categoryId === UNCATEGORIZED_FILTER && i.category_id) return false;
    if (f.categoryId && f.categoryId !== UNCATEGORIZED_FILTER && i.category_id !== f.categoryId) return false;
    if (!q) return true;
    const haystack = [i.name, i.description ?? '', ...i.required_skills, ...i.ai_keywords].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

export function hasActiveFilters(f: CatalogFilters): boolean {
  return f.query.trim() !== '' || f.categoryId !== '' || f.bookable !== 'all';
}

export function catalogStats(items: CatalogItem[], categories: CatalogCategory[]) {
  return {
    services: items.length,
    bookable: items.filter((i) => i.bookable).length,
    restrictedByAi: items.filter((i) => i.ai_quote_mode !== 'quote').length,
    categories: categories.length,
  };
}

/** Skills already used in the catalog (most common first) — powers the editor's quick-add chips. */
export function collectKnownSkills(items: CatalogItem[], limit = 12): string[] {
  const counts = new Map<string, { label: string; n: number }>();
  for (const item of items) {
    for (const skill of item.required_skills) {
      const key = skill.toLowerCase();
      const hit = counts.get(key);
      if (hit) hit.n += 1;
      else counts.set(key, { label: skill, n: 1 });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map((v) => v.label);
}

// ---------------------------------------------------------------------------
// Row normalisation & error mapping
// ---------------------------------------------------------------------------

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const nullableStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};
const nullableInt = (v: unknown): number | null => (v === null || v === undefined ? null : int(v, 0));
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

export function normalizeCatalogItem(row: Record<string, unknown>): CatalogItem {
  return {
    id: str(row.id),
    category_id: nullableStr(row.category_id),
    name: str(row.name),
    description: nullableStr(row.description),
    pricing_model: oneOf(row.pricing_model, PRICING_MODELS, 'flat'),
    price_cents: int(row.price_cents, 0),
    min_charge_cents: nullableInt(row.min_charge_cents),
    duration_minutes: int(row.duration_minutes, 60),
    required_skills: strArray(row.required_skills),
    tax_class: oneOf(row.tax_class, TAX_CLASSES, 'taxable'),
    bookable: row.bookable !== false,
    ai_quote_mode: oneOf(row.ai_quote_mode, AI_MODES, 'quote'),
    ai_range_pct: int(row.ai_range_pct, 15),
    ai_max_discount_pct: int(row.ai_max_discount_pct, 0),
    ai_price_floor_cents: nullableInt(row.ai_price_floor_cents),
    ai_approval_above_cents: nullableInt(row.ai_approval_above_cents),
    ai_keywords: strArray(row.ai_keywords),
    ai_notes: nullableStr(row.ai_notes),
    sort_order: int(row.sort_order, 0),
  };
}

export function normalizeCatalogCategory(row: Record<string, unknown>): CatalogCategory {
  return { id: str(row.id), name: str(row.name), sort_order: int(row.sort_order, 0) };
}

/** Turns a Supabase/Postgres error into a sentence a person can act on. */
export function describeCatalogError(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';

  if (code === '23505') return 'A service or category with this name already exists.';
  if (code === '42501' || code === 'PGRST301') return "You don't have permission to change the service catalog.";
  if (code === 'PGRST116') return 'This item no longer exists, or you no longer have access to it.';
  const marker = 'service_catalog:';
  const at = message.indexOf(marker);
  if (at >= 0) return message.slice(at + marker.length).trim().replace(/^./, (c) => c.toUpperCase()) + '.';
  if (code === '23514') return 'One of the values is outside the allowed range.';
  return 'Something went wrong. Please try again.';
}
