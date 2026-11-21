import { describe, it, expect } from "vitest";
import { admit, buildStatusView, DEFAULT_HEALTH_POLICY, INITIAL_HEALTH, onFailure, onSuccess, type HealthSnapshot } from "./health.ts";
import { computeCostMicros, costForStatus, summarize } from "./metering.ts";
import { withResilience } from "./resilient.ts";
import { MemoryResilienceStore } from "./memoryStore.ts";
import { MockBankProvider, mockTxn } from "./mockProvider.ts";
import { mapPlaidError, normalizePlaidAccount, normalizePlaidTxn, createPlaidProvider } from "./plaidProvider.ts";
import { PlaidError } from "../plaid.ts";
import { BankProviderError } from "./types.ts";
import { syncConnection } from "../sync.ts";

const T0 = new Date("2026-11-17T10:00:00.000Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

function fail(n: number, kind: Parameters<typeof onFailure>[1] = "provider_unavailable", start: HealthSnapshot = INITIAL_HEALTH, at = T0): HealthSnapshot {
  let s = start;
  for (let i = 0; i < n; i++) s = onFailure(s, kind, at, DEFAULT_HEALTH_POLICY);
  return s;
}

describe("health state machine", () => {
  it("stays healthy on one failure, degrades at 2, goes down at 5 with an open circuit", () => {
    expect(fail(1).state).toBe("healthy");
    expect(fail(2).state).toBe("degraded");
    const down = fail(5);
    expect(down.state).toBe("down");
    expect(down.circuitOpenUntil).toBe(plus(T0, 30_000).toISOString());
  });

  it("does not let one customer's bank login problem degrade the provider", () => {
    const s = fail(10, "auth_required");
    expect(s.state).toBe("healthy");
    expect(s.consecutiveFailures).toBe(0);
  });

  it("treats our own faults (invalid_request) as no signal at all", () => {
    const degraded = fail(2);
    expect(onFailure(degraded, "invalid_request", T0)).toBe(degraded);
  });

  it("an answer such as 'institution unavailable' proves the provider is reachable and resets the streak", () => {
    expect(onFailure(fail(4), "institution_unavailable", T0).consecutiveFailures).toBe(0);
  });

  it("backs off exponentially but never beyond maxOpenMs, even after thousands of failures", () => {
    const six = fail(6);
    expect(Date.parse(six.circuitOpenUntil!) - T0.getTime()).toBe(60_000);
    const many = fail(5000);
    expect(Date.parse(many.circuitOpenUntil!) - T0.getTime()).toBe(DEFAULT_HEALTH_POLICY.maxOpenMs);
  });

  it("refuses calls while open, then admits exactly one probe and leases the circuit", () => {
    const down = fail(5);
    const blocked = admit(down, plus(T0, 10_000));
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterMs).toBe(20_000);

    const probe = admit(down, plus(T0, 30_001));
    expect(probe.allowed).toBe(true);
    if (probe.allowed && probe.probe) {
      expect(Date.parse(probe.lease.circuitOpenUntil!)).toBeGreaterThan(plus(T0, 30_001).getTime());
      // a second caller arriving during the probe is refused
      expect(admit(probe.lease, plus(T0, 30_002)).allowed).toBe(false);
    } else throw new Error("expected a probe");
  });

  it("success closes the circuit completely", () => {
    const s = onSuccess(fail(7), plus(T0, 99_000));
    expect(s.state).toBe("healthy");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.circuitOpenUntil).toBeNull();
  });

  it("a corrupt circuit timestamp must never lock every tenant out", () => {
    expect(admit({ ...fail(5), circuitOpenUntil: "garbage" }, T0).allowed).toBe(true);
  });
});

describe("status view (what the user sees)", () => {
  it("reports cached data honestly during an outage", () => {
    const v = buildStatusView(fail(5), plus(T0, -3_600_000).toISOString(), T0);
    expect(v.providerState).toBe("down");
    expect(v.servingCachedData).toBe(true);
    expect(v.freshness).toBe("fresh");
    expect(v.messageKey).toBe("bank.status.down");
    expect(v.retryAfterSeconds).toBe(30);
  });
  it("flags stale and never-synced data when the provider is healthy", () => {
    expect(buildStatusView(INITIAL_HEALTH, plus(T0, -40 * 3_600_000).toISOString(), T0).messageKey).toBe("bank.status.stale");
    expect(buildStatusView(INITIAL_HEALTH, null, T0).messageKey).toBe("bank.status.never");
    expect(buildStatusView(INITIAL_HEALTH, null, T0).servingCachedData).toBe(false);
    expect(buildStatusView(INITIAL_HEALTH, plus(T0, -1000).toISOString(), T0).messageKey).toBe("bank.status.ok");
  });
});

