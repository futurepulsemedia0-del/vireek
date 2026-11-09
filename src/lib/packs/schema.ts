/**
 * Strict, dependency-free validator for pack manifests.
 * - Unknown properties are rejected, with a "did you mean" hint for typos.
 * - Every error carries a JSON-path-like location and the offending value, so an author can
 *   fix a pack without reading this file.
 * - Cross-references (job type -> form, workflow rule -> status ...) are checked.
 * - Money must be integer cents; text is length-capped; template bodies may not contain HTML.
 */

import {
  ARTIFACT_KINDS,
  PACK_SCHEMA_VERSION,
  type Artifact,
  type ArtifactId,
  type ArtifactKind,
  type PackManifest,
} from './types';

export const KEY_RE = /^[a-z][a-z0-9_]{1,60}$/;
export const PACK_ID_RE = /^[a-z][a-z0-9_]{1,40}$/;
export const SEMVER_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
export const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.]{1,60})\s*\}\}/g;
export const MAX_ARTIFACTS_PER_KIND = 200;
export const MAX_MANIFEST_BYTES = 262_144;
export const MAX_ARTIFACT_BYTES = 16_000;

export interface PackIssue {
  path: string;
  message: string;
}

type Spec =
  | { t: 'str'; max: number; min?: number; re?: RegExp; hint?: string }
  | { t: 'int'; min: number; max: number }
  | { t: 'bool' }
  | { t: 'enum'; v: readonly string[] }
  | { t: 'arr'; of: Spec; max: number; min?: number }
  | { t: 'obj'; f: Record<string, { s: Spec; req?: boolean }> };

const str = (max: number, o: { min?: number; re?: RegExp; hint?: string } = {}): Spec => ({ t: 'str', max, ...o });
const int = (min: number, max: number): Spec => ({ t: 'int', min, max });
const en = (...v: string[]): Spec => ({ t: 'enum', v });
const arr = (of: Spec, max: number, min?: number): Spec => ({ t: 'arr', of, max, min });
const obj = (f: Record<string, { s: Spec; req?: boolean }>): Spec => ({ t: 'obj', f });
const R = (s: Spec) => ({ s, req: true });
const O = (s: Spec) => ({ s });

const keyS = str(61, { min: 2, re: KEY_RE, hint: 'lowercase letters, digits and underscores, starting with a letter (2-61 chars)' });
const label = str(120, { min: 1 });
const cents = int(0, 100_000_000);

/** Per-kind specs for the *content* of one artifact (also used to validate account customizations). */
export const CONTENT_SPECS: Record<ArtifactKind, Spec> = {
  job_type: obj({
    key: R(keyS), label: R(label), description: O(str(500)),
    defaultDurationMinutes: R(int(5, 1440)), checklistFormKey: O(keyS), pricingTemplateKey: O(keyS),
    ticketMinCents: O(cents), ticketMaxCents: O(cents),
  }),
  custom_field: obj({
    key: R(keyS), label: R(label), entity: R(en('customer', 'job', 'equipment')),
    fieldType: R(en('text', 'number', 'select', 'date', 'boolean')),
    options: O(arr(str(80, { min: 1 }), 50, 1)), required: O({ t: 'bool' }),
  }),
  form: obj({
    key: R(keyS), title: R(label), kind: R(en('form', 'checklist')),
    items: R(arr(obj({
      id: R(str(60, { min: 1, re: /^[a-z0-9_]+$/, hint: 'lowercase letters, digits and underscores' })), label: R(label),
      type: O(en('check', 'text', 'number', 'photo')), required: O({ t: 'bool' }), critical: O({ t: 'bool' }),
    }), 100, 1)),
  }),
  status: obj({ key: R(keyS), label: R(label), category: R(en('open', 'active', 'done', 'cancelled')), order: R(int(0, 1000)) }),
  workflow_rule: obj({
    key: R(keyS), label: R(label), from: R(keyS), to: R(keyS),
    requiresFormKeys: O(arr(keyS, 20)), requiresPhoto: O({ t: 'bool' }),
  }),
  pricing_template: obj({
    key: R(keyS), label: R(label),
    lines: R(arr(obj({
      key: R(keyS), label: R(label), pricingModel: R(en('flat', 'hourly', 'starting_at', 'range', 'per_unit')),
      priceCents: R(cents), priceMaxCents: O(cents), estimatedCostCents: O(cents),
    }), 100, 1)),
  }),
  term: obj({ key: R(keyS), singular: R(str(60, { min: 1 })), plural: R(str(60, { min: 1 })) }),
  document_template: obj({
    key: R(keyS), label: R(label), docType: R(en('estimate', 'invoice', 'work_order', 'agreement')),
    body: R(str(8000, { min: 1 })),
  }),
  recurring_rule: obj({
    key: R(keyS), label: R(label), intervalUnit: R(en('week', 'month', 'year')),
    intervalCount: R(int(1, 60)), durationMinutes: R(int(5, 1440)), jobTypeKey: O(keyS),
  }),
  report: obj({
    key: R(keyS), label: R(label),
    metric: R(en('revenue', 'callback_rate', 'first_time_fix', 'avg_ticket', 'jobs_completed')),
    groupBy: R(en('job_type', 'technician', 'month')),
  }),
  onboarding_preset: obj({
    key: R(keyS), label: R(label),
    steps: R(arr(obj({
      key: R(keyS), label: R(label),
      route: O(str(120, { re: /^\/[A-Za-z0-9\-_/]*$/, hint: 'an in-app path such as /dashboard/jobs' })),
    }), 30, 1)),
  }),
};

