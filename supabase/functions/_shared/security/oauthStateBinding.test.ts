import { describe, expect, it } from "vitest";
import { signState, verifyState } from "../price-book/oauthState.ts";
import { deriveNonceKey, extractStateNonce, issueBoundState, redeemBoundState, sessionIdFromJwt, type Rpc } from "./oauthStateBinding.ts";

const SECRET = "a".repeat(64);
const USER = "8f6a3c1e-0000-4000-8000-000000000001";
const OWNER = "8f6a3c1e-0000-4000-8000-0000000000aa";
const SID = "8f6a3c1e-0000-4000-8000-0000000000bb";

/** Mirrors the SQL semantics of oauth_state_issue / oauth_state_redeem (delete-first, expiry, live session). */
function fakeDb(opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const rows = new Map<string, { provider: string; user: string; owner: string; session: string; exp: number }>();
  const liveSessions = new Set<string>([SID]);
  const rpc: Rpc = async (fn, a) => {
    if (fn === "oauth_state_issue") {
      const n = String(a.p_nonce);
      if (rows.has(n)) return { data: false, error: null };
      rows.set(n, { provider: String(a.p_provider), user: String(a.p_user), owner: String(a.p_owner), session: String(a.p_session), exp: now() + Number(a.p_ttl_seconds) * 1000 });
      return { data: true, error: null };
    }
    if (fn === "oauth_state_redeem") {
      const n = String(a.p_nonce);
      const r = rows.get(n);
      if (!r || r.provider !== a.p_provider) return { data: { ok: false, reason: "unknown_or_used" }, error: null };
      rows.delete(n);
      if (r.exp < now()) return { data: { ok: false, reason: "expired" }, error: null };
      if (!liveSessions.has(r.session)) return { data: { ok: false, reason: "session_ended" }, error: null };
      return { data: { ok: true, user_id: r.user, owner_id: r.owner }, error: null };
    }
    return { data: null, error: { message: "unknown rpc" } };
  };
  return { rpc, rows, liveSessions };
}

// acct/crm style state: base64url(JSON{n,...}).sig  (shape only: the HMAC is checked by the callback before redeem)
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jsonState = (n: string) => `${b64({ o: OWNER, u: USER, p: "xero", n, t: Date.now() })}.sig`;

describe("extractStateNonce", () => {
  it("reads both state layouts and rejects garbage", async () => {
    const s = await signState(USER, SECRET);
    expect(extractStateNonce(s)).toMatch(/^[0-9a-f]{24}$/);
    expect(extractStateNonce(jsonState("abcDEF123456_-xyz"))).toBe("abcDEF123456_-xyz");
    expect(extractStateNonce("garbage")).toBeNull();
    expect(extractStateNonce(`${USER}.1.nothex.sig`)).toBeNull();
    expect(extractStateNonce(`${b64({ x: 1 })}.sig`)).toBeNull();
    expect(extractStateNonce("a".repeat(3000))).toBeNull();
  });
  it("derives provider-specific keys", async () => {
    const a = await deriveNonceKey("hubspot", "n1");
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(a).not.toBe(await deriveNonceKey("google_calendar", "n1"));
  });
});

