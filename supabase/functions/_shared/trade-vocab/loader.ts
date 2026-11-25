// supabase/functions/_shared/trade-vocab/loader.ts
//
// Loads the latest PUBLISHED vocabulary snapshots for (trade, locale) with the service-role client and compiles them.
// Hot path (assistant-request): per-isolate cache, one query on a miss, FAIL-OPEN to "" on any problem. It never throws.
// Feature flag: TRADE_VOCAB_ENABLED=true. Default OFF -> loadTradeVocabularyContext() returns "" without touching the DB.

import {
  compileVocabulary, dialectCandidates, isValidTrade, mergeLayers, parseSnapshotEntries,
  DEFAULT_MAX_KEYTERMS, DEFAULT_MAX_PROMPT_CHARS, TRADE_VOCAB_FLAG, type CompiledVocabulary, type VocabEntry,
} from "./vocab.ts";

export interface VersionRow {
  trade: string;
  dialect: string;
  version: number;
  entries: unknown;
}

/** The slice of the Supabase query builder this module needs (keeps it testable without the SDK). */
export interface VocabDb {
  from(table: string): {
    select(cols: string): {
      in(col: string, vals: string[]): {
        in(col: string, vals: string[]): {
          order(col: string, o: { ascending: boolean }): {
            limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
          };
        };
      };
    };
  };
}

export interface LoaderEnv {
  get(name: string): string | undefined;
}

export interface LoaderDeps {
  env?: LoaderEnv;
  now?: () => number;
  /** Test hook: use a private cache instead of the module-level one. */
  cache?: Map<string, CacheEntry>;
}

interface CacheEntry {
  at: number;
  value: LoadedVocabulary | null;
}

export interface LoadedVocabulary extends CompiledVocabulary {
  versions: { trade: string; dialect: string; version: number }[];
}

export const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_KEYS = 64;
const moduleCache = new Map<string, CacheEntry>();

function defaultEnv(): LoaderEnv {
  const d = (globalThis as { Deno?: { env?: LoaderEnv } }).Deno;
  return d?.env ?? { get: () => undefined };
}

function intEnv(env: LoaderEnv, name: string, fallback: number): number {
  const n = Number(env.get(name));
  return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : fallback;
}

export function tradeVocabEnabled(env: LoaderEnv): boolean {
  return env.get(TRADE_VOCAB_FLAG) === "true";
}

/** Compiles the glossary for one tenant context, or null when nothing is published. Throws only on DB errors. */
export async function loadTradeVocabulary(
  db: VocabDb,
  input: { trade: string; locale: string | null | undefined },
  deps: LoaderDeps = {},
): Promise<LoadedVocabulary | null> {
  const env = deps.env ?? defaultEnv();
  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? moduleCache;
  const trade = isValidTrade(input.trade) ? input.trade : "general";
  const dialects = dialectCandidates(input.locale);
  const maxPromptChars = intEnv(env, "TRADE_VOCAB_MAX_PROMPT_CHARS", DEFAULT_MAX_PROMPT_CHARS);
  const maxKeyterms = intEnv(env, "TRADE_VOCAB_MAX_KEYTERMS", DEFAULT_MAX_KEYTERMS);

  const key = `${trade}|${dialects.join(",")}|${maxPromptChars}|${maxKeyterms}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;

  const trades = trade === "general" ? ["general"] : ["general", trade];
  const { data, error } = await db
    .from("trade_vocab_versions")
    .select("trade, dialect, version, entries")
    .in("trade", trades)
    .in("dialect", dialects)
    .order("version", { ascending: false })
    .limit(40);
  if (error) throw new Error(`trade_vocab_load_failed:${error.message}`);

  // Newest version per (trade, dialect).
  const latest = new Map<string, VersionRow>();
  for (const r of (Array.isArray(data) ? data : []) as VersionRow[]) {
    const k = `${r.trade}|${r.dialect}`;
    const cur = latest.get(k);
    if (!cur || r.version > cur.version) latest.set(k, r);
  }

  // Lowest priority first: general before trade; base language before the regional dialect.
  const baseFirst = [...dialects].reverse();
  const layers: VocabEntry[][] = [];
  const versions: LoadedVocabulary["versions"] = [];
  for (const t of trades) {
    for (const d of baseFirst) {
      const row = latest.get(`${t}|${d}`);
      if (!row) continue;
      layers.push(parseSnapshotEntries(row.entries));
      versions.push({ trade: t, dialect: d, version: row.version });
    }
  }

  const merged = mergeLayers(layers);
  const value: LoadedVocabulary | null =
    merged.length === 0 ? null : { ...compileVocabulary(merged, { maxPromptChars, maxKeyterms }), versions };

  if (cache.size >= CACHE_MAX_KEYS) cache.clear();
  cache.set(key, { at: now(), value });
  return value;
}

/** What vapi-webhook calls. Returns the {{trade_vocabulary}} text, or "" (flag off, nothing published, or any error). */
export async function loadTradeVocabularyContext(
  db: VocabDb,
  input: { trade: string; locale: string | null | undefined },
  deps: LoaderDeps = {},
): Promise<string> {
  const env = deps.env ?? defaultEnv();
  if (!tradeVocabEnabled(env)) return "";
  try {
    return (await loadTradeVocabulary(db, input, deps))?.promptContext ?? "";
  } catch (err) {
    console.error(JSON.stringify({ evt: "trade_vocab_failed", error: err instanceof Error ? err.message : String(err) }));
    return "";
  }
}

export function resetTradeVocabCache(): void {
  moduleCache.clear();
}
