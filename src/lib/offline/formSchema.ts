// src/lib/offline/formSchema.ts
// Canonical field-form schema (v2). Pure: no Supabase, no IndexedDB, no DOM — so the
// technician's offline engine and the office's form builder share exactly one definition.
//
// v2 is a strict superset of the original six field types, so templates cached on devices
// before the builder existed keep rendering, and older clients ignore what they do not know.

export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'checkbox',
  'select',
  'yes_no',
  'pass_fail',
  'photo',
  'signature',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export const CONDITION_OPS = ['equals', 'not_equals', 'greater_than', 'less_than', 'is_filled', 'is_empty'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface FieldCondition {
  /** id of an EARLIER field */
  field: string;
  op: ConditionOp;
  /** comparison value; unused for is_filled / is_empty */
  value?: string | number | boolean;
}

export interface FieldLogic {
  match: 'all' | 'any';
  conditions: FieldCondition[];
}

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  required?: boolean;
  options?: string[];
  help?: string;
  /** number: unit label, e.g. "psi" */
  unit?: string;
  /** number: expected range. Out-of-range readings are flagged, never blocked. */
  min?: number;
  max?: number;
  /** photo */
  min_photos?: number;
  max_photos?: number;
  /** pass_fail */
  allow_na?: boolean;
  note_on_fail?: boolean;
  /** show this field only when the logic matches */
  show_if?: FieldLogic;
}

export interface FormTemplate {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  trade?: string | null;
  version: number;
  fields: FormField[];
}

export const SCHEMA_LIMITS = {
  maxFields: 100,
  maxOptions: 30,
  maxConditions: 10,
  maxPhotos: 10,
  defaultMaxPhotos: 10,
  labelLength: 200,
  helpLength: 500,
  optionLength: 100,
  unitLength: 20,
  idLength: 40,
} as const;

export const FIELD_ID_PATTERN = /^[a-z0-9_]{1,40}$/;

/** Field types whose answers are blobs captured on the device; they cannot drive conditions. */
export function isAttachmentType(type: FieldType): boolean {
  return type === 'photo' || type === 'signature';
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function normalizeCondition(raw: unknown): FieldCondition | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.field !== 'string' || !CONDITION_OPS.includes(c.op as ConditionOp)) return null;
  const out: FieldCondition = { field: c.field, op: c.op as ConditionOp };
  if (typeof c.value === 'string' || typeof c.value === 'number' || typeof c.value === 'boolean') out.value = c.value;
  return out;
}

function normalizeLogic(raw: unknown): FieldLogic | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const l = raw as Record<string, unknown>;
  if (!Array.isArray(l.conditions)) return undefined;
  const conditions = l.conditions
    .map(normalizeCondition)
    .filter((c): c is FieldCondition => c !== null)
    .slice(0, SCHEMA_LIMITS.maxConditions);
  if (conditions.length === 0) return undefined;
  return { match: l.match === 'any' ? 'any' : 'all', conditions };
}

/**
 * Server data is untrusted until normalized. Returns null for a field the device cannot render
 * safely (unknown type, no id, select without options) so one bad field never breaks a form.
 */
export function normalizeField(raw: unknown): FormField | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== 'string' || typeof f.label !== 'string' || !FIELD_TYPES.includes(f.type as FieldType)) return null;
  const type = f.type as FieldType;

  const options = Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === 'string') : undefined;
  if (type === 'select' && (!options || options.length === 0)) return null;

  const field: FormField = {
    id: f.id,
    type,
    label: f.label,
    required: f.required === true,
    options,
    help: typeof f.help === 'string' ? f.help : undefined,
  };

  if (type === 'number') {
    const min = finiteNumber(f.min);
    const max = finiteNumber(f.max);
    if (min !== undefined) field.min = min;
    if (max !== undefined) field.max = max;
    if (typeof f.unit === 'string' && f.unit.trim()) field.unit = f.unit.trim().slice(0, SCHEMA_LIMITS.unitLength);
  }

  if (type === 'photo') {
    const min = finiteNumber(f.min_photos);
    const max = finiteNumber(f.max_photos);
    if (min !== undefined) field.min_photos = Math.max(0, Math.min(SCHEMA_LIMITS.maxPhotos, Math.floor(min)));
    if (max !== undefined) field.max_photos = Math.max(1, Math.min(SCHEMA_LIMITS.maxPhotos, Math.floor(max)));
  }

  if (type === 'pass_fail') {
    if (f.allow_na === true) field.allow_na = true;
    if (f.note_on_fail === true) field.note_on_fail = true;
  }

  const show_if = normalizeLogic(f.show_if);
  if (show_if) field.show_if = show_if;

  return field;
}

export function normalizeTemplates(raw: unknown): FormTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: FormTemplate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const schema = (t.schema ?? {}) as { fields?: unknown };
    const fields = (Array.isArray(schema.fields) ? schema.fields : [])
      .map(normalizeField)
      .filter((f): f is FormField => f !== null);
    if (typeof t.id !== 'string' || typeof t.slug !== 'string' || typeof t.title !== 'string' || fields.length === 0) continue;
    out.push({
      id: t.id,
      slug: t.slug,
      title: t.title,
      description: typeof t.description === 'string' ? t.description : null,
      trade: typeof t.trade === 'string' ? t.trade : null,
      version: typeof t.version === 'number' ? t.version : 1,
      fields,
    });
  }
  return out;
}
