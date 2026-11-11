// supabase/functions/_shared/import-framework/mapping.ts
//
// Declarative mapping: validation of a stored/user-supplied MappingConfig, and the pure per-record
// mapper. The transform set is CLOSED (no eval, no regex from users, no code) — a mapping is data,
// so it can be stored, diffed, reviewed and replayed. Reuses the existing import normalizers so the
// wizard and this framework agree on what a phone number / money / date means.

import { isValidTimeZone, normalizeEmail, normalizePhone, parseDateTime, parseMoney } from "../data-import/normalize.ts";
import { parseCents, parseDate } from "../data-import/ledger.ts";
import { fingerprintOf } from "./hash.ts";
import type {
  EntityDefinition, EntityDefinitions, EntityMapping, FieldRule, Issue, MappingConfig, RawRow, Scalar, SourceAdapter,
  Transform, Values,
} from "./types.ts";

const OPS = new Set(["trim", "lower", "upper", "collapse_space", "phone_e164", "email", "money", "money_cents", "number", "integer", "boolean", "date", "timestamp", "enum", "truncate"]);
const DEDUPE = new Set(["skip", "fill_blanks", "overwrite"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_CONFIG_CHARS = 200_000;
const MAX_ENTITIES = 20;
const MAX_FIELDS = 100;
const MAX_ENUM = 500;
const MAX_TRANSFORMS = 8;
const MAX_FROM = 5;
const MAX_TEXT = 200;

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const err = (code: string, message: string, field?: string): Issue => ({ severity: "error", code, message, ...(field ? { field } : {}) });

export const mappingHash = (m: MappingConfig): string => fingerprintOf(m);

/** Parents first. Only dependencies that are part of the mapping take part in the ordering. Throws on a cycle. */
export function entityOrder(mapping: MappingConfig, defs: EntityDefinitions): string[] {
  const names = Object.keys(mapping.entities).sort();
  const set = new Set(names);
  const deps = (n: string): string[] => [...new Set([...(defs[n]?.dependsOn ?? []), ...Object.values(defs[n]?.references ?? {}).map((r) => r.entity)])].filter((d) => set.has(d) && d !== n);
  const out: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): void => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) throw new Error(`Dependency cycle at "${n}"`);
    state.set(n, 1);
    for (const d of deps(n).sort()) visit(d);
    state.set(n, 2);
    out.push(n);
  };
  for (const n of names) visit(n);
  return out;
}

// ------------------------------------------------------------------ validation

function validateTransforms(raw: unknown, path: string, issues: Issue[]): Transform[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_TRANSFORMS) { issues.push(err("TRANSFORMS_INVALID", `${path}: transforms must be a list of at most ${MAX_TRANSFORMS}.`)); return undefined; }
  const out: Transform[] = [];
  for (const t of raw) {
    if (!isObj(t) || typeof t.op !== "string" || !OPS.has(t.op)) { issues.push(err("TRANSFORM_UNKNOWN", `${path}: unknown transform.`)); continue; }
    if (t.op === "enum") {
      const allowed = new Set(["op", "map", "fallback"]);
      if (Object.keys(t).some((k) => !allowed.has(k))) issues.push(err("UNKNOWN_KEY", `${path}: enum accepts only map and fallback.`));
      if (!isObj(t.map) || Object.keys(t.map).length === 0 || Object.keys(t.map).length > MAX_ENUM) { issues.push(err("ENUM_INVALID", `${path}: enum needs a map of 1..${MAX_ENUM} entries.`)); continue; }
      const map: Record<string, string> = Object.create(null);
      let bad = false;
      for (const [k, v] of Object.entries(t.map)) {
        if (FORBIDDEN_KEYS.has(k) || typeof v !== "string" || v.length > MAX_TEXT || k.length > MAX_TEXT) bad = true; else map[k] = v;
      }
      if (bad) { issues.push(err("ENUM_INVALID", `${path}: enum map contains an invalid entry.`)); continue; }
      const fb = t.fallback;
      if (fb !== undefined && fb !== null && (typeof fb !== "string" || fb.length > MAX_TEXT)) { issues.push(err("ENUM_INVALID", `${path}: enum fallback must be text or null.`)); continue; }
      out.push({ op: "enum", map: { ...map }, ...(fb !== undefined ? { fallback: fb as string | null } : {}) });
    } else if (t.op === "truncate") {
      if (Object.keys(t).some((k) => k !== "op" && k !== "max")) issues.push(err("UNKNOWN_KEY", `${path}: truncate accepts only max.`));
      if (!Number.isInteger(t.max) || (t.max as number) < 1 || (t.max as number) > 10_000) { issues.push(err("TRUNCATE_INVALID", `${path}: truncate.max must be an integer 1..10000.`)); continue; }
      out.push({ op: "truncate", max: t.max as number });
    } else {
      if (Object.keys(t).length !== 1) issues.push(err("UNKNOWN_KEY", `${path}: ${t.op} takes no parameters.`));
      out.push({ op: t.op } as Transform);
    }
  }
  return out;
}

