// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  CircuitBreaker, RetryExhausted, TokenManager, callWithRetry, deriveHealth, reconcile, resolveConflict, runIncrementalSync,
  type CheckpointStore, type Deps, type ExternalRecord, type LocalRecord, type Page, type SyncSink, type Token, type TokenStore,
} from "./kernel.ts";

function clock(start = 1_000_000): Deps & { t: number; sleeps: number[] } {
  const c = { t: start, sleeps: [] as number[], now: () => c.t, sleep: async (ms: number) => { c.sleeps.push(ms); c.t += ms; }, random: () => 0.5 };
  return c;
}
const resp = (status: number, headers: Record<string, string> = {}) => ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });

describe("callWithRetry (fake provider)", () => {
  it("429 with Retry-After waits exactly that long, then succeeds", async () => {
    const c = clock(); const seq = [resp(429, { "retry-after": "7" }), resp(200)];
    const r = await callWithRetry(async () => seq.shift()!, c);
    expect(r.status).toBe(200);
    expect(c.sleeps).toEqual([7000]);
  });
  it("5xx burst then recovery uses capped exponential jittered waits", async () => {
    const c = clock(); const seq = [resp(503), resp(500), resp(502), resp(200)];
    await callWithRetry(async () => seq.shift()!, c);
    expect(c.sleeps.length).toBe(3);
    expect(c.sleeps[1]).toBeGreaterThanOrEqual(c.sleeps[0]);
  });
  it("network errors are retried; exhaustion throws RetryExhausted; 4xx is returned immediately", async () => {
    const c = clock(); let n = 0;
    await expect(callWithRetry(async () => { n++; throw new Error("ECONNRESET"); }, c)).rejects.toThrow("retry_exhausted");
    expect(n).toBe(5);
    const c2 = clock(); let m = 0;
    const r = await callWithRetry(async () => { m++; return resp(404); }, c2);
    expect(r.status).toBe(404); expect(m).toBe(1); expect(c2.sleeps).toEqual([]);
    expect(new RetryExhausted(null)).toBeTruthy();
  });
  it("absurd Retry-After is capped", async () => {
    const c = clock(); const seq = [resp(429, { "retry-after": "86400" }), resp(200)];
    await callWithRetry(async () => seq.shift()!, c);
    expect(c.sleeps[0]).toBe(120_000);
  });
});

function tokenWorld(c: Deps) {
  let tok: Token = { accessToken: "A0", refreshToken: "R0", expiresAt: c.now() + 1000 };
  let lockedUntil = 0; let refreshes = 0; let rot = 0;
  const store: TokenStore = {
    load: async () => ({ ...tok }), save: async (_c, t) => { tok = { ...t }; },
    tryLock: async (_c, lease) => { if (lockedUntil > c.now()) return false; lockedUntil = c.now() + lease; return true; },
    unlock: async () => { lockedUntil = 0; },
  };
  const refresh = async (rt: string): Promise<Token> => {
    refreshes++;
    if (rt !== `R${rot}`) throw new Error("invalid_grant: refresh token already rotated"); // provider rotates refresh tokens
    await c.sleep(50); rot++;
    return { accessToken: `A${rot}`, refreshToken: `R${rot}`, expiresAt: c.now() + 3_600_000 };
  };
  return { store, refresh, count: () => refreshes, current: () => tok };
}

describe("TokenManager", () => {
  it("token expiring mid-sync: 25 concurrent callers trigger exactly ONE refresh (single-flight)", async () => {
    const c = clock(); const w = tokenWorld(c);
    const tm = new TokenManager(w.store, c, w.refresh);
    const got = await Promise.all(Array.from({ length: 25 }, () => tm.get("conn")));
    expect(w.count()).toBe(1);
    expect(new Set(got.map((t) => t.accessToken))).toEqual(new Set(["A1"]));
  });
  it("two separate instances (cross-instance race) still refresh once and never burn a rotated refresh token", async () => {
    const c = clock(); const w = tokenWorld(c);
    const a = new TokenManager(w.store, c, w.refresh); const b = new TokenManager(w.store, c, w.refresh);
    const [x, y] = await Promise.all([a.get("conn"), b.get("conn")]);
    expect(w.count()).toBe(1);
    expect(x.accessToken).toBe(y.accessToken);
  });
  it("a 401 on a token that looks valid forces a refresh of exactly that token", async () => {
    const c = clock(); const w = tokenWorld(c);
    (w.current() as Token).expiresAt = c.now() + 10_000_000;
    const tm = new TokenManager(w.store, c, w.refresh);
    const t = await tm.get("conn", "A0");
    expect(t.accessToken).toBe("A1");
    const again = await tm.get("conn", "A0"); // stale 401 from a slower request: no second refresh
    expect(again.accessToken).toBe("A1"); expect(w.count()).toBe(1);
  });
  it("revoked grant surfaces and releases the lock", async () => {
    const c = clock(); const w = tokenWorld(c);
    const tm = new TokenManager(w.store, c, async () => { throw new Error("auth_revoked"); });
    await expect(tm.get("conn")).rejects.toThrow("auth_revoked");
    expect(await w.store.tryLock("conn", 1000)).toBe(true);
  });
});

