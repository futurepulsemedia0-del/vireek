/**
 * Document Template Studio — merge engine (pure, framework-free, no I/O).
 *
 * Syntax (superset of messageTemplates.ts: {{key}} and {{key|fallback}} behave identically):
 *   {{customer.name}}  {{customer.name|Customer}}
 *   {{#if job.address}}…{{else}}…{{/if}}   {{#if customer.type == "commercial"}}…{{/if}}
 *   {{#unless job.address}}…{{/unless}}
 *   {{clause:limitation-of-liability}}      (locked clause from the clause library)
 *
 * Guarantees: no eval, no HTML (output is plain text; renderers must escape), single-pass
 * (a value containing "{{x}}" is never re-expanded), size/depth caps, missing values are
 * reported (never silently blank).
 */

export type FieldType = 'text' | 'money_cents' | 'date' | 'bool';
export type FieldGroup = 'customer' | 'job' | 'organization' | 'document' | 'custom';
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  group: FieldGroup;
  sample: string;
}
export type FieldValue = string | number | boolean | null | undefined;
export type Values = Readonly<Record<string, FieldValue>>;

export interface ClauseSnapshot {
  slug: string;
  version: number;
  body: string;
  /** SHA-256 (hex) of `body`, recorded when the clause version was published. */
  sha256: string;
}

export interface RenderOptions {
  fields: readonly FieldDef[];
  clauses?: readonly ClauseSnapshot[];
  locale?: string;
  /** IANA zone for date-time values; date-only values (YYYY-MM-DD) are always shown as-is. */
  timeZone?: string;
  /** ISO 4217 code used for money_cents fields. */
  currency?: string;
  /** 'marker' (default) renders ⟦key⟧ for a missing value so a gap can never pass unnoticed. */
  onMissing?: 'marker' | 'empty';
}

export type DiagnosticCode =
  | 'BAD_SYNTAX' | 'UNCLOSED_BLOCK' | 'UNEXPECTED_CLOSE' | 'UNEXPECTED_ELSE'
  | 'UNKNOWN_FIELD' | 'UNKNOWN_CLAUSE' | 'NESTED_CLAUSE' | 'WRONG_TYPE'
  | 'INVALID_VALUE' | 'TOO_LARGE' | 'TOO_DEEP' | 'LOCALE_FALLBACK' | 'CLAUSE_TAMPERED';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  pos: number;
}

export interface RenderResult {
  text: string;
  /** Field keys with neither a value nor a fallback. */
  missing: string[];
  usedClauses: { slug: string; version: number; sha256: string }[];
  diagnostics: Diagnostic[];
  /** No error diagnostics. */
  ok: boolean;
  /** ok AND nothing missing — the only state in which a document may be finalised. */
  complete: boolean;
}

export const LIMITS = { source: 100_000, tokens: 2_000, depth: 8, output: 300_000 } as const;

type Node =
  | { t: 'text'; v: string }
  | { t: 'var'; key: string; fb: string | null; pos: number }
  | { t: 'clause'; slug: string; pos: number }
  | { t: 'if'; neg: boolean; key: string; op: 'truthy' | 'eq' | 'ne'; lit: string; yes: Node[]; no: Node[]; pos: number };

const KEY = '[a-z][a-z0-9_.]{0,63}';
const TOKEN_RE = /\{\{([^{}]*)\}\}/g;
const OPEN_RE = new RegExp(`^#(if|unless)\\s+(${KEY})(?:\\s*(==|!=)\\s*"([^"{}]*)")?$`, 'i');
const CLAUSE_RE = /^clause:([a-z0-9][a-z0-9-]{0,63})$/i;
const VAR_RE = new RegExp(`^(${KEY})(?:\\|([\\s\\S]*))?$`, 'i');

interface Frame { node: Extract<Node, { t: 'if' }>; branch: 'yes' | 'no'; name: 'if' | 'unless' }