describe("metering", () => {
  it("never invents a price: unknown rate is null, not 0", () => {
    expect(computeCostMicros(3, null)).toBeNull();
    expect(computeCostMicros(3, 1500)).toBe(4500);
    expect(computeCostMicros(-1, 10)).toBeNull();
    expect(computeCostMicros(1.5, 10)).toBeNull();
    expect(computeCostMicros(Number.MAX_SAFE_INTEGER, 10)).toBeNull();
  });
  it("blocked calls cost a known zero", () => {
    expect(costForStatus("blocked", 1, null)).toBe(0);
    expect(costForStatus("ok", 1, null)).toBeNull();
  });
  it("summarises known and unknown cost separately", () => {
    const base = { userId: "u", connectionId: "c", provider: "mock" as const, operation: "accounts" as const, units: 1, errorKind: null, durationMs: 1 };
    const s = summarize([
      { ...base, status: "ok", costMicros: 100 }, { ...base, status: "ok", costMicros: null },
      { ...base, status: "error", costMicros: 100 }, { ...base, status: "blocked", costMicros: 0 },
    ]);
    expect(s).toEqual({ calls: 4, errors: 1, blocked: 1, knownCostMicros: 200, callsWithUnknownCost: 1 });
  });
});

describe("resilient decorator over the mock provider", () => {
  const setup = () => {
    const store = new MemoryResilienceStore();
    const inner = new MockBankProvider({ accounts: [] });
    let now = T0;
    const clock = { advance: (ms: number) => { now = plus(now, ms); } };
    const p = withResilience(inner, { store, now: () => now, ctx: { userId: "owner-1", connectionId: "conn-1" } });
    return { store, inner, p, clock };
  };

  it("meters every call with context, duration and a rate-derived cost", async () => {
    const { store, p } = setup();
    store.setRate("mock", "accounts", 2000);
    await p.getAccounts("tok");
    expect(store.pulls).toHaveLength(1);
    expect(store.pulls[0]).toMatchObject({ userId: "owner-1", connectionId: "conn-1", provider: "mock", operation: "accounts", status: "ok", costMicros: 2000, units: 1 });
  });

  it("records unknown cost as null when no rate is configured", async () => {
    const { store, p } = setup();
    await p.getAccounts("tok");
    expect(store.pulls[0].costMicros).toBeNull();
  });

  it("opens the circuit after repeated outages and then stops calling the provider", async () => {
    const { store, inner, p } = setup();
    inner.setDown(true);
    for (let i = 0; i < 5; i++) await expect(p.getAccounts("t")).rejects.toMatchObject({ kind: "provider_unavailable" });
    expect(inner.callCount("getAccounts")).toBe(5);
    expect((await store.getHealth("mock")).state).toBe("down");

    await expect(p.getAccounts("t")).rejects.toMatchObject({ kind: "provider_unavailable", code: "CIRCUIT_OPEN" });
    expect(inner.callCount("getAccounts")).toBe(5); // no vendor call, no vendor cost
    const last = store.pulls[store.pulls.length - 1];
    expect(last).toMatchObject({ status: "blocked", costMicros: 0, errorKind: "circuit_open" });
  });

  it("recovers through a single probe once the window has elapsed", async () => {
    const { store, inner, p, clock } = setup();
    inner.setDown(true);
    for (let i = 0; i < 5; i++) await p.getAccounts("t").catch(() => {});
    inner.setDown(false);
    clock.advance(30_001);
    await p.getAccounts("t");
    const h = await store.getHealth("mock");
    expect(h.state).toBe("healthy");
    expect(h.circuitOpenUntil).toBeNull();
  });

  it("a failing probe re-opens the circuit with a longer window", async () => {
    const { store, inner, p, clock } = setup();
    inner.setDown(true);
    for (let i = 0; i < 5; i++) await p.getAccounts("t").catch(() => {});
    clock.advance(30_001);
    await p.getAccounts("t").catch(() => {});
    const h = await store.getHealth("mock");
    expect(h.state).toBe("down");
    expect(h.consecutiveFailures).toBe(6);
  });

  it("user-specific failures never open the circuit", async () => {
    const { store, inner, p } = setup();
    inner.failNext("auth_required", 20);
    for (let i = 0; i < 20; i++) await expect(p.getAccounts("t")).rejects.toMatchObject({ kind: "auth_required" });
    expect((await store.getHealth("mock")).state).toBe("healthy");
    expect(inner.callCount("getAccounts")).toBe(20);
  });

  it("fails OPEN when the health/metering store itself is broken", async () => {
    const inner = new MockBankProvider();
    const broken = {
      getHealth: () => Promise.reject(new Error("db down")), saveHealth: () => Promise.reject(new Error("db down")),
      recordPull: () => Promise.reject(new Error("db down")), getRateMicros: () => Promise.reject(new Error("db down")),
    };
    const p = withResilience(inner, { store: broken });
    await expect(p.getAccounts("t")).resolves.toEqual([]);
  });

  it("never blocks inbound webhooks while the circuit is open", async () => {
    const { inner, p } = setup();
    inner.setDown(true);
    for (let i = 0; i < 6; i++) await p.getAccounts("t").catch(() => {});
    expect(await p.verifyWebhook("{}", "mock-secret")).toBe(true);
    expect(p.parseWebhook(JSON.stringify({ item_id: "i1", kind: "transactions_updated" }))).toEqual({ kind: "transactions_updated", itemId: "i1" });
  });

  it("wraps unexpected exceptions as kind 'unknown' (counts toward health)", async () => {
    const store = new MemoryResilienceStore();
    const inner = new MockBankProvider();
    inner.getAccounts = () => Promise.reject(new TypeError("boom"));
    const p = withResilience(inner, { store });
    await expect(p.getAccounts("t")).rejects.toMatchObject({ kind: "unknown" });
    expect((await store.getHealth("mock")).consecutiveFailures).toBe(1);
  });
});

