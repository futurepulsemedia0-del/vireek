/**
 * Trade Pack framework — pure engine (no I/O, fully unit-tested).
 * The database re-validates everything that matters; this mirror gives the UI
 * instant feedback and keeps the two in sync via tests.
 */

import type {
  LogFieldDef,
  LogTypeDef,
  PricingLine,
  PricingModelDef,
  ProductUnit,
  Quote,
  QuoteLine,
  RateOverrides,
  RateTier,
  TradePack,
} from './types';

export const MAX_DATA_BYTES = 8000;
export const MAX_TEXT = 1000;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/* ------------------------------------------------------------------ */
/* Log-data validation                                                  */
/* ------------------------------------------------------------------ */

export type LogData = Record<string, unknown>;

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

function fieldError(f: LogFieldDef, v: unknown): string | null {
  switch (f.type) {
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${f.label} must be a number`;
      if (f.min !== undefined && v < f.min) return `${f.label} must be at least ${f.min}`;
      if (f.max !== undefined && v > f.max) return `${f.label} must be at most ${f.max}`;
      return null;
    }
    case 'boolean':
      return typeof v === 'boolean' ? null : `${f.label} must be yes or no`;
    case 'select':
      if (typeof v !== 'string' || !(f.options ?? []).includes(v)) return `${f.label} has an invalid choice`;
      return null;
    case 'multiselect':
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !(f.options ?? []).includes(x))) return `${f.label} has an invalid choice`;
      return null;
    default:
      if (typeof v !== 'string') return `${f.label} must be text`;
      return v.length > MAX_TEXT ? `${f.label} is too long (max ${MAX_TEXT})` : null;
  }
}

/** Returns a list of human-readable problems; empty = valid. Unknown keys are rejected. */
export function validateLogData(type: LogTypeDef, data: LogData): string[] {
  const errors: string[] = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['Entry data must be an object'];
  if (JSON.stringify(data).length > MAX_DATA_BYTES) errors.push('Entry is too large');
  const known = new Set(type.fields.map((f) => f.key));
  for (const k of Object.keys(data)) if (!known.has(k)) errors.push(`Unknown field "${k}"`);
  for (const f of type.fields) {
    const v = data[f.key];
    if (isBlank(v)) {
      if (f.required) errors.push(`${f.label} is required`);
      continue;
    }
    const e = fieldError(f, v);
    if (e) errors.push(e);
  }
  if (type.atLeastOneOf?.length && type.atLeastOneOf.every((k) => isBlank(data[k]))) {
    errors.push('Enter at least one reading');
  }
  // Cross-field rule (mirrored in trade_log_data_error): stock movements must be positive; only a Count may be 0.
  if (type.key === 'regulated_product' && data.action !== 'Count' && typeof data.quantity === 'number' && data.quantity <= 0) {
    errors.push('Quantity must be greater than 0');
  }
  return errors;
}

/** Drops blank values so the stored JSON stays small and the validator's "unknown/blank" rules agree. */
export function cleanLogData(data: LogData): LogData {
  const out: LogData = {};
  for (const [k, v] of Object.entries(data)) if (!isBlank(v)) out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}

/* ------------------------------------------------------------------ */
/* Regulated products: label rate + re-entry                            */
/* ------------------------------------------------------------------ */

export interface RateProduct {
  unit: ProductUnit;
  label_max_rate: number | null;
}

export interface RateCheck {
  ok: boolean;
  /** Applied rate per 1,000 sq ft, when computable. */
  rate: number | null;
  max: number | null;
  message: string | null;
}

/** Label maximum is expressed per 1,000 sq ft in the product's own unit. */
export function checkLabelRate(product: RateProduct, amount: unknown, unit: unknown, areaSqft: unknown): RateCheck {
  if (product.label_max_rate == null) return { ok: true, rate: null, max: null, message: null };
  if (typeof amount !== 'number' || typeof areaSqft !== 'number' || areaSqft <= 0) {
    return { ok: false, rate: null, max: product.label_max_rate, message: 'Amount and treated area are required for a product with a label rate limit' };
  }
  if (unit !== product.unit) {
    return { ok: false, rate: null, max: product.label_max_rate, message: `Use the product's unit (${product.unit}) so the label rate can be checked` };
  }
  const rate = round2(amount / (areaSqft / 1000));
  if (rate > product.label_max_rate) {
    return { ok: false, rate, max: product.label_max_rate, message: `Applied rate ${rate} per 1,000 sq ft exceeds the label maximum of ${product.label_max_rate}` };
  }
  return { ok: true, rate, max: product.label_max_rate, message: null };
}