function parse(source: string, diagnostics: Diagnostic[]): Node[] {
  const root: Node[] = [];
  if (source.length > LIMITS.source) {
    diagnostics.push({ code: 'TOO_LARGE', severity: 'error', message: 'Template is too large.', pos: 0 });
    return root;
  }
  const stack: Frame[] = [];
  const target = (): Node[] => {
    const f = stack[stack.length - 1];
    return f ? (f.branch === 'yes' ? f.node.yes : f.node.no) : root;
  };
  const err = (code: DiagnosticCode, message: string, pos: number) =>
    diagnostics.push({ code, severity: 'error', message, pos });

  let cursor = 0;
  let tokens = 0;
  for (const m of source.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (start > cursor) target().push({ t: 'text', v: source.slice(cursor, start) });
    cursor = start + m[0].length;
    if (++tokens > LIMITS.tokens) {
      err('TOO_LARGE', 'Too many merge tags.', start);
      return root;
    }
    const body = m[1].trim();
    let mm: RegExpExecArray | null;
    if ((mm = OPEN_RE.exec(body))) {
      if (stack.length >= LIMITS.depth) {
        err('TOO_DEEP', `Blocks are nested deeper than ${LIMITS.depth}.`, start);
        return root;
      }
      const name = mm[1].toLowerCase() as 'if' | 'unless';
      const node: Extract<Node, { t: 'if' }> = {
        t: 'if', neg: name === 'unless', key: mm[2].toLowerCase(),
        op: mm[3] === '==' ? 'eq' : mm[3] === '!=' ? 'ne' : 'truthy', lit: mm[4] ?? '',
        yes: [], no: [], pos: start,
      };
      target().push(node);
      stack.push({ node, branch: 'yes', name });
    } else if (/^else$/i.test(body)) {
      const f = stack[stack.length - 1];
      if (!f || f.branch === 'no') err('UNEXPECTED_ELSE', '{{else}} without a matching {{#if}}.', start);
      else f.branch = 'no';
    } else if (/^\/(if|unless)$/i.test(body)) {
      const name = body.slice(1).toLowerCase();
      const f = stack[stack.length - 1];
      if (!f || f.name !== name) err('UNEXPECTED_CLOSE', `{{/${name}}} does not match an open block.`, start);
      else stack.pop();
    } else if ((mm = CLAUSE_RE.exec(body))) {
      target().push({ t: 'clause', slug: mm[1].toLowerCase(), pos: start });
    } else if ((mm = VAR_RE.exec(body))) {
      target().push({ t: 'var', key: mm[1].toLowerCase(), fb: mm[2] === undefined ? null : mm[2].trim(), pos: start });
    } else {
      err('BAD_SYNTAX', `Unrecognised tag "${m[0]}".`, start);
      target().push({ t: 'text', v: m[0] });
    }
  }
  if (cursor < source.length) target().push({ t: 'text', v: source.slice(cursor) });
  for (const f of stack) err('UNCLOSED_BLOCK', `{{#${f.name}}} is never closed.`, f.node.pos);
  return root;
}

interface Ctx {
  fields: Map<string, FieldDef>;
  clauses: Map<string, ClauseSnapshot>;
  values: Values;
  fmt: Formatters;
  missing: Set<string>;
  used: Map<string, { slug: string; version: number; sha256: string }>;
  diagnostics: Diagnostic[];
  marker: boolean;
  size: number;
  inClause: boolean;
}

interface Formatters {
  money: (minor: number) => string;
  date: (iso: string) => string | null;
}