/** Manifest array property -> artifact kind. */
export const SECTION_KINDS: ReadonlyArray<readonly [string, ArtifactKind]> = [
  ['jobTypes', 'job_type'], ['customFields', 'custom_field'], ['forms', 'form'], ['statuses', 'status'],
  ['workflowRules', 'workflow_rule'], ['pricingTemplates', 'pricing_template'], ['terminology', 'term'],
  ['documentTemplates', 'document_template'], ['recurringRules', 'recurring_rule'], ['reports', 'report'],
  ['onboardingPresets', 'onboarding_preset'],
];

const TOP_LEVEL = new Set(['schemaVersion', 'id', 'version', 'name', 'description', ...SECTION_KINDS.map(([s]) => s)]);
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/* ------------------------------ helpers ------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function suggest(bad: string, known: Iterable<string>): string {
  let best: string | null = null, d = 3;
  for (const k of known) {
    const x = lev(bad.toLowerCase(), k.toLowerCase());
    if (x < d) { d = x; best = k; }
  }
  return best ? ` Did you mean "${best}"?` : '';
}

const show = (v: unknown) => {
  const s = typeof v === 'string' ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v) : JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

function check(spec: Spec, v: unknown, path: string, out: PackIssue[]): void {
  switch (spec.t) {
    case 'str':
      if (typeof v !== 'string') return void out.push({ path, message: `must be text (got ${show(v)})` });
      if (v.length < (spec.min ?? 0)) return void out.push({ path, message: `must have at least ${spec.min} character(s)` });
      if (v.length > spec.max) return void out.push({ path, message: `is too long (${v.length} > ${spec.max} characters)` });
      if (spec.re && !spec.re.test(v)) out.push({ path, message: `${show(v)} is not valid: use ${spec.hint ?? spec.re.source}` });
      return;
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v)) return void out.push({ path, message: `must be a whole number (got ${show(v)}); money is integer cents` });
      if (v < spec.min || v > spec.max) out.push({ path, message: `must be between ${spec.min} and ${spec.max} (got ${v})` });
      return;
    case 'bool':
      if (typeof v !== 'boolean') out.push({ path, message: `must be true or false (got ${show(v)})` });
      return;
    case 'enum':
      if (typeof v !== 'string' || !spec.v.includes(v)) out.push({ path, message: `must be one of ${spec.v.join(' | ')} (got ${show(v)}).${typeof v === 'string' ? suggest(v, spec.v) : ''}` });
      return;
    case 'arr':
      if (!Array.isArray(v)) return void out.push({ path, message: 'must be a list' });
      if (v.length < (spec.min ?? 0)) out.push({ path, message: `needs at least ${spec.min} item(s)` });
      if (v.length > spec.max) return void out.push({ path, message: `has too many items (${v.length} > ${spec.max})` });
      v.forEach((x, i) => check(spec.of, x, `${path}[${i}]`, out));
      return;
    case 'obj': {
      if (!isPlainObject(v)) return void out.push({ path, message: 'must be an object' });
      for (const k of Object.keys(v)) {
        if (BLOCKED_KEYS.has(k)) out.push({ path: `${path}.${k}`, message: 'is not allowed' });
        else if (!(k in spec.f)) out.push({ path: `${path}.${k}`, message: `is not a known property.${suggest(k, Object.keys(spec.f))}` });
      }
      for (const [k, { s, req }] of Object.entries(spec.f)) {
        if (!Object.prototype.hasOwnProperty.call(v, k) || v[k] === undefined) {
          if (req) out.push({ path: `${path}.${k}`, message: 'is required' });
        } else check(s, v[k], `${path}.${k}`, out);
      }
    }
  }
}

/* --------------------------- public API --------------------------- */

export const artifactId = (kind: ArtifactKind, key: string): ArtifactId => `${kind}:${key}`;