function validateFrom(raw: unknown, path: string, entity: string, adapter: SourceAdapter | undefined, issues: Issue[]): string[] | null {
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_FROM || list.some((c) => typeof c !== "string" || c.length === 0 || c.length > MAX_TEXT)) {
    issues.push(err("FROM_INVALID", `${path}: "from" must be a column name or 1..${MAX_FROM} column names.`));
    return null;
  }
  if (adapter) {
    const cols = new Set(adapter.columns(entity));
    for (const c of list as string[]) if (!cols.has(c)) issues.push(err("UNKNOWN_SOURCE_COLUMN", `${path}: the source has no column named "${c.slice(0, 60)}".`));
  }
  return list as string[];
}

export interface MappingValidation { ok: boolean; config?: MappingConfig; issues: Issue[] }

/**
 * Validates and NORMALISES (deep-copies, drops nothing silently: unknown keys are errors).
 * `adapter` is optional: with it, entities and source columns are checked against the real snapshot.
 */
export function validateMapping(input: unknown, defs: EntityDefinitions, adapter?: SourceAdapter): MappingValidation {
  const issues: Issue[] = [];
  const fail = (): MappingValidation => ({ ok: false, issues });
  let size = 0;
  try { size = JSON.stringify(input)?.length ?? 0; } catch { issues.push(err("MAPPING_INVALID", "Mapping is not valid JSON data.")); return fail(); }
  if (size > MAX_CONFIG_CHARS) { issues.push(err("MAPPING_TOO_LARGE", "Mapping is too large.")); return fail(); }
  if (!isObj(input)) { issues.push(err("MAPPING_INVALID", "Mapping must be an object.")); return fail(); }
  for (const k of Object.keys(input)) if (!["version", "source", "options", "entities"].includes(k)) issues.push(err("UNKNOWN_KEY", `Unknown top-level key "${k.slice(0, 40)}".`));
  if (input.version !== 1) issues.push(err("VERSION_UNSUPPORTED", "Mapping version must be 1."));
  if (typeof input.source !== "string" || !input.source) issues.push(err("SOURCE_REQUIRED", "Mapping.source (adapter id) is required."));
  else if (adapter && input.source !== adapter.id) issues.push(err("SOURCE_MISMATCH", `Mapping is for source "${input.source.slice(0, 40)}" but the adapter is "${adapter.id}".`));

  // options
  const options: MappingConfig["options"] = {};
  if (input.options !== undefined) {
    if (!isObj(input.options)) issues.push(err("OPTIONS_INVALID", "options must be an object."));
    else {
      const o = input.options;
      for (const k of Object.keys(o)) if (!["dedupe", "timezone", "allowPositionalKeys", "maxErrorRatio"].includes(k)) issues.push(err("UNKNOWN_KEY", `Unknown option "${k.slice(0, 40)}".`));
      if (o.dedupe !== undefined) { if (typeof o.dedupe === "string" && DEDUPE.has(o.dedupe)) options.dedupe = o.dedupe as never; else issues.push(err("OPTIONS_INVALID", "dedupe must be skip, fill_blanks or overwrite.")); }
      if (o.timezone !== undefined) { if (typeof o.timezone === "string" && isValidTimeZone(o.timezone)) options.timezone = o.timezone; else issues.push(err("OPTIONS_INVALID", "timezone is not a valid IANA zone.")); }
      if (o.allowPositionalKeys !== undefined) { if (typeof o.allowPositionalKeys === "boolean") options.allowPositionalKeys = o.allowPositionalKeys; else issues.push(err("OPTIONS_INVALID", "allowPositionalKeys must be true or false.")); }
      if (o.maxErrorRatio !== undefined) { if (typeof o.maxErrorRatio === "number" && o.maxErrorRatio >= 0 && o.maxErrorRatio <= 1) options.maxErrorRatio = o.maxErrorRatio; else issues.push(err("OPTIONS_INVALID", "maxErrorRatio must be a number from 0 to 1.")); }
    }
  }

  // entities
  const entities: Record<string, EntityMapping> = {};
  if (!isObj(input.entities) || Object.keys(input.entities).length === 0 || Object.keys(input.entities).length > MAX_ENTITIES) {
    issues.push(err("ENTITIES_REQUIRED", `entities must map 1..${MAX_ENTITIES} entity names to their mapping.`));
    return fail();
  }
  const sourceEntities = adapter ? new Set(adapter.entities()) : null;
  for (const [name, em] of Object.entries(input.entities)) {
    const path = `entities.${name.slice(0, 40)}`;
    const def: EntityDefinition | undefined = has(defs, name) ? defs[name] : undefined;
    if (!def) { issues.push(err("UNKNOWN_ENTITY", `${path}: Vireek has no importable entity with this name.`)); continue; }
    if (sourceEntities && !sourceEntities.has(name)) { issues.push(err("ENTITY_NOT_IN_SOURCE", `${path}: the source does not provide this entity.`)); continue; }
    if (!isObj(em) || !isObj(em.fields)) { issues.push(err("ENTITY_INVALID", `${path}: needs a "fields" object.`)); continue; }
    for (const k of Object.keys(em)) if (k !== "key" && k !== "fields") issues.push(err("UNKNOWN_KEY", `${path}: unknown key "${k.slice(0, 40)}".`));

    const mapped: EntityMapping = { fields: {} };
    if (em.key !== undefined) {
      if (!isObj(em.key)) issues.push(err("KEY_INVALID", `${path}.key must be an object.`));
      else {
        for (const k of Object.keys(em.key)) if (!["from", "join", "transforms"].includes(k)) issues.push(err("UNKNOWN_KEY", `${path}.key: unknown key "${k.slice(0, 40)}".`));
        const from = validateFrom(em.key.from, `${path}.key`, name, adapter, issues);
        const transforms = validateTransforms(em.key.transforms, `${path}.key`, issues);
        if (em.key.join !== undefined && (typeof em.key.join !== "string" || em.key.join.length > 10)) issues.push(err("JOIN_INVALID", `${path}.key.join must be short text.`));
        if (from) mapped.key = { from: from.length === 1 && typeof em.key.from === "string" ? from[0] : from, ...(typeof em.key.join === "string" ? { join: em.key.join } : {}), ...(transforms ? { transforms } : {}) };
      }
    } else if (!options.allowPositionalKeys) {
      issues.push(err("KEY_REQUIRED", `${path}: no "key" (stable source id). Without one a re-import cannot be idempotent; set options.allowPositionalKeys to accept that.`));
    }

    const fieldNames = Object.keys(em.fields);
    if (fieldNames.length === 0 || fieldNames.length > MAX_FIELDS) issues.push(err("FIELDS_INVALID", `${path}: needs 1..${MAX_FIELDS} fields.`));
    for (const f of fieldNames) {
      const fpath = `${path}.fields.${f.slice(0, 40)}`;
      if (FORBIDDEN_KEYS.has(f) || !(has(def.fields, f) || (def.references && has(def.references, f)))) { issues.push(err("UNKNOWN_TARGET_FIELD", `${fpath}: not an importable field of ${name}.`, f)); continue; }
      const r = (em.fields as Record<string, unknown>)[f];
      if (!isObj(r)) { issues.push(err("FIELD_INVALID", `${fpath}: must be an object.`, f)); continue; }
      for (const k of Object.keys(r)) if (!["from", "value", "join", "transforms", "required", "default"].includes(k)) issues.push(err("UNKNOWN_KEY", `${fpath}: unknown key "${k.slice(0, 40)}".`, f));
      const hasFrom = r.from !== undefined, hasValue = has(r, "value");
      if (hasFrom === hasValue) { issues.push(err("FIELD_SOURCE_INVALID", `${fpath}: use exactly one of "from" or "value".`, f)); continue; }
      const rule: FieldRule = {};
      if (hasFrom) { const from = validateFrom(r.from, fpath, name, adapter, issues); if (!from) continue; rule.from = from.length === 1 && typeof r.from === "string" ? from[0] : from; }
      else { if (!(r.value === null || ["string", "number", "boolean"].includes(typeof r.value))) { issues.push(err("VALUE_INVALID", `${fpath}: constant must be text, number, boolean or null.`, f)); continue; } rule.value = r.value as Scalar; }
      if (r.join !== undefined) { if (typeof r.join === "string" && r.join.length <= 10) rule.join = r.join; else issues.push(err("JOIN_INVALID", `${fpath}: join must be short text.`, f)); }
      const t = validateTransforms(r.transforms, fpath, issues); if (t) rule.transforms = t;
      if (r.required !== undefined) { if (typeof r.required === "boolean") rule.required = r.required; else issues.push(err("FIELD_INVALID", `${fpath}: required must be true or false.`, f)); }
      if (r.default !== undefined) { if (r.default === null || ["string", "number", "boolean"].includes(typeof r.default)) rule.default = r.default as Scalar; else issues.push(err("VALUE_INVALID", `${fpath}: default must be text, number, boolean or null.`, f)); }
      mapped.fields[f] = rule;
    }
    for (const [f, d] of Object.entries(def.fields)) if (d.required && !has(mapped.fields, f)) issues.push(err("REQUIRED_FIELD_UNMAPPED", `${path}: required field "${f}" has no mapping.`, f));
    for (const [f, r] of Object.entries(def.references ?? {})) if (r.required && !has(mapped.fields, f)) issues.push(err("REQUIRED_FIELD_UNMAPPED", `${path}: required reference "${f}" has no mapping.`, f));
    entities[name] = mapped;
  }

  const config: MappingConfig = { version: 1, source: String(input.source ?? ""), ...(Object.keys(options).length ? { options } : {}), entities };
  if (!issues.some((i) => i.severity === "error")) {
    try { entityOrder(config, defs); } catch (e) { issues.push(err("DEPENDENCY_CYCLE", (e as Error).message)); }
  }
  const ok = !issues.some((i) => i.severity === "error");
  return ok ? { ok, config, issues } : { ok, issues };
}

