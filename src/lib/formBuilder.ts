import { supabase } from '@/lib/supabase';
import {
  FIELD_ID_PATTERN,
  SCHEMA_LIMITS,
  isAttachmentType,
  normalizeField,
} from '@/lib/offline/formSchema';
import type { ConditionOp, FieldCondition, FieldLogic, FieldType, FormField, FormTemplate } from '@/lib/offline/formSchema';

// ============================================================
// Model
// ============================================================

export const TRADES = [
  { value: '', label: 'Any trade' },
  { value: 'general', label: 'General' },
  { value: 'hvac', label: 'HVAC' },
  { value: 'plumbing', label: 'Plumbing' },
  { value: 'electrical', label: 'Electrical' },
] as const;

/** Editor-side field: numeric props stay strings while typing, options are one-per-line text. */
export interface BuilderField {
  key: string;
  id: string;
  type: FieldType;
  label: string;
  required: boolean;
  help: string;
  optionsText: string;
  unit: string;
  min: string;
  max: string;
  minPhotos: string;
  maxPhotos: string;
  allowNa: boolean;
  noteOnFail: boolean;
  showIf: FieldLogic | null;
}

export interface BuilderState {
  title: string;
  description: string;
  trade: string;
  fields: BuilderField[];
}

export interface PaletteItem {
  type: FieldType;
  label: string;
  hint: string;
  defaultLabel: string;
}

export const PALETTE: PaletteItem[] = [
  { type: 'pass_fail', label: 'Pass / Fail', hint: 'Inspection item with optional N/A and failure note', defaultLabel: 'Inspection item' },
  { type: 'number', label: 'Number', hint: 'Reading with unit and expected range', defaultLabel: 'Reading' },
  { type: 'photo', label: 'Photo', hint: 'Camera capture, works offline', defaultLabel: 'Photo' },
  { type: 'signature', label: 'Signature', hint: 'Drawn or typed sign-off', defaultLabel: 'Customer signature' },
  { type: 'yes_no', label: 'Yes / No', hint: 'Simple two-way question', defaultLabel: 'Question' },
  { type: 'checkbox', label: 'Checkbox', hint: 'A step the technician confirms', defaultLabel: 'Step completed' },
  { type: 'select', label: 'Dropdown', hint: 'Pick one from a list', defaultLabel: 'Choose one' },
  { type: 'text', label: 'Short text', hint: 'One line answer', defaultLabel: 'Short answer' },
  { type: 'textarea', label: 'Long text', hint: 'Notes and findings', defaultLabel: 'Notes' },
];

export const FIELD_TYPE_LABEL: Record<FieldType, string> = Object.fromEntries(
  PALETTE.map((p) => [p.type, p.label])
) as Record<FieldType, string>;

let keyCounter = 0;
export function newKey(): string {
  keyCounter += 1;
  return `f${Date.now().toString(36)}${keyCounter}`;
}

export function emptyBuilderState(): BuilderState {
  return { title: '', description: '', trade: '', fields: [] };
}

// ============================================================
// Slugs & ids
// ============================================================