describe("Plaid adapter", () => {
  const pe = (code: string, type: string, status: number) => new PlaidError(code, type, "m", status);
  it("maps vendor errors to provider-neutral kinds", () => {
    expect(mapPlaidError(pe("NETWORK", "NETWORK", 0)).kind).toBe("provider_unavailable");
    expect(mapPlaidError(pe("INTERNAL_SERVER_ERROR", "API_ERROR", 500)).kind).toBe("provider_unavailable");
    expect(mapPlaidError(pe("X", "Y", 429)).kind).toBe("rate_limited");
    expect(mapPlaidError(pe("ITEM_LOGIN_REQUIRED", "ITEM_ERROR", 400)).kind).toBe("auth_required");
    expect(mapPlaidError(pe("PENDING_EXPIRATION", "ITEM_ERROR", 400)).kind).toBe("auth_required");
    expect(mapPlaidError(pe("PRODUCT_NOT_READY", "ITEM_ERROR", 400)).kind).toBe("product_not_ready");
    expect(mapPlaidError(pe("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "TRANSACTIONS_ERROR", 400)).kind).toBe("pagination_mutation");
    expect(mapPlaidError(pe("NOT_CONFIGURED", "CONFIG", 500)).kind).toBe("not_configured");
    expect(mapPlaidError(pe("INVALID_FIELD", "INVALID_REQUEST", 400)).kind).toBe("invalid_request");
    expect(mapPlaidError(new Error("x")).kind).toBe("unknown");
  });

  it("returns existing BankProviderError untouched", () => {
    const e = new BankProviderError("auth_required", "C", "m", "plaid");
    expect(mapPlaidError(e)).toBe(e);
  });

  it("inverts Plaid's sign convention to business perspective and never yields -0", () => {
    const base = { transaction_id: "t", account_id: "a", date: "2026-11-01", authorized_date: null, name: "N", merchant_name: null, pending: false, pending_transaction_id: null, payment_channel: null, iso_currency_code: null };
    expect(normalizePlaidTxn({ ...base, amount: 12.5 }).amountCents).toBe(-1250);
    expect(normalizePlaidTxn({ ...base, amount: -100 }).amountCents).toBe(10000);
    expect(Object.is(normalizePlaidTxn({ ...base, amount: 0 }).amountCents, 0)).toBe(true);
    expect(normalizePlaidTxn({ ...base, amount: 0.1 + 0.2 }).amountCents).toBe(-30); // float noise rounded
    expect(normalizePlaidTxn({ ...base, amount: 1 }).currency).toBe("USD");
  });

  it("normalises accounts, falling back available -> current", () => {
    const a = normalizePlaidAccount({ account_id: "a1", name: "", official_name: "Official", mask: "0000", type: "depository", subtype: "checking", balances: { current: 10.5, available: null, iso_currency_code: null } });
    expect(a).toMatchObject({ providerAccountId: "a1", name: "Official", currentBalanceCents: 1050, availableBalanceCents: 1050, currency: "USD" });
  });

  it("calls Plaid with the same payload the live code used (US, transactions, 365 days) and normalises the result", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const provider = createPlaidProvider(() => ({
      // deno-lint-ignore no-explicit-any
      post: (async (path: string, body: Record<string, unknown>) => { calls.push({ path, body }); return { link_token: "lt" }; }) as any,
    }));
    expect(await provider.createLinkToken({ ownerId: "o", webhookUrl: "https://w", historyDays: 365 })).toEqual({ linkToken: "lt" });
    expect(calls[0].path).toBe("/link/token/create");
    expect(calls[0].body).toMatchObject({ country_codes: ["US"], products: ["transactions"], transactions: { days_requested: 365 }, webhook: "https://w" });
    await provider.createLinkToken({ ownerId: "o", webhookUrl: "https://w", accessToken: "tok" });
    expect(calls[1].body.access_token).toBe("tok");
    expect(calls[1].body.products).toBeUndefined();
  });

  it("parses webhooks into neutral events", () => {
    const p = createPlaidProvider(() => { throw new Error("not needed"); });
    expect(p.parseWebhook(JSON.stringify({ item_id: "i", webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE" }))).toEqual({ kind: "transactions_updated", itemId: "i" });
    expect(p.parseWebhook(JSON.stringify({ item_id: "i", webhook_type: "ITEM", webhook_code: "ERROR", error: { error_code: "ITEM_LOGIN_REQUIRED" } }))).toEqual({ kind: "login_required", itemId: "i" });
    expect(p.parseWebhook(JSON.stringify({ item_id: "i", webhook_type: "ITEM", webhook_code: "LOGIN_REPAIRED" }))).toEqual({ kind: "login_repaired", itemId: "i" });
    expect(p.parseWebhook(JSON.stringify({ item_id: "i", webhook_type: "OTHER", webhook_code: "X" }))).toEqual({ kind: "ignored", itemId: "i" });
    expect(p.parseWebhook(JSON.stringify({}))).toEqual({ kind: "ignored", itemId: null });
    expect(p.parseWebhook("not json")).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// syncConnection against a minimal in-memory fake of the Supabase query builder.
// ------------------------------------------------------------------------------------------------
interface Recorded { table: string; op: string; payload?: unknown }
function fakeDb(opts: { consent?: boolean } = {}) {
  const log: Recorded[] = [];
  const releases: Array<Record<string, unknown>> = [];
  // deno-lint-ignore no-explicit-any
  const from = (table: string): any => {
    const st: { op: string; payload?: unknown; selected: boolean } = { op: "select", selected: false };
    const resolve = () => {
      log.push({ table, op: st.op, payload: st.payload });
      if (table === "bank_connections" && st.op === "update") {
        if (st.selected) return { data: [{ id: "conn-1" }], error: null }; // lock claim
        releases.push(st.payload as Record<string, unknown>); return { data: null, error: null };
      }
      if (table === "bank_connection_secrets") return { data: { access_token: "tok" }, error: null };
      if (table === "chart_of_accounts") return { data: [], error: null };
      if (table === "bank_accounts" && st.op === "upsert") return { data: (st.payload as Array<{ provider_account_id: string; is_active: boolean }>).map((r) => ({ id: `acc-${r.provider_account_id}`, provider_account_id: r.provider_account_id, is_active: r.is_active })), error: null };
      return { data: [], error: null };
    };
    // deno-lint-ignore no-explicit-any
    const q: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(res, rej);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(resolve());
        return (...args: unknown[]) => {
          if (["update", "upsert", "delete", "insert"].includes(prop)) { st.op = prop; st.payload = args[0]; }
          if (prop === "select" && st.op === "update") st.selected = true;
          return q;
        };
      },
    });
    return q;
  };
  // deno-lint-ignore no-explicit-any
  const db: any = { from, rpc: (_n: string) => Promise.resolve({ data: opts.consent ?? true, error: null }) };
  return { db, log, releases };
}

const conn = { id: "conn-1", user_id: "owner-1", sync_cursor: null, last_synced_at: null };
const acct = { providerAccountId: "a1", name: "Checking", mask: "1111", type: "depository", subtype: "checking", currency: "USD", currentBalanceCents: 5000, availableBalanceCents: 5000 };

describe("syncConnection", () => {
  it("syncs through the neutral interface and stores business-perspective cents", async () => {
    const { db, log, releases } = fakeDb();
    const mock = new MockBankProvider({ accounts: [acct], pages: [{ added: [mockTxn({ amountCents: -1250 })], modified: [], removedIds: [] }] });
    const r = await syncConnection(db, mock, conn);
    expect(r).toEqual({ added: 1, modified: 0, removed: 0 });
    const up = log.find((l) => l.table === "bank_transactions" && l.op === "upsert")!;
    expect((up.payload as Array<Record<string, unknown>>)[0]).toMatchObject({ user_id: "owner-1", account_id: "acc-a1", provider_txn_id: "t1", amount_cents: -1250 });
    expect(releases[0]).toMatchObject({ status: "active", last_error: null, sync_cursor: "page-1", sync_locked_until: null });
  });

  it("skips (does NOT mark the connection broken) when the provider is down", async () => {
    const { db, log, releases } = fakeDb();
    const mock = new MockBankProvider({ accounts: [acct] }).setDown(true);
    const r = await syncConnection(db, mock, conn);
    expect(r.skipped).toBe("provider_unavailable");
    expect(r.error).toBeUndefined();
    expect(Object.keys(releases[0]).sort()).toEqual(["sync_locked_until", "updated_at"]); // status / last_error untouched
    expect(log.some((l) => l.table === "bank_transactions")).toBe(false);
  });

  it("opens the circuit across syncs and then makes zero vendor calls, with a retry hint", async () => {
    const store = new MemoryResilienceStore();
    const inner = new MockBankProvider({ accounts: [acct] }).setDown(true);
    let now = T0;
    const p = withResilience(inner, { store, now: () => now });
    for (let i = 0; i < 5; i++) await syncConnection(fakeDb().db, p, conn);
    const before = inner.callCount();
    const r = await syncConnection(fakeDb().db, p, conn);
    expect(r.skipped).toBe("provider_unavailable");
    expect(r.retry_after_seconds).toBeGreaterThan(0);
    expect(inner.callCount()).toBe(before);

    inner.setDown(false);
    now = plus(now, 31_000);
    const ok = await syncConnection(fakeDb().db, p, conn);
    expect(ok.skipped).toBeUndefined();
    expect((await store.getHealth("mock")).state).toBe("healthy");
  });

  it("an item needing re-login marks only that connection login_required", async () => {
    const { db, releases } = fakeDb();
    const mock = new MockBankProvider({ accounts: [acct] }).failNext("auth_required", 1, "syncTransactions");
    const r = await syncConnection(db, mock, conn);
    expect(r.login_required).toBe(true);
    expect(releases[0]).toMatchObject({ status: "login_required" });
  });

  it("restarts the page loop when the cursor is invalidated mid-pagination, but gives up after 2 restarts", async () => {
    const ok = fakeDb();
    const m1 = new MockBankProvider({ accounts: [acct], pages: [{ added: [mockTxn()], modified: [], removedIds: [] }] }).failNext("pagination_mutation", 2, "syncTransactions");
    expect((await syncConnection(ok.db, m1, conn)).added).toBe(1);

    const bad = fakeDb();
    const m2 = new MockBankProvider({ accounts: [acct] }).failNext("pagination_mutation", 3, "syncTransactions");
    const r = await syncConnection(bad.db, m2, conn);
    expect(r.error).toBeTruthy();
    expect(r.login_required).toBe(false);
  });

  it("treats 'history not ready' as a quiet skip", async () => {
    const { db, releases } = fakeDb();
    const mock = new MockBankProvider({ accounts: [acct] }).failNext("product_not_ready", 1, "syncTransactions");
    expect((await syncConnection(db, mock, conn)).skipped).toBe("not_ready");
    expect(Object.keys(releases[0]).sort()).toEqual(["sync_locked_until", "updated_at"]);
  });

  it("with consent enforcement on, makes no provider call for a connection without consent", async () => {
    const { db } = fakeDb({ consent: false });
    const mock = new MockBankProvider({ accounts: [acct] });
    const r = await syncConnection(db, mock, conn, { requireConsent: true });
    expect(r.skipped).toBe("consent_missing");
    expect(mock.callCount()).toBe(0);
  });

  it("honours the cooldown before doing anything", async () => {
    const { db } = fakeDb();
    const mock = new MockBankProvider();
    const r = await syncConnection(db, mock, { ...conn, last_synced_at: new Date().toISOString() }, { minIntervalMs: 60_000 });
    expect(r.skipped).toBe("cooldown");
    expect(mock.callCount()).toBe(0);
  });
});