// ------------------------------------------------------------------ record mapping

const TRUE = new Set(["true", "yes", "y", "1", "t"]);
const FALSE = new Set(["false", "no", "n", "0", "f"]);
const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

interface Step { value: Scalar; issue?: Issue }

function applyTransform(t: Transform, v: string, tz: string, field: string): Step {
  const bad = (code: string, message: string): Step => ({ value: null, issue: { severity: "error", code, message, field } });
  const warn = (code: string, message: string): Step => ({ value: null, issue: { severity: "warning", code, message, field } });
  switch (t.op) {
    case "trim": return { value: v.trim() };
    case "lower": return { value: v.toLowerCase() };
    case "upper": return { value: v.toUpperCase() };
    case "collapse_space": return { value: v.replace(/\s+/g, " ").trim() };
    case "phone_e164": { const p = normalizePhone(v); return p ? { value: p.e164 } : warn("PHONE_INVALID", "Not a valid phone number; the value was dropped."); }
    case "email": { const e = normalizeEmail(v); return e ? { value: e } : warn("EMAIL_INVALID", "Not a valid email address; the value was dropped."); }
    case "money": { const m = parseMoney(v); return m === undefined ? bad("MONEY_INVALID", "Not a valid amount.") : { value: m }; }
    case "money_cents": { const m = parseCents(v); return m === undefined ? bad("MONEY_INVALID", "Not a valid amount.") : { value: m }; }
    case "number": { const s = v.replace(/,/g, ""); return /^[+-]?\d+(\.\d+)?$/.test(s) && Number.isFinite(Number(s)) ? { value: Number(s) } : bad("NUMBER_INVALID", "Not a valid number."); }
    case "integer": { const s = v.replace(/,/g, ""); return /^[+-]?\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? { value: Number(s) } : bad("NUMBER_INVALID", "Not a valid whole number."); }
    case "boolean": { const l = v.toLowerCase(); return TRUE.has(l) ? { value: true } : FALSE.has(l) ? { value: false } : bad("BOOLEAN_INVALID", "Not a yes/no value."); }
    case "date": { const d = parseDate(v); return d === undefined ? bad("DATE_INVALID", "Not a recognised date.") : { value: d }; }
    case "timestamp": { const d = parseDateTime(v, tz); return d === undefined ? bad("DATETIME_INVALID", "Not a recognised date/time.") : { value: d }; }
    case "enum": {
      if (has(t.map, v)) return { value: t.map[v] };
      const lower = v.toLowerCase();
      for (const k of Object.keys(t.map)) if (k.toLowerCase() === lower) return { value: t.map[k] };
      return t.fallback !== undefined ? { value: t.fallback } : bad("ENUM_UNMAPPED", "Value is not in the enum map and no fallback is set.");
    }
    case "truncate": return v.length > t.max ? { value: v.slice(0, t.max), issue: { severity: "warning", code: "TRUNCATED", message: `Value was cut to ${t.max} characters.`, field } } : { value: v };
  }
}