describe("session-bound single-use state", () => {
  it("accepts a freshly issued state once and rejects the replay (price-book layout)", async () => {
    const db = fakeDb();
    const s = await signState(USER, SECRET);
    expect(await verifyState(s, SECRET)).toBe(USER);
    expect(await issueBoundState(db.rpc, { state: s, provider: "hubspot", userId: USER, ownerId: OWNER, sessionId: SID })).toBe(true);
    const first = await redeemBoundState(db.rpc, s, "hubspot");
    expect(first).toEqual({ ok: true, userId: USER, ownerId: OWNER });
    expect(await redeemBoundState(db.rpc, s, "hubspot")).toEqual({ ok: false, reason: "unknown_or_used" });
  });
  it("rejects replay for the accounting/CRM layout too", async () => {
    const db = fakeDb();
    const s = jsonState("nonce-0123456789");
    await issueBoundState(db.rpc, { state: s, provider: "acct:xero", userId: USER, ownerId: OWNER, sessionId: SID });
    expect((await redeemBoundState(db.rpc, s, "acct:xero")).ok).toBe(true);
    expect((await redeemBoundState(db.rpc, s, "acct:xero")).ok).toBe(false);
  });
  it("a validly signed state that was never issued by our start function is rejected", async () => {
    const db = fakeDb();
    const forged = await signState(USER, SECRET); // attacker with a leaked secret, never went through *-oauth-start
    expect(await redeemBoundState(db.rpc, forged, "hubspot")).toEqual({ ok: false, reason: "unknown_or_used" });
  });
  it("cannot be redeemed under another provider", async () => {
    const db = fakeDb();
    const s = await signState(USER, SECRET);
    await issueBoundState(db.rpc, { state: s, provider: "hubspot", userId: USER, ownerId: OWNER, sessionId: SID });
    expect((await redeemBoundState(db.rpc, s, "google_calendar")).ok).toBe(false);
    expect((await redeemBoundState(db.rpc, s, "hubspot")).ok).toBe(true); // wrong-provider attempt did not burn it
  });
  it("rejects after the minting session ended (sign-out / revoke)", async () => {
    const db = fakeDb();
    const s = await signState(USER, SECRET);
    await issueBoundState(db.rpc, { state: s, provider: "hubspot", userId: USER, ownerId: OWNER, sessionId: SID });
    db.liveSessions.delete(SID);
    expect(await redeemBoundState(db.rpc, s, "hubspot")).toEqual({ ok: false, reason: "session_ended" });
    expect((await redeemBoundState(db.rpc, s, "hubspot")).ok).toBe(false);
  });
  it("rejects an expired state and still burns it", async () => {
    let t = 1_000_000;
    const db = fakeDb({ now: () => t });
    const s = await signState(USER, SECRET);
    await issueBoundState(db.rpc, { state: s, provider: "hubspot", userId: USER, ownerId: OWNER, sessionId: SID, ttlSeconds: 600 });
    t += 601_000;
    expect(await redeemBoundState(db.rpc, s, "hubspot")).toEqual({ ok: false, reason: "expired" });
    expect(db.rows.size).toBe(0);
  });
  it("two concurrent callbacks: exactly one wins", async () => {
    const db = fakeDb();
    const s = await signState(USER, SECRET);
    await issueBoundState(db.rpc, { state: s, provider: "hubspot", userId: USER, ownerId: OWNER, sessionId: SID });
    const [a, b] = await Promise.all([redeemBoundState(db.rpc, s, "hubspot"), redeemBoundState(db.rpc, s, "hubspot")]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
  it("fails closed on RPC error, thrown error, malformed data, malformed state or missing session id", async () => {
    const s = await signState(USER, SECRET);
    expect(await redeemBoundState(async () => ({ data: null, error: { message: "x" } }), s, "hubspot")).toEqual({ ok: false, reason: "unavailable" });
    expect(await redeemBoundState(async () => { throw new Error("net"); }, s, "hubspot")).toEqual({ ok: false, reason: "unavailable" });
    expect((await redeemBoundState(async () => ({ data: { ok: true, user_id: "nope", owner_id: OWNER }, error: null }), s, "hubspot")).ok).toBe(false);
    expect(await redeemBoundState(fakeDb().rpc, "garbage", "hubspot")).toEqual({ ok: false, reason: "malformed" });
    expect(await issueBoundState(fakeDb().rpc, { state: s, provider: "hubspot", userId: USER, ownerId: OWNER, sessionId: null })).toBe(false);
    expect(await issueBoundState(async () => { throw new Error("net"); }, { state: s, provider: "hubspot", userId: USER, ownerId: OWNER, sessionId: SID })).toBe(false);
  });
});

describe("sessionIdFromJwt", () => {
  const jwt = (payload: unknown) => `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
  it("reads the session_id claim", () => {
    expect(sessionIdFromJwt(`Bearer ${jwt({ session_id: SID })}`)).toBe(SID);
  });
  it("returns null when absent, not a uuid, or not a JWT", () => {
    expect(sessionIdFromJwt(jwt({}))).toBeNull();
    expect(sessionIdFromJwt(jwt({ session_id: "x" }))).toBeNull();
    expect(sessionIdFromJwt("nope")).toBeNull();
  });
});
