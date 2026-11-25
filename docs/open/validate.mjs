#!/usr/bin/env node
/**
 * Example validator for the Service Event Spec (DRAFT, not published).
 *
 *   node docs/open/validate.mjs <event.json> [more.json ...]
 *
 * Checks, in order: (1) the envelope, (2) the event type is registered in event-types.json,
 * (3) `data` against the schema registered for that event type.
 * Exit codes: 0 all valid, 1 at least one invalid, 2 usage / file problem.
 *
 * Zero dependencies on purpose: it is a reference for implementers, and it only supports the JSON Schema
 * 2020-12 keywords the spec's schemas use. A schema that uses anything else makes the validator THROW instead of
 * silently passing, so the supported subset can never hide an unchecked rule. For production use any
 * JSON Schema 2020-12 validator (the schemas are standard); this file is the readable reference.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default', 'deprecated']);
const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'enum', 'const', 'format',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'items', 'minItems', 'maxItems',
  'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;

function isRealDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1];
}

const FORMATS = {
  uuid: (s) => UUID_RE.test(s),
  date: (s) => {
    const m = DATE_RE.exec(s);
    return !!m && isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
  },
  'date-time': (s) => {
    const m = DATETIME_RE.exec(s);
    if (!m) return false;
    const [, y, mo, d, h, mi, sec] = m;
    if (!isRealDate(Number(y), Number(mo), Number(d))) return false;
    if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 60) return false;
    if (m[9] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59)) return false;
    return true;
  },
  uri: (s) => {
    try { new URL(s); return true; } catch { return false; }
  },
};

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeMatches(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return isObject(v);
    default: throw new Error(`Unsupported type "${type}"`);
  }
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Throws on any keyword outside the supported subset (strict by design). */
export function assertSupported(schema, where = '#') {
  if (typeof schema === 'boolean') return;
  if (!isObject(schema)) throw new Error(`${where}: a schema must be an object or boolean`);
  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.has(key) || key.startsWith('x-')) continue;
    if (!KEYWORDS.has(key)) throw new Error(`${where}: unsupported keyword "${key}"`);
  }
  for (const [k, sub] of Object.entries(schema.properties ?? {})) assertSupported(sub, `${where}/properties/${k}`);
  for (const key of ['items', 'not', 'if', 'then', 'else']) if (schema[key] !== undefined) assertSupported(schema[key], `${where}/${key}`);
  if (isObject(schema.additionalProperties)) assertSupported(schema.additionalProperties, `${where}/additionalProperties`);
  for (const key of ['oneOf', 'anyOf', 'allOf']) (schema[key] ?? []).forEach((s, i) => assertSupported(s, `${where}/${key}/${i}`));
}

/** Returns a list of { path, message }. Empty list = valid. */
export function validate(schema, data, path = '') {
  assertSupported(schema);
  return check(schema, data, path);
}

function check(schema, data, path) {
  if (schema === true) return [];
  if (schema === false) return [{ path: path || '/', message: 'not allowed' }];
  const here = path || '/';
  const errs = [];
  const add = (message) => errs.push({ path: here, message });

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, data))) {
      add(`must be ${types.join(' or ')}`);
      return errs; // later keywords assume the type is right
    }
  }
  if (schema.const !== undefined && !deepEqual(schema.const, data)) add(`must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, data))) add(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);

  if (typeof data === 'string') {
    if (schema.minLength !== undefined && [...data].length < schema.minLength) add(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && [...data].length > schema.maxLength) add(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(data)) add(`must match ${schema.pattern}`);
    if (schema.format !== undefined) {
      const fn = FORMATS[schema.format];
      if (!fn) throw new Error(`Unsupported format "${schema.format}"`);
      if (!fn(data)) add(`must be a valid ${schema.format}`);
    }
  }
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) add(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) add(`must be <= ${schema.maximum}`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) add(`must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) add(`must have at most ${schema.maxItems} items`);
    if (schema.items !== undefined) data.forEach((item, i) => errs.push(...check(schema.items, item, `${path}/${i}`)));
  }
  if (isObject(data)) {
    for (const key of schema.required ?? []) if (!(key in data)) errs.push({ path: `${path}/${key}`, message: 'is required' });
    const props = schema.properties ?? {};
    for (const [key, value] of Object.entries(data)) {
      if (Object.hasOwn(props, key)) errs.push(...check(props[key], value, `${path}/${key}`));
      else if (schema.additionalProperties === false) errs.push({ path: `${path}/${key}`, message: 'is not allowed' });
      else if (isObject(schema.additionalProperties)) errs.push(...check(schema.additionalProperties, value, `${path}/${key}`));
    }
  }

  for (const sub of schema.allOf ?? []) errs.push(...check(sub, data, path));
  if (schema.anyOf && !schema.anyOf.some((s) => check(s, data, path).length === 0)) add('must match at least one allowed shape');
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => check(s, data, path).length === 0).length;
    if (n !== 1) add(`must match exactly one allowed shape (matched ${n})`);
  }
  if (schema.not !== undefined && check(schema.not, data, path).length === 0) add('must not match the excluded shape');
  if (schema.if !== undefined) {
    const matches = check(schema.if, data, path).length === 0;
    if (matches && schema.then !== undefined) errs.push(...check(schema.then, data, path));
    if (!matches && schema.else !== undefined) errs.push(...check(schema.else, data, path));
  }
  return errs;
}