describe("CircuitBreaker", () => {
  it("opens after threshold, allows one half-open probe after cooldown, closes on success", () => {
    const c = clock(); const b = new CircuitBreaker(c, 3, 60_000);
    b.failure(); b.failure(); expect(b.canCall()).toBe(true); b.failure();
    expect(b.status()).toBe("open"); expect(b.canCall()).toBe(false);
    c.t += 60_000;
    expect(b.canCall()).toBe(true); expect(b.canCall()).toBe(false); // single probe
    b.failure(); expect(b.status()).toBe("open");
    c.t += 60_000; expect(b.canCall()).toBe(true); b.success(); expect(b.status()).toBe("closed");
  });
});

// ---- fake upstream + local store
const rec = (id: string, updatedAt: number, extra: Partial<ExternalRecord> = {}): ExternalRecord => ({ externalId: id, updatedAt, data: { id, v: updatedAt }, ...extra });
function world() {
  const rows = new Map<string, LocalRecord & { data: unknown }>();
  let upsertCalls = 0; let cursor: string | null = null;
  const sink: SyncSink = {
    get: async (id) => rows.get(id) ?? null,
    upsert: async (r) => { upsertCalls++; const p = rows.get(r.externalId); rows.set(r.externalId, { externalId: r.externalId, updatedAt: r.updatedAt, localEditedAt: p?.localEditedAt ?? null, deleted: false, hash: JSON.stringify(r.data), data: r.data }); },
    tombstone: async (id, at) => { const p = rows.get(id); rows.set(id, { ...(p ?? { externalId: id, localEditedAt: null, hash: "", data: null }), updatedAt: at, deleted: true }); },
  };
  const checkpoint: CheckpointStore = { load: async () => cursor, save: async (c) => { cursor = c; } };
  return { rows, sink, checkpoint, upserts: () => upsertCalls, cursor: () => cursor };
}
const pager = (pages: Page[], failAt?: number) => { let calls = 0; return async (cur: string | null) => {
  const i = cur ? Number(cur) : 0; calls++;
  if (failAt === i && calls === failAt + 1) throw new Error("HTTP 500 on page");
  return pages[i];
}; };

