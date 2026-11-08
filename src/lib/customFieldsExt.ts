/**
 * Custom Fields — Phase 2 extension (pure logic; no I/O, no React).
 *
 * Mirrors supabase/migrations/20281111000000_custom_fields_expansion.sql so the UI can explain a refusal
 * before saving. The database stays the source of truth. The original `customFields.ts` (5 types,
 * 3 entities) is untouched: everything new lives here so existing screens keep compiling.
 */

export const LEGACY_FIELD_TYPES = ['text', 'number', 'select', 'date', 'boolean'] as const;
export const EXT_FIELD_TYPES = [...LEGACY_FIELD_TYPES, 'multi_select', 'currency', 'file', 'lookup', 'formula'] as const;
export type ExtFieldType = (typeof EXT_FIELD_TYPES)[number];

export const EXT_ENTITIES = ['customer', 'lead', 'job', 'estimate', 'invoice', 'equipment', 'location', 'technician', 'vendor'] as const;
export type ExtEntity = (typeof EXT_ENTITIES)[number];

/** Mirror of custom_table_for_entity() / custom_owner_column_for_entity(). */
export const EXT_ENTITY_META: Record<ExtEntity, { table: string; ownerColumn: 'user_id' | 'account_owner_id' }> = {
  customer: { table: 'customers', ownerColumn: 'user_id' },
  lead: { table: 'leads', ownerColumn: 'user_id' },
  job: { table: 'jobs', ownerColumn: 'user_id' },
  estimate: { table: 'quotes', ownerColumn: 'user_id' },
  invoice: { table: 'invoices', ownerColumn: 'user_id' },
  equipment: { table: 'equipment', ownerColumn: 'user_id' },
  location: { table: 'business_locations', ownerColumn: 'user_id' },
  technician: { table: 'team_members', ownerColumn: 'account_owner_id' },
  vendor: { table: 'vendors', ownerColumn: 'user_id' },
};

export const FIELD_ROLES = ['owner', 'admin', 'member', 'technician'] as const;
export type FieldRole = (typeof FIELD_ROLES)[number];

export const MAX_MULTI_SELECT = 50;
export const MAX_FILE_PATH = 500;
export const MAX_CURRENCY = 1e12;
export const MAX_FORMULA_DEPTH = 8;
export const MAX_FORMULA_RESULT = 1e15;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

// ============================================================
// FORMULAS — JSON AST (the same shape the database evaluates)
// ============================================================

export type FormulaNode =
  | { c: number }
  | { f: string }
  | { op: 'add' | 'sub' | 'mul' | 'div'; a: FormulaNode; b: FormulaNode };

export type FormulaParse = { ok: true; ast: FormulaNode; refs: string[] } | { ok: false; error: 'empty' | 'syntax' | 'unknownField' | 'tooDeep' | 'tooLong'; detail?: string };

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: '+' | '-' | '*' | '/' } | { t: 'lp' } | { t: 'rp' };

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') { out.push({ t: 'lp' }); i++; continue; }
    if (ch === ')') { out.push({ t: 'rp' }); i++; continue; }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') { out.push({ t: 'op', v: ch }); i++; continue; }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[a-z][a-z0-9_]{0,39}/.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    return null;
  }
  return out;
}

/**
 * Parses `price * qty + 5` style expressions (+ − × ÷, parentheses, numbers, field keys) into the AST.
 * `numericKeys` is the set of number/currency fields the formula may reference.
 */