export function parseArtifactId(id: string): { kind: ArtifactKind; key: string } | null {
  const i = id.indexOf(':');
  if (i < 1) return null;
  const kind = id.slice(0, i) as ArtifactKind;
  const key = id.slice(i + 1);
  return (ARTIFACT_KINDS as readonly string[]).includes(kind) && KEY_RE.test(key) ? { kind, key } : null;
}

/** Validates ONE artifact's content — used for pack authoring and for account customizations. */
export function validateArtifactContent(kind: ArtifactKind, content: unknown): PackIssue[] {
  const out: PackIssue[] = [];
  check(CONTENT_SPECS[kind], content, kind, out);
  if (!out.length) out.push(...semanticIssues(kind, content as Record<string, unknown>, kind));
  if (!out.length && JSON.stringify(content).length > MAX_ARTIFACT_BYTES) out.push({ path: kind, message: `is too large (max ${MAX_ARTIFACT_BYTES} bytes)` });
  return out;
}

/** Rules that need more than a shape check. Assumes the shape is already valid. */
function semanticIssues(kind: ArtifactKind, c: Record<string, unknown>, path: string): PackIssue[] {
  const out: PackIssue[] = [];
  if (kind === 'custom_field') {
    const hasOpts = Array.isArray(c.options) && c.options.length > 0;
    if (c.fieldType === 'select' && !hasOpts) out.push({ path: `${path}.options`, message: 'a "select" field needs at least one option' });
    if (c.fieldType !== 'select' && c.options !== undefined) out.push({ path: `${path}.options`, message: 'only a "select" field may have options' });
    if (hasOpts && new Set(c.options as string[]).size !== (c.options as string[]).length) out.push({ path: `${path}.options`, message: 'options must be unique' });
  }
  if (kind === 'job_type' && typeof c.ticketMinCents === 'number' && typeof c.ticketMaxCents === 'number' && c.ticketMinCents > c.ticketMaxCents) {
    out.push({ path: `${path}.ticketMinCents`, message: 'must not exceed ticketMaxCents' });
  }
  if (kind === 'form') {
    const ids = (c.items as Array<{ id: string }>).map((i) => i.id);
    const dup = ids.find((x, i) => ids.indexOf(x) !== i);
    if (dup) out.push({ path: `${path}.items`, message: `duplicate item id "${dup}"` });
  }
  if (kind === 'pricing_template') {
    (c.lines as Array<{ pricingModel: string; priceCents: number; priceMaxCents?: number }>).forEach((l, i) => {
      if (l.pricingModel === 'range' && l.priceMaxCents === undefined) out.push({ path: `${path}.lines[${i}].priceMaxCents`, message: 'a "range" line needs priceMaxCents' });
      if (l.pricingModel !== 'range' && l.priceMaxCents !== undefined) out.push({ path: `${path}.lines[${i}].priceMaxCents`, message: 'only a "range" line may have priceMaxCents' });
      if (l.priceMaxCents !== undefined && l.priceMaxCents < l.priceCents) out.push({ path: `${path}.lines[${i}].priceMaxCents`, message: 'must not be below priceCents' });
    });
  }
  if (kind === 'pricing_template' || kind === 'onboarding_preset') {
    const list = (kind === 'pricing_template' ? c.lines : c.steps) as Array<{ key: string }>;
    const dup = list.map((x) => x.key).find((x, i, a) => a.indexOf(x) !== i);
    if (dup) out.push({ path: `${path}.${kind === 'pricing_template' ? 'lines' : 'steps'}`, message: `duplicate key "${dup}"` });
  }
  if (kind === 'workflow_rule' && c.from === c.to) out.push({ path: `${path}.to`, message: 'must differ from "from"' });
  if (kind === 'document_template') {
    const body = c.body as string;
    if (/<\s*\/?\s*[a-zA-Z!]/.test(body)) out.push({ path: `${path}.body`, message: 'HTML is not allowed; use plain text with {{placeholders}}' });
    const stray = body.replace(TOKEN_RE, '').match(/\{\{|\}\}/);
    if (stray) out.push({ path: `${path}.body`, message: 'has an unbalanced or malformed {{placeholder}}' });
  }
  return out;
}

