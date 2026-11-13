// Pure model for typed URL (query-string) state. No React, no router imports.
// Used by src/hooks/useUrlState.ts.
//
// Rules:
//  - invalid / out-of-range values degrade to the codec default
//  - defaults are omitted from the URL
//  - a write that changes nothing reports `changed: false` (history is never touched)
//  - refinements (search, sort, ...) `replace`; places (page, tab, ...) `push`
//  - `resets` lists other keys that fall back to default when this key changes
//  - unrelated params are preserved, unknown keys in a patch are ignored

export type HistoryMode = 'push' | 'replace';

export interface Codec<T> {
  readonly default: T;
  /** Never throws: anything invalid returns `default`. */
  parse(raw: string | null): T;
  /** `null` means "omit from the URL" (value equals default, or is invalid). */
  serialize(value: T): string | null;
  readonly history: HistoryMode;
  readonly resets: readonly string[];
}

export interface CodecOptions {
  resets?: readonly string[];
  history?: HistoryMode;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UrlSchema = Record<string, Codec<any>>;

export type UrlStateOf<S extends UrlSchema> = {
  [K in keyof S]: S[K] extends Codec<infer T> ? T : never;
};

export interface SortValue<K extends string = string> {
  key: K;
  dir: 'asc' | 'desc';
}

const MAX_STRING_LENGTH = 200;

function base(opts: CodecOptions | undefined): Pick<Codec<unknown>, 'history' | 'resets'> {
  return { history: opts?.history ?? 'replace', resets: opts?.resets ?? [] };
}

function isRealDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [y, m, d] = raw.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export const codec = {
  string(def: string, opts?: CodecOptions & { maxLength?: number }): Codec<string> {
    const max = opts?.maxLength ?? MAX_STRING_LENGTH;
    return {
      default: def,
      ...base(opts),
      parse: (raw) => (raw === null ? def : raw.slice(0, max)),
      serialize: (v) => (typeof v !== 'string' || v === def ? null : v.slice(0, max)),
    };
  },

  int(def: number, opts?: CodecOptions & { min?: number; max?: number }): Codec<number> {
    const min = opts?.min ?? Number.MIN_SAFE_INTEGER;
    const max = opts?.max ?? Number.MAX_SAFE_INTEGER;
    const ok = (n: number) => Number.isInteger(n) && n >= min && n <= max;
    return {
      default: def,
      ...base(opts),
      parse: (raw) => {
        if (raw === null || !/^-?\d{1,15}$/.test(raw)) return def;
        const n = Number(raw);
        return ok(n) ? n : def;
      },
      serialize: (v) => (typeof v !== 'number' || !ok(v) || v === def ? null : String(v)),
    };
  },

  bool(def: boolean, opts?: CodecOptions): Codec<boolean> {
    return {
      default: def,
      ...base(opts),
      parse: (raw) => (raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : def),
      serialize: (v) => (typeof v !== 'boolean' || v === def ? null : v ? '1' : '0'),
    };
  },

  oneOf<V extends string>(values: readonly V[], def: V, opts?: CodecOptions): Codec<V> {
    const allowed = new Set<string>(values);
    return {
      default: def,
      ...base(opts),
      parse: (raw) => (raw !== null && allowed.has(raw) ? (raw as V) : def),
      serialize: (v) => (typeof v !== 'string' || !allowed.has(v) || v === def ? null : v),
    };
  },

  /** Calendar date as YYYY-MM-DD ('' = none). Impossible dates like 2026-02-31 are invalid. */
  date(def: string, opts?: CodecOptions): Codec<string> {
    return {
      default: def,
      ...base(opts),
      parse: (raw) => (raw !== null && isRealDate(raw) ? raw : def),
      serialize: (v) => (typeof v !== 'string' || !isRealDate(v) || v === def ? null : v),
    };
  },

  /** `key:dir` (dir defaults to asc). Keys must be in `allowed`. `null` = no sort. */
  sort<K extends string>(allowed: readonly K[], def: SortValue<K> | null, opts?: CodecOptions): Codec<SortValue<K> | null> {
    const keys = new Set<string>(allowed);
    const same = (a: SortValue<K> | null, b: SortValue<K> | null) =>
      a === b || (a !== null && b !== null && a.key === b.key && a.dir === b.dir);
    return {
      default: def,
      ...base(opts),
      parse: (raw) => {
        if (raw === null) return def;
        const parts = raw.split(':');
        if (parts.length > 2) return def;
        const [key, dirRaw] = parts as [string, string | undefined];
        if (!keys.has(key)) return def;
        const dir = dirRaw === undefined ? 'asc' : dirRaw;
        if (dir !== 'asc' && dir !== 'desc') return def;
        return { key: key as K, dir };
      },
      serialize: (v) => {
        if (v === null || typeof v !== 'object' || !keys.has(v.key) || (v.dir !== 'asc' && v.dir !== 'desc')) return null;
        return same(v, def) ? null : `${v.key}:${v.dir}`;
      },
    };
  },
};

export function readUrlState<S extends UrlSchema>(schema: S, params: URLSearchParams): UrlStateOf<S> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) out[key] = schema[key]!.parse(params.get(key));
  return out as UrlStateOf<S>;
}

export interface UrlWriteResult {
  params: URLSearchParams;
  changed: boolean;
  history: HistoryMode;
}

const equal = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export function writeUrlState<S extends UrlSchema>(
  schema: S,
  current: URLSearchParams,
  patch: Partial<UrlStateOf<S>>,
): UrlWriteResult {
  const next = new URLSearchParams(current);
  const patchKeys = Object.keys(patch).filter((k) => Object.prototype.hasOwnProperty.call(schema, k));
  const explicit = new Set(patchKeys);
  let changed = false;
  let history: HistoryMode = 'replace';

  const apply = (key: string, serialized: string | null) => {
    if (serialized === null) next.delete(key);
    else next.set(key, serialized);
  };

  for (const key of patchKeys) {
    const c = schema[key]!;
    const before = c.parse(current.get(key));
    const serialized = c.serialize((patch as Record<string, unknown>)[key]);
    const after = c.parse(serialized);
    if (equal(before, after)) continue; // no real change: leave the URL alone
    apply(key, serialized);
    changed = true;
    if (c.history === 'push') history = 'push';
    for (const dep of c.resets) {
      if (explicit.has(dep) || !Object.prototype.hasOwnProperty.call(schema, dep)) continue;
      if (next.has(dep)) next.delete(dep);
    }
  }

  return { params: next, changed, history };
}