export function parseFormula(source: string, numericKeys: ReadonlySet<string>): FormulaParse {
  if (source.length > 300) return { ok: false, error: 'tooLong' };
  if (!source.trim()) return { ok: false, error: 'empty' };
  const parsed = tokenize(source);
  if (!parsed) return { ok: false, error: 'syntax' };
  const toks: Tok[] = parsed;
  let pos = 0;
  const refs = new Set<string>();
  let failure: FormulaParse | null = null;
  const fail = (error: 'syntax' | 'unknownField' | 'tooDeep', detail?: string): null => {
    failure ??= { ok: false, error, ...(detail ? { detail } : {}) };
    return null;
  };

  const depthOf = (n: FormulaNode): number => ('op' in n ? 1 + Math.max(depthOf(n.a), depthOf(n.b)) : 0);

  const primary = (): FormulaNode | null => {
    const tok = toks[pos];
    if (!tok) return fail('syntax');
    if (tok.t === 'num') { pos++; return { c: tok.v }; }
    if (tok.t === 'id') {
      pos++;
      if (!numericKeys.has(tok.v)) return fail('unknownField', tok.v);
      refs.add(tok.v);
      return { f: tok.v };
    }
    if (tok.t === 'op' && tok.v === '-') {
      pos++;
      const inner = primary();
      return inner ? { op: 'sub', a: { c: 0 }, b: inner } : null;
    }
    if (tok.t === 'lp') {
      pos++;
      const inner = expr();
      if (!inner) return null;
      if (toks[pos]?.t !== 'rp') return fail('syntax');
      pos++;
      return inner;
    }
    return fail('syntax');
  };
  const term = (): FormulaNode | null => {
    let left = primary();
    while (left) {
      const t = toks[pos];
      if (t?.t === 'op' && (t.v === '*' || t.v === '/')) {
        pos++;
        const right = primary();
        if (!right) return null;
        left = { op: t.v === '*' ? 'mul' : 'div', a: left, b: right };
      } else break;
    }
    return left;
  };
  function expr(): FormulaNode | null {
    let left = term();
    while (left) {
      const t = toks[pos];
      if (t?.t === 'op' && (t.v === '+' || t.v === '-')) {
        pos++;
        const right = term();
        if (!right) return null;
        left = { op: t.v === '+' ? 'add' : 'sub', a: left, b: right };
      } else break;
    }
    return left;
  }

  const ast = expr();
  if (!ast || pos !== toks.length) return failure ?? { ok: false, error: 'syntax' };
  if (depthOf(ast) > MAX_FORMULA_DEPTH) return { ok: false, error: 'tooDeep' };
  return { ok: true, ast, refs: [...refs].sort() };
}

/** Mirror of custom_formula_eval(): null on missing / non-numeric input, division by zero or depth overflow. */
export function evalFormula(node: FormulaNode, data: Record<string, unknown>, depth = 0): number | null {
  if (depth > MAX_FORMULA_DEPTH) return null;
  if ('c' in node) return Number.isFinite(node.c) ? node.c : null;
  if ('f' in node) {
    const v = data[node.f];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  const a = evalFormula(node.a, data, depth + 1);
  const b = evalFormula(node.b, data, depth + 1);
  if (a === null || b === null) return null;
  switch (node.op) {
    case 'add': return a + b;
    case 'sub': return a - b;
    case 'mul': return a * b;
    case 'div': return b === 0 ? null : a / b;
  }
}

/** Value the database would store for a formula (6 decimals), or null when it would drop the key. */
export function computeFormula(node: FormulaNode, data: Record<string, unknown>): number | null {
  const v = evalFormula(node, data);
  if (v === null || !Number.isFinite(v) || Math.abs(v) > MAX_FORMULA_RESULT) return null;
  return Math.round(v * 1e6) / 1e6;
}

// ============================================================
// DEFINITIONS (extended view) + VALUE VALIDATION
// ============================================================

export interface VisibleWhen {
  key: string;
  op: 'eq' | 'neq' | 'in' | 'set';
  value?: unknown;
}

export interface ExtFieldConfig {
  currency?: string;
  lookup_entity?: ExtEntity;
  formula?: FormulaNode;
  visible_when?: VisibleWhen;
}

export interface ExtFieldDef {
  key: string;
  label: string;
  field_type: ExtFieldType;
  options: string[];
  required: boolean;
  required_stages: string[];
  read_roles: FieldRole[] | null;
  write_roles: FieldRole[] | null;
  config: ExtFieldConfig;
  archived_at: string | null;
}

export type ExtValueError = 'invalid' | 'notAnOption' | 'tooMany' | 'duplicate' | 'tooPrecise' | 'outOfRange' | 'badPath' | 'badId' | 'computed';
export type ExtValueResult = { ok: true; value: unknown } | { ok: false; error: ExtValueError };

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/**
 * Validates + coerces a value of a NEW type. Legacy types stay with customFields.validateValue().
 * Lookup existence is checked by the database (it needs data); here only the shape is.
 */
export function validateExtValue(def: Pick<ExtFieldDef, 'field_type' | 'options'>, raw: unknown): ExtValueResult {
  if (isBlank(raw)) return { ok: true, value: null };
  switch (def.field_type) {
    case 'multi_select': {
      if (!Array.isArray(raw)) return { ok: false, error: 'invalid' };
      if (raw.length > MAX_MULTI_SELECT) return { ok: false, error: 'tooMany' };
      const items = raw.map(String);
      if (new Set(items).size !== items.length) return { ok: false, error: 'duplicate' };
      if (items.some((i) => !def.options.includes(i))) return { ok: false, error: 'notAnOption' };
      return { ok: true, value: items };
    }
    case 'currency': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/,/g, ''));
      if (!Number.isFinite(n)) return { ok: false, error: 'invalid' };
      if (Math.abs(n) > MAX_CURRENCY) return { ok: false, error: 'outOfRange' };
      if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return { ok: false, error: 'tooPrecise' };
      return { ok: true, value: Math.round(n * 100) / 100 };
    }
    case 'file': {
      const s = String(raw);
      // eslint-disable-next-line no-control-regex
      if (s.length < 1 || s.length > MAX_FILE_PATH || /(^\/|\.\.|\\|[\u0000-\u001f\u007f])/.test(s)) return { ok: false, error: 'badPath' };
      return { ok: true, value: s };
    }
    case 'lookup': {
      const s = String(raw).toLowerCase();
      return UUID.test(s) ? { ok: true, value: s } : { ok: false, error: 'badId' };
    }
    case 'formula':
      return { ok: false, error: 'computed' };
    default:
      return { ok: false, error: 'invalid' };
  }
}