function makeFormatters(o: RenderOptions, diagnostics: Diagnostic[]): Formatters {
  let locale = o.locale ?? 'en-US';
  try {
    new Intl.DateTimeFormat(locale);
  } catch {
    diagnostics.push({ code: 'LOCALE_FALLBACK', severity: 'warning', message: `Unsupported locale "${locale}"; using en-US.`, pos: 0 });
    locale = 'en-US';
  }
  const zone = (() => {
    try { new Intl.DateTimeFormat(locale, { timeZone: o.timeZone ?? 'UTC' }); return o.timeZone ?? 'UTC'; } catch { return 'UTC'; }
  })();
  let moneyFmt: Intl.NumberFormat | null = null;
  if (o.currency) {
    try { moneyFmt = new Intl.NumberFormat(locale, { style: 'currency', currency: o.currency }); } catch { moneyFmt = null; }
  }
  return {
    money: (minor) => {
      if (!moneyFmt) return '';
      const digits = moneyFmt.resolvedOptions().maximumFractionDigits ?? 2;
      return moneyFmt.format(minor / 10 ** digits);
    },
    date: (iso) => {
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
      const d = new Date(dateOnly ? `${iso}T00:00:00Z` : iso);
      if (Number.isNaN(d.getTime())) return null;
      return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: dateOnly ? 'UTC' : zone }).format(d);
    },
  };
}

const has = (v: Values, k: string): boolean => Object.prototype.hasOwnProperty.call(v, k);
const present = (v: FieldValue): boolean =>
  typeof v === 'string' ? v.trim() !== '' : typeof v === 'number' ? Number.isFinite(v) : typeof v === 'boolean';

function truthy(v: FieldValue): boolean {
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  return v === true;
}

function emit(ctx: Ctx, out: string[], s: string): void {
  ctx.size += s.length;
  if (ctx.size > LIMITS.output) {
    if (!ctx.diagnostics.some((d) => d.code === 'TOO_LARGE' && d.pos === -1)) {
      ctx.diagnostics.push({ code: 'TOO_LARGE', severity: 'error', message: 'Rendered output is too large.', pos: -1 });
    }
    return;
  }
  out.push(s);
}

function renderVar(n: Extract<Node, { t: 'var' }>, ctx: Ctx): string {
  const def = ctx.fields.get(n.key);
  const bad = (code: DiagnosticCode, message: string): string => {
    ctx.diagnostics.push({ code, severity: 'error', message, pos: n.pos });
    return `⟦${n.key}⟧`;
  };
  if (!def) return bad('UNKNOWN_FIELD', `Unknown field "${n.key}".`);
  if (def.type === 'bool') return bad('WRONG_TYPE', `"${n.key}" is a yes/no field; use it in {{#if}}.`);
  const raw = has(ctx.values, n.key) ? ctx.values[n.key] : undefined;
  if (present(raw)) {
    if (def.type === 'money_cents') {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return bad('INVALID_VALUE', `"${n.key}" must be an integer amount in minor units.`);
      const s = ctx.fmt.money(raw);
      return s === '' ? bad('INVALID_VALUE', 'A valid currency code is required for money fields.') : s;
    }
    if (def.type === 'date') {
      const s = typeof raw === 'string' ? ctx.fmt.date(raw.trim()) : null;
      return s === null ? bad('INVALID_VALUE', `"${n.key}" is not a valid date.`) : s;
    }
    return String(raw).trim();
  }
  if (n.fb !== null && n.fb !== '') return n.fb;
  ctx.missing.add(n.key);
  return ctx.marker ? `⟦${n.key}⟧` : '';
}