function gather(from: string | string[] | undefined, join: string | undefined, raw: RawRow): string | null {
  if (from === undefined) return null;
  const cols = typeof from === "string" ? [from] : from;
  const parts = cols.map((c) => text(has(raw, c) ? raw[c] : "")).filter((p) => p !== "");
  return parts.length ? parts.join(join ?? " ") : null;
}

function run(value: string | null, def: Scalar | undefined, transforms: Transform[] | undefined, tz: string, field: string, issues: Issue[]): Scalar {
  let v: Scalar = value === null && def !== undefined ? def : value;
  for (const t of transforms ?? []) {
    if (v === null) break;
    const s = applyTransform(t, String(v), tz, field);
    if (s.issue) issues.push(s.issue);
    v = s.value;
    if (s.issue?.severity === "error") break;
  }
  return v;
}

function typeCheck(f: string, type: string, v: Scalar, maxLength: number | undefined, issues: Issue[]): Scalar {
  if (v === null) return null;
  const mismatch = (): null => { issues.push({ severity: "error", code: "TYPE_MISMATCH", field: f, message: `Value does not fit the ${type} field.` }); return null; };
  switch (type) {
    case "string": { const s = String(v); if (maxLength && s.length > maxLength) { issues.push({ severity: "error", code: "TOO_LONG", field: f, message: `Longer than ${maxLength} characters.` }); return null; } return s; }
    case "number": return typeof v === "number" && Number.isFinite(v) ? v : mismatch();
    case "integer": return typeof v === "number" && Number.isSafeInteger(v) ? v : mismatch();
    case "boolean": return typeof v === "boolean" ? v : mismatch();
    case "date": return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : mismatch();
    case "timestamp": return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)) ? v : mismatch();
    default: return mismatch();
  }
}