/** Validates a whole manifest. `ok` is true only when `issues` is empty. */
export function validatePack(input: unknown): { ok: boolean; issues: PackIssue[]; pack?: PackManifest } {
  const issues: PackIssue[] = [];
  if (!isPlainObject(input)) return { ok: false, issues: [{ path: '$', message: 'a pack must be a JSON object' }] };
  let size = 0;
  try { size = JSON.stringify(input).length; } catch { return { ok: false, issues: [{ path: '$', message: 'must be plain JSON (no cycles, functions or undefined)' }] }; }
  if (size > MAX_MANIFEST_BYTES) return { ok: false, issues: [{ path: '$', message: `is too large (${size} > ${MAX_MANIFEST_BYTES} bytes)` }] };

  for (const k of Object.keys(input)) {
    if (!TOP_LEVEL.has(k)) issues.push({ path: `$.${k}`, message: `is not a known section.${suggest(k, TOP_LEVEL)}` });
  }
  if (input.schemaVersion !== PACK_SCHEMA_VERSION) issues.push({ path: '$.schemaVersion', message: `must be ${PACK_SCHEMA_VERSION} (got ${show(input.schemaVersion)})` });
  check(str(41, { min: 2, re: PACK_ID_RE, hint: 'lowercase letters, digits and underscores, starting with a letter' }), input.id, '$.id', issues);
  check(str(20, { re: SEMVER_RE, hint: 'MAJOR.MINOR.PATCH, e.g. 1.0.0' }), input.version, '$.version', issues);
  check(str(80, { min: 1 }), input.name, '$.name', issues);
  if (input.description !== undefined) check(str(500), input.description, '$.description', issues);

  const seen: Record<string, Set<string>> = {};
  for (const [section, kind] of SECTION_KINDS) {
    const list = input[section];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { issues.push({ path: `$.${section}`, message: 'must be a list' }); continue; }
    if (list.length > MAX_ARTIFACTS_PER_KIND) { issues.push({ path: `$.${section}`, message: `has too many entries (${list.length} > ${MAX_ARTIFACTS_PER_KIND})` }); continue; }
    const keys = (seen[kind] = new Set());
    list.forEach((item, i) => {
      const p = `$.${section}[${i}]`;
      const before = issues.length;
      check(CONTENT_SPECS[kind], item, p, issues);
      if (issues.length === before) {
        issues.push(...semanticIssues(kind, item as Record<string, unknown>, p));
        const sz = JSON.stringify(item).length;
        if (sz > MAX_ARTIFACT_BYTES) issues.push({ path: p, message: `is too large (${sz} > ${MAX_ARTIFACT_BYTES} bytes)` });
        const key = (item as { key: string }).key;
        if (keys.has(key)) issues.push({ path: `${p}.key`, message: `duplicate key "${key}" in ${section}` });
        keys.add(key);
      }
    });
  }
  if (!issues.length) issues.push(...crossRefIssues(input as unknown as PackManifest));
  return issues.length ? { ok: false, issues } : { ok: true, issues, pack: input as unknown as PackManifest };
}

function crossRefIssues(p: PackManifest): PackIssue[] {
  const out: PackIssue[] = [];
  const keys = (l?: Array<{ key: string }>) => new Set((l ?? []).map((x) => x.key));
  const forms = keys(p.forms), prices = keys(p.pricingTemplates), statuses = keys(p.statuses), jobs = keys(p.jobTypes);
  const ref = (path: string, k: string | undefined, set: Set<string>, what: string, section: string) => {
    if (k !== undefined && !set.has(k)) out.push({ path, message: `references unknown ${what} "${k}" (not in ${section}).${suggest(k, set)}` });
  };
  (p.jobTypes ?? []).forEach((j, i) => {
    ref(`$.jobTypes[${i}].checklistFormKey`, j.checklistFormKey, forms, 'form', 'forms');
    ref(`$.jobTypes[${i}].pricingTemplateKey`, j.pricingTemplateKey, prices, 'pricing template', 'pricingTemplates');
  });
  (p.workflowRules ?? []).forEach((r, i) => {
    ref(`$.workflowRules[${i}].from`, r.from, statuses, 'status', 'statuses');
    ref(`$.workflowRules[${i}].to`, r.to, statuses, 'status', 'statuses');
    (r.requiresFormKeys ?? []).forEach((k, j) => ref(`$.workflowRules[${i}].requiresFormKeys[${j}]`, k, forms, 'form', 'forms'));
  });
  (p.recurringRules ?? []).forEach((r, i) => ref(`$.recurringRules[${i}].jobTypeKey`, r.jobTypeKey, jobs, 'job type', 'jobTypes'));
  return out;
}

/** Flattens a VALID manifest into addressable artifacts (stable order: section order, then list order). */
export function flattenPack(p: PackManifest): Artifact[] {
  const out: Artifact[] = [];
  for (const [section, kind] of SECTION_KINDS) {
    for (const item of ((p as unknown as Record<string, unknown>)[section] as Array<{ key: string }> | undefined) ?? []) {
      out.push({ kind, key: item.key, content: item as unknown as Record<string, unknown> });
    }
  }
  return out;
}

export function formatIssues(issues: PackIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join('\n');
}
