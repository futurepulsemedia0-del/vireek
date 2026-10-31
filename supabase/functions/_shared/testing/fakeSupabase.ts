// In-memory stand-in for supabase-js, used ONLY by edge-function tests.
// It models the PostgREST semantics the functions rely on (filters, NULL comparisons, upsert ignoreDuplicates,
// single/maybeSingle, RPC handlers) and records every call so tests can assert tenant scoping.
// It is a MODEL of PostgREST, not the real thing: DB-level guarantees (RLS, constraints, RPC bodies) are covered by
// supabase/tests/database/*.test.sql, not here.

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-this-alias */
export type Row = Record<string, any>;
export type Op = 'select' | 'insert' | 'upsert' | 'update' | 'delete' | 'rpc';
export type FilterDesc = [col: string, op: string, value: unknown];

export interface Call {
  table: string; // rpc name for op === 'rpc'
  op: Op;
  filters: FilterDesc[];
  payload?: any;
  options?: any;
  selectCols?: string;
}

export interface Failure {
  table?: string;
  rpc?: string;
  op?: Op;
  /** 'error' (default) returns { error }; 'throw' rejects like a network failure. */
  mode?: 'error' | 'throw';
  error?: { message: string; code?: string };
  /** How many matching calls fail; default: forever. */
  times?: number;
  when?: (call: Call) => boolean;
}

type RpcHandler = (args: any, db: FakeDb) => any;