export interface MappedRecord {
  key: string | null;
  /** Target column values. Empty/absent source values are OMITTED (an import never clears target data). */
  values: Values;
  /** Reference field -> source key of the referenced entity (resolved to an id by the engine). */
  refs: Record<string, string>;
  issues: Issue[];
}

export function mapRecord(em: EntityMapping, def: EntityDefinition, raw: RawRow, tz: string): MappedRecord {
  const issues: Issue[] = [];
  const values: Values = {};
  const refs: Record<string, string> = {};

  let key: string | null = null;
  if (em.key) {
    const k = run(gather(em.key.from, em.key.join, raw), undefined, em.key.transforms, tz, "key", issues);
    key = k === null ? null : String(k).trim() || null;
    if (key !== null && key.length > 200) { issues.push({ severity: "error", code: "KEY_TOO_LONG", field: "key", message: "Source key is longer than 200 characters." }); key = null; }
  }

  for (const [f, rule] of Object.entries(em.fields)) {
    const base = has(rule, "value") ? (rule.value === null ? null : String(rule.value)) : gather(rule.from, rule.join, raw);
    const before = issues.length;
    let v = run(base, rule.default, rule.transforms, tz, f, issues);
    const failed = issues.slice(before).some((i) => i.severity === "error");
    const ref = def.references && has(def.references, f) ? def.references[f] : undefined;
    const fieldDef = has(def.fields, f) ? def.fields[f] : undefined;
    if (!failed && !ref && fieldDef) v = typeCheck(f, fieldDef.type, v, fieldDef.maxLength, issues);
    const required = rule.required === true || fieldDef?.required === true || ref?.required === true;
    if (v === null && required && !failed && !issues.slice(before).some((i) => i.severity === "error")) issues.push({ severity: "error", code: "REQUIRED_MISSING", field: f, message: "A required value is missing." });
    if (v === null) continue;
    if (ref) refs[f] = String(v).trim(); else values[f] = v;
  }
  if (def.validate) issues.push(...def.validate(values));
  return { key, values, refs, issues };
}