export function slugify(text: string, taken: Set<string>, maxLength: number, fallback: string): string {
  let base = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength)
    .replace(/_+$/g, '');
  if (!base) base = fallback;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, maxLength - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, maxLength - 8)}_${Date.now().toString(36).slice(-6)}`;
}

export function uniqueFieldId(label: string, fields: BuilderField[]): string {
  return slugify(label, new Set(fields.map((f) => f.id)), SCHEMA_LIMITS.idLength, 'field');
}

export function uniqueTemplateSlug(title: string, takenSlugs: Set<string>): string {
  const slug = slugify(title, takenSlugs, 60, 'form');
  return slug.length >= 2 ? slug : `${slug}_form`;
}

// ============================================================
// Editing operations (all pure — they return new arrays)
// ============================================================

export function createField(type: FieldType, fields: BuilderField[]): BuilderField {
  const item = PALETTE.find((p) => p.type === type) ?? PALETTE[PALETTE.length - 1];
  return {
    key: newKey(),
    id: uniqueFieldId(item.defaultLabel, fields),
    type,
    label: item.defaultLabel,
    required: false,
    help: '',
    optionsText: type === 'select' ? 'Option 1\nOption 2' : '',
    unit: '',
    min: '',
    max: '',
    minPhotos: '',
    maxPhotos: '',
    allowNa: false,
    noteOnFail: type === 'pass_fail',
    showIf: null,
  };
}

export function insertField(fields: BuilderField[], field: BuilderField, index: number): BuilderField[] {
  const at = Math.max(0, Math.min(index, fields.length));
  return [...fields.slice(0, at), field, ...fields.slice(at)];
}

/** Moves a field into the gap `gapIndex` of the CURRENT list (0..length), as a drop indicator does. */
export function moveFieldToGap(fields: BuilderField[], key: string, gapIndex: number): BuilderField[] {
  const from = fields.findIndex((f) => f.key === key);
  if (from === -1) return fields;
  const target = gapIndex > from ? gapIndex - 1 : gapIndex;
  if (target === from) return fields;
  const next = [...fields];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(target, next.length)), 0, item);
  return next;
}

export function moveFieldBy(fields: BuilderField[], key: string, delta: -1 | 1): BuilderField[] {
  const from = fields.findIndex((f) => f.key === key);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= fields.length) return fields;
  const next = [...fields];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function duplicateField(fields: BuilderField[], key: string): BuilderField[] {
  const idx = fields.findIndex((f) => f.key === key);
  if (idx === -1) return fields;
  const src = fields[idx];
  const copy: BuilderField = {
    ...src,
    key: newKey(),
    id: uniqueFieldId(`${src.id}_copy`, fields),
    label: `${src.label} (copy)`.slice(0, SCHEMA_LIMITS.labelLength),
    showIf: src.showIf ? { ...src.showIf, conditions: src.showIf.conditions.map((c) => ({ ...c })) } : null,
  };
  return insertField(fields, copy, idx + 1);
}

/** Removes a field and strips every condition that referenced it. */
export function removeField(fields: BuilderField[], key: string): { fields: BuilderField[]; affected: number } {
  const target = fields.find((f) => f.key === key);
  if (!target) return { fields, affected: 0 };
  let affected = 0;
  const next = fields
    .filter((f) => f.key !== key)
    .map((f) => {
      if (!f.showIf) return f;
      const conditions = f.showIf.conditions.filter((c) => c.field !== target.id);
      if (conditions.length === f.showIf.conditions.length) return f;
      affected += 1;
      return { ...f, showIf: conditions.length > 0 ? { ...f.showIf, conditions } : null };
    });
  return { fields: next, affected };
}

export function dependentsOf(fields: BuilderField[], key: string): number {
  const target = fields.find((f) => f.key === key);
  if (!target) return 0;
  return fields.filter((f) => f.showIf?.conditions.some((c) => c.field === target.id)).length;
}

/** Changes a field's id and keeps every condition that pointed at the old id intact. */
export function renameFieldId(fields: BuilderField[], key: string, newId: string): BuilderField[] {
  const target = fields.find((f) => f.key === key);
  if (!target || target.id === newId) return fields;
  const oldId = target.id;
  return fields.map((f) => {
    if (f.key === key) return { ...f, id: newId };
    if (!f.showIf) return f;
    return {
      ...f,
      showIf: { ...f.showIf, conditions: f.showIf.conditions.map((c) => (c.field === oldId ? { ...c, field: newId } : c)) },
    };
  });
}

// ============================================================
// Conditional logic helpers
// ============================================================

export function eligibleSources(fields: BuilderField[], key: string): BuilderField[] {
  const idx = fields.findIndex((f) => f.key === key);
  if (idx <= 0) return [];
  return fields.slice(0, idx).filter((f) => !isAttachmentType(f.type));
}

export function operatorsFor(type: FieldType): Array<{ op: ConditionOp; label: string }> {
  const equals = { op: 'equals' as const, label: 'is' };
  const notEquals = { op: 'not_equals' as const, label: 'is not' };
  const filled = { op: 'is_filled' as const, label: 'is answered' };
  const empty = { op: 'is_empty' as const, label: 'is empty' };
  switch (type) {
    case 'number':
      return [equals, notEquals, { op: 'greater_than', label: 'is greater than' }, { op: 'less_than', label: 'is less than' }, filled, empty];
    case 'checkbox':
      return [equals];
    case 'yes_no':
    case 'pass_fail':
      return [equals, notEquals, filled];
    default:
      return [equals, notEquals, filled, empty];
  }
}

export function valueChoices(source: BuilderField): Array<{ value: string; label: string }> | null {
  switch (source.type) {
    case 'yes_no':
      return [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
    case 'pass_fail':
      return [
        { value: 'pass', label: 'Pass' },
        { value: 'fail', label: 'Fail' },
        ...(source.allowNa ? [{ value: 'na', label: 'N/A' }] : []),
      ];
    case 'checkbox':
      return [{ value: 'true', label: 'Checked' }, { value: 'false', label: 'Unchecked' }];
    case 'select':
      return parseOptions(source.optionsText).map((o) => ({ value: o, label: o }));
    default:
      return null;
  }
}

export function defaultCondition(source: BuilderField): FieldCondition {
  const choices = valueChoices(source);
  const first = choices?.find((c) => (source.type === 'pass_fail' ? c.value === 'fail' : true))?.value;
  if (source.type === 'checkbox') return { field: source.id, op: 'equals', value: true };
  return { field: source.id, op: 'equals', value: first ?? '' };
}

export function parseOptions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// ============================================================
// Lint
// ============================================================

export interface LintResult {
  form: string[];
  fields: Record<string, string[]>;
  /** total number of problems */
  count: number;
}

function parseOptionalNumber(text: string): number | null | 'invalid' {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : 'invalid';
}

export function lintBuilder(state: BuilderState): LintResult {
  const form: string[] = [];
  const fields: Record<string, string[]> = {};
  const add = (key: string, msg: string) => {
    (fields[key] ??= []).push(msg);
  };

  const title = state.title.trim();
  if (title.length < 2) form.push('Give the form a name (at least 2 characters).');
  else if (title.length > 120) form.push('The form name must be 120 characters or fewer.');
  if (state.description.length > 500) form.push('The description must be 500 characters or fewer.');
  if (state.fields.length === 0) form.push('Add at least one field.');
  if (state.fields.length > SCHEMA_LIMITS.maxFields) form.push(`A form can have at most ${SCHEMA_LIMITS.maxFields} fields.`);

  const seenIds = new Map<string, number>();
  state.fields.forEach((f) => seenIds.set(f.id, (seenIds.get(f.id) ?? 0) + 1));
  const earlier = new Map<string, BuilderField>();

  state.fields.forEach((f) => {
    const label = f.label.trim();
    if (!label) add(f.key, 'Add a label.');
    else if (label.length > SCHEMA_LIMITS.labelLength) add(f.key, `The label must be ${SCHEMA_LIMITS.labelLength} characters or fewer.`);
    if (!FIELD_ID_PATTERN.test(f.id)) add(f.key, 'The field id may only use a–z, 0–9 and _ (max 40).');
    else if ((seenIds.get(f.id) ?? 0) > 1) add(f.key, `Another field already uses the id "${f.id}".`);
    if (f.help.length > SCHEMA_LIMITS.helpLength) add(f.key, `Help text must be ${SCHEMA_LIMITS.helpLength} characters or fewer.`);

    if (f.type === 'select') {
      const options = parseOptions(f.optionsText);
      if (options.length === 0) add(f.key, 'Add at least one option.');
      if (options.length > SCHEMA_LIMITS.maxOptions) add(f.key, `Use at most ${SCHEMA_LIMITS.maxOptions} options.`);
      if (options.some((o) => o.length > SCHEMA_LIMITS.optionLength)) add(f.key, `Options must be ${SCHEMA_LIMITS.optionLength} characters or fewer.`);
    }

    if (f.type === 'number') {
      const min = parseOptionalNumber(f.min);
      const max = parseOptionalNumber(f.max);
      if (min === 'invalid') add(f.key, 'The minimum must be a number.');
      if (max === 'invalid') add(f.key, 'The maximum must be a number.');
      if (typeof min === 'number' && typeof max === 'number' && min > max) add(f.key, 'The minimum is greater than the maximum.');
      if (f.unit.trim().length > SCHEMA_LIMITS.unitLength) add(f.key, `The unit must be ${SCHEMA_LIMITS.unitLength} characters or fewer.`);
    }

    if (f.type === 'photo') {
      const min = parseOptionalNumber(f.minPhotos);
      const max = parseOptionalNumber(f.maxPhotos);
      const intOk = (n: number | null | 'invalid') => n === null || (typeof n === 'number' && Number.isInteger(n));
      if (!intOk(min) || (typeof min === 'number' && min < 0)) add(f.key, 'Minimum photos must be a whole number, 0 or more.');
      if (!intOk(max) || (typeof max === 'number' && (max < 1 || max > SCHEMA_LIMITS.maxPhotos))) {
        add(f.key, `Maximum photos must be a whole number from 1 to ${SCHEMA_LIMITS.maxPhotos}.`);
      }
      if (typeof min === 'number' && typeof max === 'number' && min > max) add(f.key, 'Minimum photos is greater than maximum.');
    }

    if (f.showIf) {
      if (f.showIf.conditions.length === 0) add(f.key, 'Add a condition or turn conditional display off.');
      for (const c of f.showIf.conditions) {
        const src = earlier.get(c.field);
        if (!src) {
          add(f.key, 'A condition depends on a field that is missing or placed after this one.');
          continue;
        }
        if (isAttachmentType(src.type)) add(f.key, 'A condition cannot depend on a photo or signature.');
        const needsValue = c.op === 'equals' || c.op === 'not_equals' || c.op === 'greater_than' || c.op === 'less_than';
        if (needsValue && (c.value === undefined || String(c.value).trim() === '')) {
          add(f.key, `Pick a value for the condition on "${src.label.trim() || src.id}".`);
        }
        if ((c.op === 'greater_than' || c.op === 'less_than') && !Number.isFinite(Number(c.value))) {
          add(f.key, 'Number conditions need a numeric value.');
        }
      }
    }

    earlier.set(f.id, f);
  });

  const count = form.length + Object.values(fields).reduce((n, list) => n + list.length, 0);
  return { form, fields, count };
}

// ============================================================
// Conversion
// ============================================================

function numberOrUndefined(text: string): number | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function conditionValueFor(source: BuilderField | undefined, c: FieldCondition): FieldCondition {
  if (c.op === 'is_filled' || c.op === 'is_empty') return { field: c.field, op: c.op };
  let value = c.value;
  if (source?.type === 'checkbox') value = value === true || value === 'true';
  else if (source?.type === 'number' && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value))) value = Number(value);
  else if (typeof value === 'string') value = value.trim();
  return { field: c.field, op: c.op, ...(value !== undefined ? { value } : {}) };
}

export function toSchemaFields(state: BuilderState): FormField[] {
  const byId = new Map(state.fields.map((f) => [f.id, f]));
  return state.fields.map((f) => {
    const out: FormField = { id: f.id, type: f.type, label: f.label.trim() };
    if (f.required) out.required = true;
    if (f.help.trim()) out.help = f.help.trim();
    if (f.type === 'select') out.options = parseOptions(f.optionsText);
    if (f.type === 'number') {
      const min = numberOrUndefined(f.min);
      const max = numberOrUndefined(f.max);
      if (min !== undefined) out.min = min;
      if (max !== undefined) out.max = max;
      if (f.unit.trim()) out.unit = f.unit.trim();
    }
    if (f.type === 'photo') {
      const min = numberOrUndefined(f.minPhotos);
      const max = numberOrUndefined(f.maxPhotos);
      if (min !== undefined) out.min_photos = min;
      if (max !== undefined) out.max_photos = max;
    }
    if (f.type === 'pass_fail') {
      if (f.allowNa) out.allow_na = true;
      if (f.noteOnFail) out.note_on_fail = true;
    }
    if (f.showIf && f.showIf.conditions.length > 0) {
      out.show_if = {
        match: f.showIf.match,
        conditions: f.showIf.conditions.map((c) => conditionValueFor(byId.get(c.field), c)),
      };
    }
    return out;
  });
}

export function toSchema(state: BuilderState): { fields: FormField[] } {
  return { fields: toSchemaFields(state) };
}

export function fromTemplate(t: Pick<FormTemplate, 'title' | 'description' | 'trade' | 'fields'>): BuilderState {
  return {
    title: t.title,
    description: t.description ?? '',
    trade: t.trade ?? '',
    fields: t.fields.map((f) => ({
      key: newKey(),
      id: f.id,
      type: f.type,
      label: f.label,
      required: f.required === true,
      help: f.help ?? '',
      optionsText: (f.options ?? []).join('\n'),
      unit: f.unit ?? '',
      min: f.min !== undefined ? String(f.min) : '',
      max: f.max !== undefined ? String(f.max) : '',
      minPhotos: f.min_photos !== undefined ? String(f.min_photos) : '',
      maxPhotos: f.max_photos !== undefined ? String(f.max_photos) : '',
      allowNa: f.allow_na === true,
      noteOnFail: f.note_on_fail === true,
      showIf: f.show_if
        ? { match: f.show_if.match, conditions: f.show_if.conditions.map((c) => ({ ...c })) }
        : null,
    })),
  };
}

/** Stable string used to detect unsaved changes. */
export function snapshotOf(state: BuilderState): string {
  return JSON.stringify({
    t: state.title.trim(),
    d: state.description.trim(),
    r: state.trade,
    s: toSchema(state),
  });
}

/** The template exactly as a technician's device would render it (invalid fields are dropped). */
export function stateToTemplate(state: BuilderState, slug: string, version: number): FormTemplate {
  return {
    id: 'preview',
    slug,
    title: state.title.trim() || 'Untitled form',
    description: state.description.trim() || null,
    trade: state.trade || null,
    version,
    fields: toSchemaFields(state)
      .map(normalizeField)
      .filter((f): f is FormField => f !== null),
  };
}

// ============================================================
// Listing / grouping
// ============================================================

export interface ManagedTemplate {
  slug: string;
  id: string;
  title: string;
  description: string | null;
  trade: string | null;
  version: number;
  active: boolean;
  /** true when the row is a built-in default that this account has not customised */
  isSystem: boolean;
  /** true when this account's template replaces a default with the same slug */
  overridesDefault: boolean;
  versions: number;
  updatedAt: string;
  fields: FormField[];
}

export interface RawTemplateRow {
  id: string;
  owner_id: string | null;
  slug: string;
  title: string;
  description: string | null;
  trade: string | null;
  version: number;
  schema: { fields?: unknown } | null;
  is_active: boolean;
  updated_at: string;
}

function parseFields(schema: RawTemplateRow['schema']): FormField[] {
  const raw = schema && Array.isArray(schema.fields) ? schema.fields : [];
  return raw.map(normalizeField).filter((f): f is FormField => f !== null);
}

export function groupManagedTemplates(rows: RawTemplateRow[]): ManagedTemplate[] {
  const bySlug = new Map<string, { own: RawTemplateRow[]; system: RawTemplateRow[] }>();
  for (const row of rows) {
    const entry = bySlug.get(row.slug) ?? { own: [], system: [] };
    (row.owner_id === null ? entry.system : entry.own).push(row);
    bySlug.set(row.slug, entry);
  }
  const out: ManagedTemplate[] = [];
  for (const [slug, { own, system }] of bySlug) {
    const byVersionDesc = (a: RawTemplateRow, b: RawTemplateRow) => b.version - a.version;
    own.sort(byVersionDesc);
    system.sort(byVersionDesc);
    const chosen = own[0] ?? system[0];
    if (!chosen) continue;
    out.push({
      slug,
      id: chosen.id,
      title: chosen.title,
      description: chosen.description,
      trade: chosen.trade,
      version: chosen.version,
      active: chosen.is_active,
      isSystem: own.length === 0,
      overridesDefault: own.length > 0 && system.length > 0,
      versions: own.length > 0 ? own.length : system.length,
      updatedAt: chosen.updated_at,
      fields: parseFields(chosen.schema),
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export type ManagedFilter = 'all' | 'custom' | 'default' | 'archived';

export function filterManaged(list: ManagedTemplate[], search: string, filter: ManagedFilter): ManagedTemplate[] {
  const q = search.trim().toLowerCase();
  return list.filter((t) => {
    if (filter === 'custom' && (t.isSystem || !t.active)) return false;
    if (filter === 'default' && !t.isSystem) return false;
    if (filter === 'archived' && (t.isSystem || t.active)) return false;
    if (!q) return true;
    return (
      t.title.toLowerCase().includes(q) ||
      t.slug.includes(q) ||
      (t.trade?.toLowerCase().includes(q) ?? false) ||
      (t.description?.toLowerCase().includes(q) ?? false)
    );
  });
}

export function featureFlags(fields: FormField[]) {
  return {
    photos: fields.some((f) => f.type === 'photo'),
    signatures: fields.some((f) => f.type === 'signature'),
    logic: fields.some((f) => !!f.show_if),
    passFail: fields.some((f) => f.type === 'pass_fail'),
  };
}

// ============================================================
// Errors
// ============================================================

interface PgLikeError {
  message?: string;
  code?: string;
}

export function describeFormError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof Error && !('code' in err)) return err.message || fallback;
  const e = (err ?? {}) as PgLikeError;
  const msg = e.message ?? '';
  if (e.code === '42501' || msg.includes('not_permitted') || msg.includes('row-level security')) {
    return 'You do not have permission to manage forms. Ask your account owner for the "Edit Business Profile" permission.';
  }
  if (e.code === '23505') return 'Someone published this form at the same moment. Reload the page and try again.';
  const invalid = /invalid_schema:\s*(.+)$/.exec(msg);
  if (invalid) return `The form could not be saved: ${invalid[1]}.`;
  if (msg.includes('invalid_title')) return 'The form name must be between 2 and 120 characters.';
  if (msg.includes('invalid_slug')) return 'The form identifier is not valid. Rename the form and try again.';
  if (msg.includes('invalid_description')) return 'The description must be 500 characters or fewer.';
  if (msg.includes('invalid_trade')) return 'Choose one of the listed trades.';
  if (msg.includes('template_not_found')) return 'That form no longer exists. Reload the page.';
  if (msg.includes('not_authenticated')) return 'Your session expired. Sign in again to continue.';
  return msg || fallback;
}

// ============================================================
// Supabase API
// ============================================================

/** All templates visible to the account: its own plus the built-in defaults. */
export async function fetchManagedTemplates(accountOwnerId: string): Promise<ManagedTemplate[]> {
  const { data, error } = await supabase
    .from('field_form_templates')
    .select('id, owner_id, slug, title, description, trade, version, schema, is_active, updated_at')
    .or(`owner_id.is.null,owner_id.eq.${accountOwnerId}`)
    .order('version', { ascending: false });
  if (error) throw error;
  return groupManagedTemplates((data ?? []) as unknown as RawTemplateRow[]);
}

export interface SaveTemplateInput {
  slug: string;
  state: BuilderState;
}

/** Publishing always creates a new immutable version; returns the version that is now live. */
export async function publishTemplate({ slug, state }: SaveTemplateInput): Promise<{ id: string; slug: string; version: number }> {
  const issues = lintBuilder(state);
  if (issues.count > 0) throw new Error('Fix the highlighted problems before publishing.');
  const { data, error } = await supabase.rpc('save_field_form_template', {
    p_slug: slug,
    p_title: state.title.trim(),
    p_description: state.description.trim() || null,
    p_trade: state.trade || null,
    p_schema: toSchema(state),
  });
  if (error) throw error;
  return data as { id: string; slug: string; version: number };
}

export async function setTemplateActive(slug: string, active: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_field_form_active', { p_slug: slug, p_active: active });
  if (error) throw error;
}

export async function deleteTemplate(slug: string): Promise<void> {
  const { error } = await supabase.rpc('delete_field_form_template', { p_slug: slug });
  if (error) throw error;
}