/** ISO timestamp when re-entry becomes safe; null when no restriction. */
export function reentryUntil(performedAtISO: string, hours: number | null | undefined): string | null {
  if (!hours || hours <= 0) return null;
  const t = Date.parse(performedAtISO);
  return Number.isNaN(t) ? null : new Date(t + hours * 3_600_000).toISOString();
}

export const EPA_REG_RE = /^\d{1,6}-\d{1,6}(-\d{1,6})?$/;

/* ------------------------------------------------------------------ */
/* Credentials + retention                                              */
/* ------------------------------------------------------------------ */

export interface CredentialLike {
  credential_type: string;
  status: string;
  expires_at: string | null;
}

export function credentialCurrent(c: CredentialLike, onDate: Date): boolean {
  if (c.status !== 'active') return false;
  return c.expires_at == null || c.expires_at >= onDate.toISOString().slice(0, 10);
}

/** Which credential types does this entry demand, given the product? */
export function demandedCredentials(type: LogTypeDef, productRestricted: boolean): string[] {
  const list = [...type.requiredCredentials];
  return productRestricted && type.restrictedCredentials.length ? type.restrictedCredentials : list;
}

export function hasRequiredCredential(type: LogTypeDef, productRestricted: boolean, creds: CredentialLike[], onDate: Date): boolean {
  const need = demandedCredentials(type, productRestricted);
  if (!need.length) return true;
  return creds.some((c) => need.includes(c.credential_type) && credentialCurrent(c, onDate));
}