const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
function cmp(a: any, b: any): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null; // SQL NULL: comparison is unknown
  if (isIso(a) && isIso(b)) return Date.parse(a) - Date.parse(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function leaf(col: string, op: string, raw: string): (r: Row) => boolean {
  const val: any = raw === 'null' ? null : raw;
  switch (op) {
    case 'eq': return (r) => String(r[col]) === String(val);
    case 'neq': return (r) => r[col] !== null && r[col] !== undefined && String(r[col]) !== String(val);
    case 'lt': return (r) => { const c = cmp(r[col], val); return c !== null && c < 0; };
    case 'lte': return (r) => { const c = cmp(r[col], val); return c !== null && c <= 0; };
    case 'gt': return (r) => { const c = cmp(r[col], val); return c !== null && c > 0; };
    case 'gte': return (r) => { const c = cmp(r[col], val); return c !== null && c >= 0; };
    case 'is': return (r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === (val === 'true'));
    default: throw new Error(`fakeSupabase: unsupported or-operator ${op}`);
  }
}

/** Parses PostgREST `or=` syntax, e.g. "status.eq.failed,and(status.eq.sending,updated_at.lt.X)". */
export function parseOr(expr: string): (r: Row) => boolean {
  const parts = splitTop(expr).map((p): ((r: Row) => boolean) => {
    const andM = p.match(/^and\((.*)\)$/);
    if (andM) {
      const subs = splitTop(andM[1]).map((q) => parseOr(q));
      return (r) => subs.every((f) => f(r));
    }
    const m = p.match(/^([^.]+)\.([^.]+)\.(.*)$/);
    if (!m) throw new Error(`fakeSupabase: cannot parse or-term "${p}"`);
    return leaf(m[1], m[2], m[3]);
  });
  return (r) => parts.some((f) => f(r));
}

function parseInList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return String(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
}

let idSeq = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;

class Builder implements PromiseLike<{ data: any; error: any }> {
  private op: Op = 'select';
  private preds: Array<(r: Row) => boolean> = [];
  private filters: FilterDesc[] = [];
  private payload: any;
  private options: any;
  private cols = '*';
  private returning = false;
  private orderBy: Array<[string, boolean]> = [];
  private lim: number | null = null;
  private rng: [number, number] | null = null;
  private mode: 'many' | 'single' | 'maybe' = 'many';

  constructor(private db: FakeDb, private table: string) {}

  select(cols = '*') { this.cols = cols; if (this.op !== 'select') this.returning = true; return this; }
  insert(p: any) { this.op = 'insert'; this.payload = p; return this; }
  upsert(p: any, o?: any) { this.op = 'upsert'; this.payload = p; this.options = o ?? {}; return this; }
  update(p: any) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }

  private f(col: string, op: string, value: unknown, pred: (r: Row) => boolean) { this.filters.push([col, op, value]); this.preds.push(pred); return this; }
  eq(c: string, v: unknown) { return this.f(c, 'eq', v, (r) => r[c] === v || (r[c] !== null && r[c] !== undefined && v !== null && String(r[c]) === String(v))); }
  neq(c: string, v: unknown) { return this.f(c, 'neq', v, (r) => r[c] !== null && r[c] !== undefined && r[c] !== v); }
  in(c: string, vs: unknown[]) { return this.f(c, 'in', vs, (r) => vs.map(String).includes(String(r[c]))); }
  is(c: string, v: unknown) { return this.f(c, 'is', v, (r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); }
  not(c: string, op: string, v: unknown) {
    return this.f(c, `not.${op}`, v, (r) => {
      if (op === 'is') return v === null ? r[c] !== null && r[c] !== undefined : r[c] !== v;
      if (op === 'in') return !parseInList(v).includes(String(r[c]));
      if (op === 'eq') return r[c] !== v;
      throw new Error(`fakeSupabase: unsupported not.${op}`);
    });
  }
  lt(c: string, v: any) { return this.f(c, 'lt', v, (r) => { const k = cmp(r[c], v); return k !== null && k < 0; }); }
  lte(c: string, v: any) { return this.f(c, 'lte', v, (r) => { const k = cmp(r[c], v); return k !== null && k <= 0; }); }
  gt(c: string, v: any) { return this.f(c, 'gt', v, (r) => { const k = cmp(r[c], v); return k !== null && k > 0; }); }
  gte(c: string, v: any) { return this.f(c, 'gte', v, (r) => { const k = cmp(r[c], v); return k !== null && k >= 0; }); }
  or(expr: string) { return this.f('', 'or', expr, parseOr(expr)); }
  order(c: string, o?: { ascending?: boolean }) { this.orderBy.push([c, o?.ascending !== false]); return this; }
  limit(n: number) { this.lim = n; return this; }
  range(a: number, b: number) { this.rng = [a, b]; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  single() { this.mode = 'single'; return this; }

  then<R1 = any, R2 = never>(ok?: ((v: { data: any; error: any }) => R1 | PromiseLike<R1>) | null, bad?: ((e: unknown) => R2 | PromiseLike<R2>) | null) {
    return this.exec().then(ok, bad);
  }

  private project(rows: Row[]): Row[] {
    if (this.cols === '*' || this.cols.includes('(')) return rows.map((r) => ({ ...r }));
    const names = this.cols.split(',').map((s) => s.trim()).filter(Boolean);
    return rows.map((r) => Object.fromEntries(names.map((n) => [n, r[n]])));
  }

  private async exec(): Promise<{ data: any; error: any }> {
    const call: Call = { table: this.table, op: this.op, filters: [...this.filters], payload: this.payload, options: this.options, selectCols: this.cols };
    this.db.log.push(call);
    const injected = this.db.takeFailure(call);
    if (injected) {
      if (injected.mode === 'throw') throw new Error(injected.error?.message ?? 'network down');
      return { data: null, error: injected.error ?? { message: 'injected failure' } };
    }
    const rows = this.db.rows(this.table);
    const matched = () => rows.filter((r) => this.preds.every((p) => p(r)));
    let out: Row[] = [];
    let error: any = null;

    if (this.op === 'select') {
      out = matched();
      for (const [c, asc] of [...this.orderBy].reverse()) out.sort((a, b) => ((cmp(a[c], b[c]) ?? 0) * (asc ? 1 : -1)));
      if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim !== null) out = out.slice(0, this.lim);
      out = this.project(out);
    } else if (this.op === 'insert' || this.op === 'upsert') {
      const list: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload];
      const keyCols: string[] | null = this.op === 'upsert' && this.options?.onConflict ? String(this.options.onConflict).split(',').map((s) => s.trim()) : null;
      for (const p of list) {
        const existing = keyCols ? rows.find((r) => keyCols.every((k) => r[k] === p[k])) : undefined;
        if (existing) {
          if (!this.options?.ignoreDuplicates) { Object.assign(existing, p); out.push({ ...existing }); }
          continue;
        }
        const uniq = this.db.uniques[this.table];
        if (uniq && rows.some((r) => uniq.every((k) => r[k] === p[k]))) { error = { message: `duplicate key value violates unique constraint on ${this.table}`, code: '23505' }; break; }
        const row = { id: nextId(), ...p };
        rows.push(row);
        out.push({ ...row });
      }
      out = this.returning || this.mode !== 'many' ? this.project(out) : [];
    } else if (this.op === 'update') {
      const hit = matched();
      for (const r of hit) Object.assign(r, this.payload);
      out = this.returning ? this.project(hit) : [];
    } else if (this.op === 'delete') {
      const hit = matched();
      this.db.tables[this.table] = rows.filter((r) => !hit.includes(r));
      out = this.returning ? this.project(hit) : [];
    }

    if (error) return { data: null, error };
    const wantsRows = this.op === 'select' || this.returning || this.mode !== 'many';
    if (this.mode === 'single') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
    if (this.mode === 'maybe') return out.length > 1 ? { data: null, error: { message: 'multiple rows', code: 'PGRST116' } } : { data: out[0] ?? null, error: null };
    return { data: wantsRows ? out : null, error: null };
  }
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  log: Call[] = [];
  uniques: Record<string, string[]> = {};
  rpcHandlers: Record<string, RpcHandler> = {};
  /** bearer token -> user */
  users: Record<string, { id: string; email?: string | null }> = {};
  files: Record<string, Uint8Array> = {};
  clients: Array<{ url: string; key: string; headers?: Record<string, string> }> = [];
  private failures: Failure[] = [];

  rows(table: string): Row[] { return (this.tables[table] ??= []); }
  seed(table: string, rows: Row[]) { this.rows(table).push(...rows.map((r) => ({ ...r }))); return this; }
  failOn(f: Failure) { this.failures.push({ ...f }); return this; }
  clearFailures() { this.failures = []; }

  takeFailure(call: Call): Failure | null {
    for (const f of this.failures) {
      if (f.op && f.op !== call.op) continue;
      if (f.table && f.table !== call.table) continue;
      if (f.rpc && !(call.op === 'rpc' && call.table === f.rpc)) continue;
      if (f.when && !f.when(call)) continue;
      if (f.times !== undefined) { if (f.times <= 0) continue; f.times--; }
      return f;
    }
    return null;
  }

  calls(table: string, op?: Op) { return this.log.filter((c) => c.table === table && (!op || c.op === op)); }
  rpcCalls(name: string) { return this.log.filter((c) => c.op === 'rpc' && c.table === name); }
  has(call: Call, col: string, value: unknown) { return call.filters.some(([c, o, v]) => c === col && o === 'eq' && v === value); }

  from(table: string) { return new Builder(this, table); }

  rpc(name: string, args: any = {}) {
    const call: Call = { table: name, op: 'rpc', filters: [], payload: args };
    this.log.push(call);
    const db = this;
    const run = async () => {
      const injected = db.takeFailure(call);
      if (injected) {
        if (injected.mode === 'throw') throw new Error(injected.error?.message ?? 'network down');
        return { data: null, error: injected.error ?? { message: 'injected failure' } };
      }
      const h = db.rpcHandlers[name];
      if (!h) return { data: null, error: null };
      const r = h(args, db);
      return r && typeof r === 'object' && ('data' in r || 'error' in r) ? { data: r.data ?? null, error: r.error ?? null } : { data: r ?? null, error: null };
    };
    return { then: (ok: any, bad: any) => run().then(ok, bad) } as PromiseLike<{ data: any; error: any }>;
  }

  /** What the mocked `createClient` returns. Auth is resolved from the bearer token (explicit or via global headers). */
  createClient = (url: string, key: string, opts?: any) => {
    const headers = opts?.global?.headers as Record<string, string> | undefined;
    this.clients.push({ url, key, headers });
    const resolve = (jwt?: string) => {
      const token = (jwt ?? headers?.Authorization ?? '').replace(/^Bearer\s+/i, '');
      const user = this.users[token];
      return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } };
    };
    return {
      from: (t: string) => this.from(t),
      rpc: (n: string, a?: any) => this.rpc(n, a),
      auth: { getUser: async (jwt?: string) => resolve(jwt) },
      storage: {
        from: () => ({
          download: async (path: string) => {
            const f = this.files[path];
            return f ? { data: { arrayBuffer: async () => f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) }, error: null } : { data: null, error: { message: 'not found' } };
          },
        }),
      },
    };
  };
}
