import { describe, expect, it } from "vitest";
import { loadTradeVocabulary, loadTradeVocabularyContext, tradeVocabEnabled, type LoaderEnv, type VocabDb } from "./loader.ts";

function env(vars: Record<string, string>): LoaderEnv {
  return { get: (n) => vars[n] };
}

/** Records every query and returns canned rows. */
function fakeDb(rows: unknown, error: { message: string } | null = null) {
  const calls: { table: string; cols: string; filters: [string, string[]][] }[] = [];
  const db: VocabDb = {
    from(table) {
      const call = { table, cols: "", filters: [] as [string, string[]][] };
      calls.push(call);
      return {
        select(cols) {
          call.cols = cols;
          return {
            in(c1, v1) {
              call.filters.push([c1, v1]);
              return {
                in(c2, v2) {
                  call.filters.push([c2, v2]);
                  return { order: () => ({ limit: async () => ({ data: rows, error }) }) };
                },
              };
            },
          };
        },
      };
    },
  };
  return { db, calls };
}

const row = (trade: string, dialect: string, version: number, entries: unknown[]) => ({ trade, dialect, version, entries });

describe("tradeVocabEnabled", () => {
  it("is off unless the flag is exactly 'true'", () => {
    expect(tradeVocabEnabled(env({}))).toBe(false);
    expect(tradeVocabEnabled(env({ TRADE_VOCAB_ENABLED: "1" }))).toBe(false);
    expect(tradeVocabEnabled(env({ TRADE_VOCAB_ENABLED: "true" }))).toBe(true);
  });
});

describe("loadTradeVocabularyContext", () => {
  it("returns '' and does not query when the flag is off", async () => {
    const { db, calls } = fakeDb([]);
    expect(await loadTradeVocabularyContext(db, { trade: "hvac", locale: "en-US" }, { env: env({}), cache: new Map() })).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("fails open to '' on a database error", async () => {
    const { db } = fakeDb(null, { message: "boom" });
    const out = await loadTradeVocabularyContext(db, { trade: "hvac", locale: "en-US" }, { env: env({ TRADE_VOCAB_ENABLED: "true" }), cache: new Map() });
    expect(out).toBe("");
  });

  it("returns '' when nothing is published", async () => {
    const { db } = fakeDb([]);
    expect(await loadTradeVocabularyContext(db, { trade: "hvac", locale: "en-US" }, { env: env({ TRADE_VOCAB_ENABLED: "true" }), cache: new Map() })).toBe("");
  });
});

describe("loadTradeVocabulary", () => {
  const on = env({ TRADE_VOCAB_ENABLED: "true" });

  it("asks only for the tenant's trade + general and its dialect + base language", async () => {
    const { db, calls } = fakeDb([]);
    await loadTradeVocabulary(db, { trade: "hvac", locale: "en-GB" }, { env: on, cache: new Map() });
    expect(calls[0].table).toBe("trade_vocab_versions");
    expect(calls[0].filters).toEqual([["trade", ["general", "hvac"]], ["dialect", ["en-GB", "en"]]]);
  });

  it("uses only 'general' for an unknown trade value", async () => {
    const { db, calls } = fakeDb([]);
    await loadTradeVocabulary(db, { trade: "Bad Trade!", locale: "en-US" }, { env: on, cache: new Map() });
    expect(calls[0].filters[0]).toEqual(["trade", ["general"]]);
  });

  it("takes the newest version per scope and lets specific layers override general ones", async () => {
    const { db } = fakeDb([
      row("hvac", "en-US", 2, [{ term: "Furnace", synonyms: ["heater"] }]),
      row("hvac", "en-US", 1, [{ term: "Furnace", synonyms: ["STALE"] }]),
      row("general", "en", 1, [{ term: "Furnace", synonyms: ["generic"] }, { term: "Invoice" }]),
    ]);
    const v = await loadTradeVocabulary(db, { trade: "hvac", locale: "en-US" }, { env: on, cache: new Map() });
    expect(v?.promptContext).toContain("- Furnace (also: heater)");
    expect(v?.promptContext).not.toContain("STALE");
    expect(v?.promptContext).not.toContain("generic");
    expect(v?.promptContext).toContain("- Invoice");
    expect(v?.versions).toEqual([{ trade: "general", dialect: "en", version: 1 }, { trade: "hvac", dialect: "en-US", version: 2 }]);
  });

  it("ignores unsafe entries in a snapshot", async () => {
    const { db } = fakeDb([row("general", "en", 1, [{ term: "{{security_ref}}" }, { term: "Valve" }])]);
    const v = await loadTradeVocabulary(db, { trade: "general", locale: "en" }, { env: on, cache: new Map() });
    expect(v?.promptContext).not.toContain("{{");
    expect(v?.promptContext).toContain("- Valve");
  });

  it("serves repeat calls from the cache until the TTL passes", async () => {
    const { db, calls } = fakeDb([row("general", "en", 1, [{ term: "Valve" }])]);
    const cache = new Map();
    let t = 1_000;
    const deps = { env: on, cache, now: () => t };
    await loadTradeVocabulary(db, { trade: "general", locale: "en" }, deps);
    await loadTradeVocabulary(db, { trade: "general", locale: "en" }, deps);
    expect(calls).toHaveLength(1);
    t += 5 * 60_000 + 1;
    await loadTradeVocabulary(db, { trade: "general", locale: "en" }, deps);
    expect(calls).toHaveLength(2);
  });

  it("respects the prompt-size env override", async () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ term: `Term ${String(i).padStart(2, "0")}`, synonyms: ["alias"] }));
    const { db } = fakeDb([row("general", "en", 1, entries)]);
    const v = await loadTradeVocabulary(db, { trade: "general", locale: "en" }, { env: env({ TRADE_VOCAB_ENABLED: "true", TRADE_VOCAB_MAX_PROMPT_CHARS: "400" }), cache: new Map() });
    expect(v?.promptContext.length).toBeLessThanOrEqual(400);
    expect(v?.truncated).toBe(true);
  });
});
