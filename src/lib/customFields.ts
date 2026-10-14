/**
 * Custom Fields — pure logic (no I/O, no React, no Supabase).
 *
 * Mirrors the rules enforced by the database trigger `validate_custom_data()`
 * (see migration 20270502000000_custom_fields.sql) so the UI can show friendly
 * errors BEFORE a save is rejected. The database remains the source of truth.
 */

export type CustomFieldType = 'text' | 'number' | 'select' | 'date' | 'boolean';
export type CustomEntity = 'customer' | 'lead' | 'job';
export type CustomData = Record<string, unknown>;

export interface CustomFieldDef {
  id: string;
  user_id: string;
  entity: CustomEntity;
  key: string;
  label: string;
  field_type: CustomFieldType;
  options: string[];
  required: boolean;
  show_in_table: boolean;
  show_in_filters: boolean;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export const CUSTOM_ENTITIES: CustomEntity[] = ['customer', 'lead', 'job'];

export const CUSTOM_ENTITY_META: Record<CustomEntity, { plural: string; singular: string; table: string }> = {
  customer: { plural: 'Customers', singular: 'Customer', table: 'customers' },
  lead: { plural: 'Leads', singular: 'Lead', table: 'leads' },
  job: { plural: 'Jobs', singular: 'Job', table: 'jobs' },
};

export const CUSTOM_FIELD_TYPES: CustomFieldType[] = ['text', 'number', 'select', 'date', 'boolean'];

export const CUSTOM_FIELD_TYPE_META: Record<CustomFieldType, { label: string; hint: string }> = {
  text: { label: 'Text', hint: 'Free text up to 500 characters' },
  number: { label: 'Number', hint: 'Any number, e.g. square footage' },
  select: { label: 'Dropdown', hint: 'Pick one from a list you define' },
  date: { label: 'Date', hint: 'A calendar date' },
  boolean: { label: 'Yes / No', hint: 'A simple checkbox' },
};

export const MAX_FIELDS_PER_ENTITY = 30;
export const MAX_OPTIONS = 50;
export const MAX_LABEL_LENGTH = 60;
export const MAX_OPTION_LENGTH = 60;
export const MAX_TEXT_LENGTH = 500;
export const MAX_DATA_BYTES = 16_000;
const MAX_ABS_NUMBER = 1e15;

export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ============================================================
// FIELD DEFINITIONS
// ============================================================

/** Derives a stable, DB-safe key from a label, unique within `taken`. */
export function slugifyKey(label: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  let base = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) base = 'field'; // e.g. labels written only in Persian / Arabic / CJK
  if (/^\d/.test(base)) base = `f_${base}`;
  base = base.slice(0, 40).replace(/_+$/, '') || 'field';

  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, 40 - suffix.length).replace(/_+$/, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 30)}_${Date.now().toString(36)}`.slice(0, 40);
}

/** Splits (if a string), trims, collapses spaces, drops blanks and case-insensitive duplicates. */
export function normalizeOptions(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : input.split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const v = String(item).replace(/\s+/g, ' ').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export interface DefinitionInput {
  label: string;
  field_type: CustomFieldType;
  options: string[];
}

/** Returns a human error, or null when the definition is valid. */
export function validateDefinitionInput(
  input: DefinitionInput,
  otherActiveLabels: string[] = [],
): string | null {
  const label = input.label.trim();
  if (!label) return 'Give the field a name.';
  if (label.length > MAX_LABEL_LENGTH) return `Field names can be up to ${MAX_LABEL_LENGTH} characters.`;
  if (otherActiveLabels.some((l) => l.trim().toLowerCase() === label.toLowerCase())) {
    return 'A field with this name already exists.';
  }
  if (input.field_type === 'select') {
    const opts = normalizeOptions(input.options);
    if (opts.length === 0) return 'Add at least one option.';
    if (opts.length > MAX_OPTIONS) return `A dropdown can have up to ${MAX_OPTIONS} options.`;
    if (opts.some((o) => o.length > MAX_OPTION_LENGTH)) return `Options can be up to ${MAX_OPTION_LENGTH} characters.`;
  }
  return null;
}

export const isActiveDef = (d: CustomFieldDef) => d.archived_at === null;

export function sortDefs(defs: CustomFieldDef[]): CustomFieldDef[] {
  return [...defs].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
}

export const tableFields = (defs: CustomFieldDef[]) => sortDefs(defs).filter((d) => isActiveDef(d) && d.show_in_table);
export const filterFields = (defs: CustomFieldDef[]) => sortDefs(defs).filter((d) => isActiveDef(d) && d.show_in_filters);

// ============================================================
// VALUES
// ============================================================

export type ValueResult = { ok: true; value: string | number | boolean | null } | { ok: false; error: string };

function isValidYmd(s: string): boolean {
  if (!YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Validates + coerces one value (form strings are accepted for number/boolean). */
export function validateValue(def: Pick<CustomFieldDef, 'label' | 'field_type' | 'options'>, raw: unknown): ValueResult {
  if (isBlank(raw)) return { ok: true, value: null };
  const label = def.label;
  switch (def.field_type) {
    case 'text': {
      const s = String(raw).trim();
      if (s.length > MAX_TEXT_LENGTH) return { ok: false, error: `${label} can be up to ${MAX_TEXT_LENGTH} characters.` };
      return { ok: true, value: s };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/,/g, ''));
      if (!Number.isFinite(n) || Math.abs(n) > MAX_ABS_NUMBER) return { ok: false, error: `${label} must be a valid number.` };
      return { ok: true, value: n };
    }
    case 'select': {
      const s = String(raw);
      if (!def.options.includes(s)) return { ok: false, error: `${label}: choose one of the listed options.` };
      return { ok: true, value: s };
    }
    case 'date': {
      const s = String(raw).trim();
      if (!isValidYmd(s)) return { ok: false, error: `${label} must be a valid date.` };
      return { ok: true, value: s };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, error: `${label} must be yes or no.` };
    }
  }
}

/** UI-level validation (includes `required`, which the DB deliberately does not enforce). */
export function validateCustomData(defs: CustomFieldDef[], data: CustomData | null | undefined): string[] {
  const errors: string[] = [];
  const d = data ?? {};
  for (const def of sortDefs(defs).filter(isActiveDef)) {
    const raw = d[def.key];
    const res = validateValue(def, raw);
    if (!res.ok) {
      errors.push(res.error);
    } else if (def.required && def.field_type !== 'boolean' && res.value === null) {
      errors.push(`${def.label} is required.`);
    }
  }
  return errors;
}

/**
 * Produces the payload to store. Active fields are validated + coerced; blanks
 * are dropped. Values of ARCHIVED fields already on the record are preserved.
 * Unknown keys are discarded (the DB would reject them).
 */
export function sanitizeCustomData(defs: CustomFieldDef[], data: CustomData | null | undefined): CustomData {
  const d = data ?? {};
  const out: CustomData = {};
  for (const def of defs) {
    const raw = d[def.key];
    if (isActiveDef(def)) {
      const res = validateValue(def, raw);
      if (res.ok && res.value !== null) out[def.key] = res.value;
    } else if (!isBlank(raw)) {
      out[def.key] = raw;
    }
  }
  return out;
}

export function isSameCustomData(a: CustomData | null | undefined, b: CustomData | null | undefined): boolean {
  const x = a ?? {};
  const y = b ?? {};
  const kx = Object.keys(x).filter((k) => !isBlank(x[k]));
  const ky = Object.keys(y).filter((k) => !isBlank(y[k]));
  if (kx.length !== ky.length) return false;
  return kx.every((k) => String(x[k]) === String(y[k]));
}

/** Human display of a stored value ('' when empty). */
export function formatValue(def: Pick<CustomFieldDef, 'field_type'>, value: unknown): string {
  if (isBlank(value)) return '';
  switch (def.field_type) {
    case 'boolean':
      return value === true || value === 'true' ? 'Yes' : 'No';
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 6 }) : String(value);
    }
    default:
      return String(value);
  }
}

// ============================================================
// FILTERING (client-side, same model as the existing list pages)
// ============================================================

export interface CustomFilterEntry {
  /** text: contains · select: equals · boolean: 'yes' | 'no' */
  value?: string;
  /** number / date range bounds (dates as YYYY-MM-DD) */
  min?: string;
  max?: string;
}
export type CustomFilters = Record<string, CustomFilterEntry>;

const entryActive = (e: CustomFilterEntry | undefined) =>
  !!e && ((e.value ?? '').trim() !== '' || (e.min ?? '') !== '' || (e.max ?? '') !== '');

export function countActiveFilters(defs: CustomFieldDef[], filters: CustomFilters): number {
  return filterFields(defs).filter((d) => entryActive(filters[d.key])).length;
}

export function matchesCustomFilters(
  data: CustomData | null | undefined,
  defs: CustomFieldDef[],
  filters: CustomFilters,
): boolean {
  const d = data ?? {};
  for (const def of filterFields(defs)) {
    const f = filters[def.key];
    if (!entryActive(f)) continue;
    const v = d[def.key];
    if (isBlank(v)) return false;

    switch (def.field_type) {
      case 'text':
        if (!String(v).toLowerCase().includes((f!.value ?? '').trim().toLowerCase())) return false;
        break;
      case 'select':
        if (f!.value && String(v) !== f!.value) return false;
        break;
      case 'boolean':
        if (f!.value === 'yes' && v !== true) return false;
        if (f!.value === 'no' && v !== false) return false;
        break;
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) return false;
        if (f!.min !== undefined && f!.min !== '' && n < Number(f!.min)) return false;
        if (f!.max !== undefined && f!.max !== '' && n > Number(f!.max)) return false;
        break;
      }
      case 'date': {
        const s = String(v);
        if (f!.min && s < f!.min) return false;
        if (f!.max && s > f!.max) return false;
        break;
      }
    }
  }
  return true;
}