describe("runIncrementalSync", () => {
  const pages: Page[] = [
    { items: [rec("a", 10), rec("b", 10)], nextCursor: "1" },
    { items: [rec("c", 10), rec("a", 12)], nextCursor: "2" },
    { items: [rec("d", 10)], nextCursor: null },
  ];
  it("applies everything once and checkpoints after each page", async () => {
    const w = world();
    const s = await runIncrementalSync({ fetchPage: pager(pages), sink: w.sink, checkpoint: w.checkpoint, policy: "external_wins" });
    expect(s.pages).toBe(3); expect(w.rows.size).toBe(4);
    expect(w.rows.get("a")!.updatedAt).toBe(12); expect(w.cursor()).toBeNull();
  });
  it("partial page failure: resume from checkpoint, no duplicates, same end state as a clean run", async () => {
    const clean = world(); await runIncrementalSync({ fetchPage: pager(pages), sink: clean.sink, checkpoint: clean.checkpoint, policy: "external_wins" });
    const w = world();
    await expect(runIncrementalSync({ fetchPage: pager(pages, 1), sink: w.sink, checkpoint: w.checkpoint, policy: "external_wins" })).rejects.toThrow("HTTP 500");
    expect(w.cursor()).toBe("1"); // page 0 committed, page 1 not
    await runIncrementalSync({ fetchPage: pager(pages), sink: w.sink, checkpoint: w.checkpoint, policy: "external_wins" });
    expect([...w.rows.values()].map((r) => [r.externalId, r.updatedAt])).toEqual([...clean.rows.values()].map((r) => [r.externalId, r.updatedAt]));
  });
  it("crash after upsert but before checkpoint: re-reading the page is a no-op (idempotent)", async () => {
    const w = world();
    await runIncrementalSync({ fetchPage: pager(pages), sink: w.sink, checkpoint: w.checkpoint, policy: "external_wins" });
    const before = w.upserts();
    await w.checkpoint.save(null);
    const s = await runIncrementalSync({ fetchPage: pager(pages), sink: w.sink, checkpoint: w.checkpoint, policy: "external_wins" });
    expect(w.upserts()).toBe(before); expect(s.upserted).toBe(0); expect(w.rows.size).toBe(4);
  });
  it("duplicated and reordered events: newest wins, stale replays are skipped", async () => {
    const w = world();
    const p: Page[] = [{ items: [rec("x", 20), rec("x", 10), rec("x", 20)], nextCursor: "1" }, { items: [rec("x", 15)], nextCursor: null }];
    const s = await runIncrementalSync({ fetchPage: pager(p), sink: w.sink, checkpoint: w.checkpoint, policy: "external_wins" });
    expect(w.rows.get("x")!.updatedAt).toBe(20);
    expect(s.skippedStale).toBe(1); expect(s.duplicates).toBeGreaterThanOrEqual(2); expect(w.upserts()).toBe(1);
  });
  it("deleted upstream becomes a tombstone, and an older upsert cannot resurrect it", async () => {
    const w = world();
    const p: Page[] = [{ items: [rec("z", 10)], nextCursor: "1" }, { items: [rec("z", 20, { deleted: true }), rec("z", 15)], nextCursor: null }];
    await runIncrementalSync({ fetchPage: pager(p), sink: w.sink, checkpoint: w.checkpoint, policy: "external_wins" });
    expect(w.rows.get("z")!.deleted).toBe(true);
  });
  it("schema drift: a malformed page fails loudly, the checkpoint does not advance and the breaker counts it", async () => {
    const w = world(); const b = new CircuitBreaker(clock(), 1, 60_000);
    const bad = async () => { throw new Error("schema_drift: missing field 'updatedAt'"); };
    await expect(runIncrementalSync({ fetchPage: bad, sink: w.sink, checkpoint: w.checkpoint, policy: "external_wins", breaker: b })).rejects.toThrow("schema_drift");
    expect(w.cursor()).toBeNull(); expect(b.status()).toBe("open");
    await expect(runIncrementalSync({ fetchPage: pager(pages), sink: w.sink, checkpoint: w.checkpoint, policy: "external_wins", breaker: b })).rejects.toThrow("circuit_open");
  });
  it("a looping cursor is detected", async () => {
    const w = world();
    const loop = async () => ({ items: [], nextCursor: "same" });
    await expect(runIncrementalSync({ fetchPage: loop, sink: w.sink, checkpoint: w.checkpoint, policy: "external_wins" })).rejects.toThrow("cursor_loop");
  });
  it("conflict policy per entity decides who wins on an unsynced local edit", () => {
    const local: LocalRecord = { externalId: "a", updatedAt: 10, localEditedAt: 30, deleted: false, hash: "" };
    expect(resolveConflict("external_wins", local, rec("a", 20))).toBe("apply");
    expect(resolveConflict("vireek_wins", local, rec("a", 40))).toBe("skip");
    expect(resolveConflict("newest_wins", local, rec("a", 20))).toBe("skip");
    expect(resolveConflict("newest_wins", local, rec("a", 40))).toBe("apply");
    expect(resolveConflict("vireek_wins", { ...local, localEditedAt: null }, rec("a", 20))).toBe("apply");
  });
});

describe("reconcile + health", () => {
  it("detects every drift class and computes the drift rate", () => {
    const d = reconcile(new Map([["a", "1"], ["b", "2"], ["c", "3"]]), new Map([["a", "1"], ["b", "X"], ["d", "4"]]));
    expect(d.missingLocal).toEqual(["c"]); expect(d.missingExternal).toEqual(["d"]); expect(d.mismatched).toEqual(["b"]);
    expect(d.driftRate).toBe(3 / 4);
    expect(reconcile(new Map(), new Map()).driftRate).toBe(0);
  });
  it("derives UI health", () => {
    const base = { now: 1_000_000, consecutiveFailures: 0, breaker: "closed" as const, driftRate: 0, expectedEveryMs: 60_000 };
    expect(deriveHealth({ ...base, lastSuccessAt: null })).toBe("never_synced");
    expect(deriveHealth({ ...base, lastSuccessAt: 990_000 })).toBe("healthy");
    expect(deriveHealth({ ...base, lastSuccessAt: 990_000, driftRate: 0.05 })).toBe("degraded");
    expect(deriveHealth({ ...base, lastSuccessAt: 100_000 })).toBe("stale");
    expect(deriveHealth({ ...base, lastSuccessAt: 990_000, breaker: "open" })).toBe("failing");
  });
});