export function retentionUntil(performedAtISO: string, years: number): string {
  const d = new Date(performedAtISO);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Pricing                                                              */
/* ------------------------------------------------------------------ */

export function tierPrice(tiers: RateTier[], value: number): number {
  const sorted = [...tiers].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  for (const t of sorted) if (t.upTo === null || value <= t.upTo) return t.price;
  return sorted[sorted.length - 1]?.price ?? 0;
}

function lineAmount(line: PricingLine, inputs: Record<string, number>): number {
  const v = inputs[(line as { inputKey?: string }).inputKey ?? ''] ?? 0;
  switch (line.kind) {
    case 'flat':
      return line.amount;
    case 'tier':
      return tierPrice(line.tiers, v);
    case 'per_unit':
      return Math.max(line.minCharge ?? 0, v * line.unitPrice);
    case 'cost_plus':
      return v * (1 + line.markupPct / 100);
  }
}

export function applyRateOverrides(model: PricingModelDef, overrides: RateOverrides | undefined): PricingModelDef {
  if (!overrides) return model;
  return {
    ...model,
    lines: model.lines.map((l) => {
      const o = overrides[l.key];
      if (o === undefined) return l;
      if (l.kind === 'tier' && Array.isArray(o)) return { ...l, tiers: o };
      if (typeof o !== 'number' || !Number.isFinite(o) || o < 0) return l;
      if (l.kind === 'flat') return { ...l, amount: o };
      if (l.kind === 'per_unit') return { ...l, unitPrice: o };
      if (l.kind === 'cost_plus') return { ...l, markupPct: o };
      return l;
    }),
  };
}

export function quote(model: PricingModelDef, inputs: Record<string, number>, visitsPerYear: number): Quote {
  const visits = Math.max(0, Math.round(visitsPerYear));
  const lines: QuoteLine[] = model.lines.map((l) => ({ key: l.key, label: l.label, billing: l.billing, amount: round2(lineAmount(l, inputs)) }));
  const oneTime = round2(lines.filter((l) => l.billing === 'one_time').reduce((s, l) => s + l.amount, 0));
  const perVisit = round2(lines.filter((l) => l.billing === 'per_visit').reduce((s, l) => s + l.amount, 0));
  const annualRecurring = round2(perVisit * visits);
  return { lines, oneTime, perVisit, annualRecurring, monthlyRecurring: round2(annualRecurring / 12), firstYearTotal: round2(oneTime + annualRecurring) };
}

export function visitsPerYear(unit: 'week' | 'month' | 'year', count: number): number {
  if (count < 1) return 0;
  return unit === 'week' ? 52 / count : unit === 'month' ? 12 / count : 1 / count;
}

/* ------------------------------------------------------------------ */
/* Pack matching + seasons                                              */
/* ------------------------------------------------------------------ */

export function jobMatchesPack(pack: Pick<TradePack, 'serviceKeywords'>, serviceType: string | null | undefined): boolean {
  const s = (serviceType ?? '').toLowerCase();
  return !!s && pack.serviceKeywords.some((k) => s.includes(k));
}

/** Clamp a start date into the season and return the season's end date (same or next year). */
export function applySeason(startISO: string, season: { fromMonth: number; toMonth: number } | undefined): { start: string; end: string | null } {
  if (!season) return { start: startISO, end: null };
  const [y, m] = startISO.split('-').map(Number);
  const inSeason = (mm: number) => (season.fromMonth <= season.toMonth ? mm >= season.fromMonth && mm <= season.toMonth : mm >= season.fromMonth || mm <= season.toMonth);
  let year = y;
  let start = startISO;
  if (!inSeason(m)) {
    year = m > season.toMonth && season.fromMonth <= season.toMonth ? y + 1 : y;
    start = `${year}-${String(season.fromMonth).padStart(2, '0')}-01`;
  }
  const endYear = season.fromMonth <= season.toMonth ? Number(start.slice(0, 4)) : Number(start.slice(0, 4)) + (Number(start.slice(5, 7)) >= season.fromMonth ? 1 : 0);
  const lastDay = new Date(Date.UTC(endYear, season.toMonth, 0)).getUTCDate();
  return { start, end: `${endYear}-${String(season.toMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
}

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */

/** 0 = Sunday … 6 = Saturday, from a YYYY-MM-DD date (timezone-independent). */
export function weekdayOf(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface PlanStop {
  id: string;
  lat: number | null;
  lng: number | null;
  minutes: number;
}

export interface PlannedStop extends PlanStop {
  order: number;
  driveMinutes: number;
  /** Minutes from route start until service at this stop begins. */
  startOffsetMinutes: number;
}

export interface RoutePlan {
  stops: PlannedStop[];
  overflow: PlanStop[];
  totalMinutes: number;
  totalKm: number;
}

/**
 * Nearest-neighbour ordering with workday capacity. Stops without coordinates keep their
 * given order after the geocoded ones (no guessing). Anything that would exceed the workday
 * is returned in `overflow` for the dispatcher to move to another day.
 */
export function planRouteDay(stops: PlanStop[], opts: { start?: GeoPoint | null; workdayMinutes: number; speedKmh: number }): RoutePlan {
  const geo = stops.filter((s) => s.lat != null && s.lng != null);
  const plain = stops.filter((s) => s.lat == null || s.lng == null);
  const remaining = [...geo];
  let cursor: GeoPoint | null = opts.start ?? null;
  const ordered: PlanStop[] = [];
  while (remaining.length) {
    let best = 0;
    if (cursor) {
      let bestD = Infinity;
      remaining.forEach((s, i) => {
        const d = haversineKm(cursor as GeoPoint, { lat: s.lat as number, lng: s.lng as number });
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
    }
    const [next] = remaining.splice(best, 1);
    ordered.push(next);
    cursor = { lat: next.lat as number, lng: next.lng as number };
  }
  ordered.push(...plain);

  const planned: PlannedStop[] = [];
  const overflow: PlanStop[] = [];
  let t = 0;
  let km = 0;
  let prev: GeoPoint | null = opts.start ?? null;
  for (const s of ordered) {
    const here: GeoPoint | null = s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null;
    const dist = prev && here ? haversineKm(prev, here) : 0;
    const drive = Math.round((dist / Math.max(1, opts.speedKmh)) * 60);
    if (t + drive + s.minutes > opts.workdayMinutes) {
      overflow.push(s);
      continue;
    }
    t += drive;
    planned.push({ ...s, order: planned.length, driveMinutes: drive, startOffsetMinutes: t });
    t += s.minutes;
    km += dist;
    if (here) prev = here;
  }
  return { stops: planned, overflow, totalMinutes: t, totalKm: round2(km) };
}

export interface AgreementLike {
  id: string;
  service_type: string | null;
  interval_unit: 'week' | 'month' | 'year';
  interval_count: number;
  start_date: string;
  preferred_technician_id: string | null;
  status: string;
}

/**
 * Group active, weekly-cadence plans of a pack by (technician, anchor weekday). Weekly plans
 * land on the same weekday every visit, so they are the ones a fixed route can own.
 * Monthly/yearly plans vary by date and are scheduled by the existing dispatch board.
 */
export function groupAgreementsForRoutes(
  pack: Pick<TradePack, 'serviceKeywords'>,
  agreements: AgreementLike[],
): Array<{ technicianId: string | null; weekday: number; agreementIds: string[] }> {
  const map = new Map<string, { technicianId: string | null; weekday: number; agreementIds: string[] }>();
  for (const a of agreements) {
    if (a.status !== 'active' || a.interval_unit !== 'week' || !jobMatchesPack(pack, a.service_type)) continue;
    const weekday = weekdayOf(a.start_date);
    const key = `${a.preferred_technician_id ?? 'none'}:${weekday}`;
    const g = map.get(key) ?? { technicianId: a.preferred_technician_id, weekday, agreementIds: [] };
    g.agreementIds.push(a.id);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => a.weekday - b.weekday);
}

export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