// ============================================================
// VISIBILITY, REQUIRED-BY-STAGE, PERMISSIONS
// ============================================================

/** UI rule: shows the field unless its `visible_when` condition fails. */
export function isFieldVisible(def: Pick<ExtFieldDef, 'config'>, data: Record<string, unknown>): boolean {
  const rule = def.config.visible_when;
  if (!rule) return true;
  const v = data[rule.key];
  switch (rule.op) {
    case 'set': return !isBlank(v);
    case 'eq': return v !== undefined && JSON.stringify(v) === JSON.stringify(rule.value);
    case 'neq': return v === undefined || JSON.stringify(v) !== JSON.stringify(rule.value);
    case 'in': return Array.isArray(rule.value) && rule.value.some((x) => JSON.stringify(x) === JSON.stringify(v));
  }
}

/** Keys that must be filled before a job may enter `canonicalStatus` (mirror of job_stage_required_fields). */
export function requiredAtStage(defs: readonly ExtFieldDef[], canonicalStatus: string): string[] {
  return defs
    .filter((d) => d.archived_at === null && d.field_type !== 'formula' && d.required_stages.includes(canonicalStatus))
    .map((d) => d.key)
    .sort();
}

/** Mirror of custom_value_is_blank(). */
export const isBlankValue = isBlank;

export function missingForStage(defs: readonly ExtFieldDef[], canonicalStatus: string, extraKeys: readonly string[], data: Record<string, unknown>): string[] {
  const keys = [...new Set([...extraKeys, ...requiredAtStage(defs, canonicalStatus)])];
  return keys.filter((k) => isBlank(data[k])).sort();
}

/** null roles = everyone. Owners always pass. */
export function canWriteField(def: Pick<ExtFieldDef, 'write_roles' | 'field_type'>, role: FieldRole): boolean {
  if (def.field_type === 'formula') return false;
  return role === 'owner' || def.write_roles === null || def.write_roles.includes(role);
}
export function canReadField(def: Pick<ExtFieldDef, 'read_roles'>, role: FieldRole): boolean {
  return role === 'owner' || def.read_roles === null || def.read_roles.includes(role);
}