function renderNodes(nodes: readonly Node[], ctx: Ctx, out: string[]): void {
  for (const n of nodes) {
    if (ctx.size > LIMITS.output) return;
    if (n.t === 'text') emit(ctx, out, n.v);
    else if (n.t === 'var') emit(ctx, out, renderVar(n, ctx));
    else if (n.t === 'clause') {
      if (ctx.inClause) {
        ctx.diagnostics.push({ code: 'NESTED_CLAUSE', severity: 'error', message: 'Clauses cannot include other clauses.', pos: n.pos });
        emit(ctx, out, `⟦clause:${n.slug}⟧`);
        continue;
      }
      const c = ctx.clauses.get(n.slug);
      if (!c) {
        ctx.diagnostics.push({ code: 'UNKNOWN_CLAUSE', severity: 'error', message: `Clause "${n.slug}" is not available.`, pos: n.pos });
        emit(ctx, out, `⟦clause:${n.slug}⟧`);
        continue;
      }
      ctx.used.set(c.slug, { slug: c.slug, version: c.version, sha256: c.sha256 });
      const sub: Diagnostic[] = [];
      const tree = parse(c.body, sub);
      for (const d of sub) ctx.diagnostics.push({ ...d, message: `[clause ${c.slug}] ${d.message}`, pos: n.pos });
      ctx.inClause = true;
      renderNodes(tree, ctx, out);
      ctx.inClause = false;
    } else {
      if (!ctx.fields.has(n.key)) {
        ctx.diagnostics.push({ code: 'UNKNOWN_FIELD', severity: 'error', message: `Unknown field "${n.key}".`, pos: n.pos });
        continue;
      }
      const raw = has(ctx.values, n.key) ? ctx.values[n.key] : undefined;
      let hit = n.op === 'truthy' ? truthy(raw) : n.op === 'eq' ? present(raw) && String(raw).trim() === n.lit : !(present(raw) && String(raw).trim() === n.lit);
      if (n.neg) hit = !hit;
      renderNodes(hit ? n.yes : n.no, ctx, out);
    }
  }
}

function collect(nodes: readonly Node[], keys: Set<string>): void {
  for (const n of nodes) {
    if (n.t === 'var') keys.add(n.key);
    else if (n.t === 'if') { keys.add(n.key); collect(n.yes, keys); collect(n.no, keys); }
  }
}

/** Field keys referenced by a template body (top level only; clause bodies are checked at render). */
export function extractFieldKeys(source: string): string[] {
  const keys = new Set<string>();
  collect(parse(source, []), keys);
  return [...keys].sort();
}

/** Syntax + field + clause validation without values (used by the editor and the publish gate). */
export function validateTemplate(source: string, opts: RenderOptions): Diagnostic[] {
  const r = renderTemplate(source, {}, { ...opts, onMissing: 'empty' });
  return r.diagnostics;
}

export function renderTemplate(source: string, values: Values, opts: RenderOptions): RenderResult {
  const diagnostics: Diagnostic[] = [];
  const tree = parse(source, diagnostics);
  const ctx: Ctx = {
    fields: new Map(opts.fields.map((f) => [f.key, f])),
    clauses: new Map((opts.clauses ?? []).map((c) => [c.slug, c])),
    values,
    fmt: makeFormatters(opts, diagnostics),
    missing: new Set(),
    used: new Map(),
    diagnostics,
    marker: (opts.onMissing ?? 'marker') === 'marker',
    size: 0,
    inClause: false,
  };
  const out: string[] = [];
  renderNodes(tree, ctx, out);
  const ok = !diagnostics.some((d) => d.severity === 'error');
  const missing = [...ctx.missing].sort();
  return { text: out.join(''), missing, usedClauses: [...ctx.used.values()], diagnostics, ok, complete: ok && missing.length === 0 };
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Slugs of clauses whose body no longer matches the hash recorded at publish time. */
export async function findTamperedClauses(clauses: readonly ClauseSnapshot[]): Promise<string[]> {
  const bad: string[] = [];
  for (const c of clauses) if ((await sha256Hex(c.body)) !== c.sha256.toLowerCase()) bad.push(c.slug);
  return bad;
}

/** Render only after verifying every clause snapshot; tampering is an error diagnostic. */
export async function renderTemplateVerified(source: string, values: Values, opts: RenderOptions): Promise<RenderResult> {
  const tampered = await findTamperedClauses(opts.clauses ?? []);
  const safe = (opts.clauses ?? []).filter((c) => !tampered.includes(c.slug));
  const r = renderTemplate(source, values, { ...opts, clauses: safe });
  for (const slug of tampered) {
    r.diagnostics.push({ code: 'CLAUSE_TAMPERED', severity: 'error', message: `Clause "${slug}" failed its integrity check.`, pos: 0 });
  }
  if (tampered.length) { r.ok = false; r.complete = false; }
  return r;
}
