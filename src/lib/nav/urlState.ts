// Typed URL-state codecs. Pure: no React, no router.
// Rules: invalid values degrade to the default; defaults are omitted from the
// URL; unchanged writes are no-ops (no history spam); `history: 'push'` only
// for params that represent a place to go back to (tab, selected record,
// open drawer, page), everything else replaces.

export interface Codec<T> {
  readonly default: T;
  readonly history: 'push' | 'replace';
  /** Other params reset to their default when this one changes (e.g. page). */
  readonly resets: readonly string[];
  parse(raw: string | null): T | null; // null = absent/invalid -> default
  serialize(value: T): string | null; // null = remove param
}

export type UrlSchema = Record<string, Codec<unknown>>;
export type UrlStateOf<S extends UrlSchema> = { [K in keyof S]: S[K] extends Codec<infer T> ? T : never };

interface CodecOpts {
  history?: 'push' | 'replace';
  resets?: readonly string[];
}

const mk = <T>(
  def: T,
  parse: (raw: string | null) => T | null,
  serialize: (v: T) => string | null,
  o: CodecOpts = {},
): Codec<T> => ({ default: def, history: o.history ?? 'replace', resets: o.resets ?? [], parse, serialize });

export const codec = {
  string(def = '', o?: CodecOpts & { maxLength?: number }): Codec<string> {
    const max = o?.maxLength ?? 200;
    return mk(
      def,
      (raw) => (raw === null ? null : raw.slice(0, max)),
      (v) => (v === '' ? null : v.slice(0, max)),
      o,
    );
  },
  int(def: number, o: CodecOpts & { min?: number; max?: number } = {}): Codec<number> {
    const { min = 0, max = Number.MAX_SAFE_INTEGER } = o;
    return mk(
      def,
      (raw) => {
        if (raw === null || !/^-?\d+$/.test(raw)) return null;
        const n = Number(raw);
        return n >= min && n <= max ? n : null;
      },
      (v) => String(v),
      o,
    );
  },
  bool(def = false, o?: CodecOpts): Codec<boolean> {
    return mk(def, (raw) => (raw === '1' ? true : raw === '0' ? false : null), (v) => (v ? '1' : '0'), o);
  },
  oneOf<const V extends readonly string[]>(values: V, def: V[number], o?: CodecOpts): Codec<V[number]> {
    return mk<V[number]>(def, (raw) => (raw !== null && (values as readonly string[]).includes(raw) ? raw : null), (v) => v, o);
  },
  list(def: readonly string[] = [], o?: CodecOpts & { maxItems?: number }): Codec<readonly string[]> {
    const maxItems = o?.maxItems ?? 25;
    return mk<readonly string[]>(
      def,
      (raw) => (raw === null || raw === '' ? null : raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, maxItems)),
      (v) => (v.length === 0 ? null : v.join(',')),
      o,
    );
  },
  /** ISO date (YYYY-MM-DD), validated as a real calendar date. */
  date(def = '', o?: CodecOpts): Codec<string> {
    return mk(
      def,
      (raw) => {
        if (raw === null || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
        const d = new Date(`${raw}T00:00:00Z`);
        return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? null : raw;
      },
      (v) => (v === '' ? null : v),
      o,
    );
  },
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function readUrlState<S extends UrlSchema>(schema: S, params: URLSearchParams): UrlStateOf<S> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    const c = schema[key]!;
    const parsed = c.parse(params.get(key));
    out[key] = parsed === null ? c.default : parsed;
  }
  return out as UrlStateOf<S>;
}

export interface WriteResult {
  params: URLSearchParams;
  changed: boolean;
  history: 'push' | 'replace';
}

export function writeUrlState<S extends UrlSchema>(
  schema: S,
  current: URLSearchParams,
  patch: Partial<UrlStateOf<S>>,
): WriteResult {
  const next = new URLSearchParams(current);
  const before = readUrlState(schema, current) as Record<string, unknown>;
  let history: 'push' | 'replace' = 'replace';
  const apply = (key: string, value: unknown) => {
    const c = schema[key]!;
    const serialized = same(value, c.default) ? null : c.serialize(value);
    if (serialized === null) next.delete(key);
    else next.set(key, serialized);
  };

  for (const [key, value] of Object.entries(patch)) {
    const c = schema[key];
    if (!c || value === undefined) continue; // unknown keys never touch the URL
    if (same(value, before[key])) continue;
    apply(key, value);
    if (c.history === 'push') history = 'push';
    for (const dep of c.resets) {
      const d = schema[dep];
      if (d && !(dep in patch)) apply(dep, d.default);
    }
  }
  return { params: next, changed: next.toString() !== current.toString(), history };
}