/**
 * Backward-compatibility rule for a data schema (same rule as the platform's event-registry `compatibilityErrors`):
 * a new version may only ADD OPTIONAL fields. Removing a field, changing its type, making an optional field required,
 * or adding a new required field is breaking and needs a new major spec version. Empty list = compatible.
 */
export function compatibilityErrors(oldSchema, nextSchema) {
  const errs = [];
  const oldProps = oldSchema.properties ?? {};
  const nextProps = nextSchema.properties ?? {};
  const oldReq = new Set(oldSchema.required ?? []);
  const nextReq = new Set(nextSchema.required ?? []);
  const typeKey = (s) => JSON.stringify([].concat(s?.type ?? []).sort());
  for (const [k, def] of Object.entries(oldProps)) {
    if (!Object.hasOwn(nextProps, k)) errs.push(`field "${k}" was removed`);
    else if (typeKey(def) !== typeKey(nextProps[k])) errs.push(`field "${k}" changed type`);
    else if (nextReq.has(k) && !oldReq.has(k)) errs.push(`field "${k}" became required`);
  }
  for (const k of nextReq) if (!Object.hasOwn(oldProps, k) && !oldReq.has(k)) errs.push(`new field "${k}" must be optional`);
  return errs;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Validate one event object. Returns { ok, errors, notes }.
 * `dir` is the spec folder (default: this file's folder).
 */
export function validateEvent(event, dir = HERE) {
  const errors = [];
  const notes = [];
  const envelope = readJson(join(dir, 'schemas', 'envelope.schema.json'));
  for (const e of validate(envelope, event)) errors.push(`envelope ${e.path}: ${e.message}`);
  if (errors.length > 0) return { ok: false, errors, notes };

  const registry = readJson(join(dir, 'event-types.json'));
  const entry = registry.events.find((e) => e.event === event.event);
  if (!entry) {
    notes.push(`"${event.event}" is not registered: envelope checked, data NOT validated`);
    return { ok: true, errors, notes };
  }
  if (entry.status === 'proposed') notes.push(`"${event.event}" is a PROPOSED event type: no producer emits it yet`);
  if (!entry.data_schema) {
    notes.push(`"${event.event}" has no data schema in this draft: envelope checked, data NOT validated`);
    return { ok: true, errors, notes };
  }
  const schema = readJson(join(dir, 'schemas', entry.data_schema));
  for (const e of validate(schema, event.data, '/data')) errors.push(`data ${e.path}: ${e.message}`);
  return { ok: errors.length === 0, errors, notes };
}

function main(argv) {
  const files = argv.filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('Usage: node docs/open/validate.mjs <event.json> [more.json ...]');
    return 2;
  }
  let exit = 0;
  for (const f of files) {
    let event;
    try {
      event = readJson(resolve(f));
    } catch (err) {
      console.error(`${f}: cannot read as JSON (${err instanceof Error ? err.message : String(err)})`);
      return 2;
    }
    const { ok, errors, notes } = validateEvent(event);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}`);
    for (const n of notes) console.log(`  note: ${n}`);
    for (const e of errors) console.log(`  - ${e}`);
    if (!ok) exit = 1;
  }
  return exit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