/** Removes values the role may not see. UI/API-layer convenience: NOT a database security boundary. */
export function maskCustomData(defs: readonly ExtFieldDef[], data: Record<string, unknown>, role: FieldRole): Record<string, unknown> {
  const denied = new Set(defs.filter((d) => !canReadField(d, role)).map((d) => d.key));
  return Object.fromEntries(Object.entries(data).filter(([k]) => !denied.has(k)));
}

// ============================================================
// IMPORT / EXPORT MAPPING
// ============================================================

export interface ImportOutcome {
  data: Record<string, unknown>;
  errors: { key: string; error: ExtValueError | 'invalidDate' | 'invalidBoolean' | 'invalidNumber' | 'notAnOption' }[];
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Real calendar date check (rejects 2026-02-30); mirrors the database's `::date` cast. */
function isValidYmd(s: string): boolean {
  if (!YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Maps one CSV row (header → string) to a custom_data payload using `mapping` (csv header → field key). */
export function mapCsvRowToCustomData(defs: readonly ExtFieldDef[], row: Record<string, string>, mapping: Record<string, string>): ImportOutcome {
  const byKey = new Map(defs.filter((d) => d.archived_at === null).map((d) => [d.key, d]));
  const out: ImportOutcome = { data: {}, errors: [] };
  for (const [header, key] of Object.entries(mapping)) {
    const def = byKey.get(key);
    const raw = (row[header] ?? '').trim();
    if (!def || def.field_type === 'formula' || raw === '') continue;
    const fail = (error: ImportOutcome['errors'][number]['error']) => { out.errors.push({ key, error }); };
    switch (def.field_type) {
      case 'text': out.data[key] = raw.slice(0, 500); break;
      case 'number': {
        const n = Number(raw.replace(/,/g, ''));
        if (Number.isFinite(n)) out.data[key] = n; else fail('invalidNumber');
        break;
      }
      case 'boolean': {
        const v = raw.toLowerCase();
        if (['true', 'yes', 'y', '1'].includes(v)) out.data[key] = true;
        else if (['false', 'no', 'n', '0'].includes(v)) out.data[key] = false;
        else fail('invalidBoolean');
        break;
      }
      case 'date': if (isValidYmd(raw)) out.data[key] = raw; else fail('invalidDate'); break;
      case 'select': {
        const hit = def.options.find((o) => o.toLowerCase() === raw.toLowerCase());
        if (hit) out.data[key] = hit; else fail('notAnOption');
        break;
      }
      case 'multi_select': {
        const parts = [...new Set(raw.split(/[;|]/).map((s) => s.trim()).filter(Boolean))];
        const hits = parts.map((p) => def.options.find((o) => o.toLowerCase() === p.toLowerCase()));
        if (hits.every((h): h is string => !!h)) out.data[key] = hits; else fail('notAnOption');
        break;
      }
      default: {
        const r = validateExtValue(def, raw);
        if (r.ok && r.value !== null) out.data[key] = r.value; else if (!r.ok) fail(r.error);
      }
    }
  }
  return out;
}

/** Flat string for CSV export; arrays are joined with "; ". */
export function customValueToCsv(def: Pick<ExtFieldDef, 'field_type'>, value: unknown): string {
  if (isBlank(value)) return '';
  if (Array.isArray(value)) return value.map(String).join('; ');
  if (def.field_type === 'boolean') return value === true ? 'true' : 'false';
  return String(value);
}

// ============================================================
// FILTER MODEL (mirror of custom_field_filter ops)
// ============================================================

export type FilterOp = 'eq' | 'has' | 'contains' | 'gte' | 'lte';

export function allowedFilterOps(type: ExtFieldType): FilterOp[] {
  switch (type) {
    case 'text': return ['eq', 'contains'];
    case 'select':
    case 'boolean':
    case 'lookup': return ['eq'];
    case 'multi_select': return ['has'];
    case 'number':
    case 'currency':
    case 'formula': return ['eq', 'gte', 'lte'];
    case 'date': return ['eq', 'gte', 'lte'];
    case 'file': return [];
  }
}

export const isNumericType = (t: ExtFieldType) => t === 'number' || t === 'currency' || t === 'formula';
