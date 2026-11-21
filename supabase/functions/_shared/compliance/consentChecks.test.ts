import { describe, it, expect, vi } from "vitest";
import {
  decideReassigned,
  loadReassignedConfig,
  parseAnswer,
  registerAdapter,
  resolveAdapter,
  type ReassignedConfig,
  type ReassignedNumberAdapter,
} from "./reassignedNumber.ts";
import { loadRevocationConfig, parseRevocation, revocationDeadline, stripEmailQuoting } from "./revocation.ts";
import { gateContact, recordInboundRevocation } from "./consentChecks.ts";

const NOW = new Date("2026-11-17T12:00:00Z");
const PHONE = "+15125550123";
const CONSENT = "2026-10-01T10:00:00.000Z";

const cfg = (over: Partial<ReassignedConfig> = {}): ReassignedConfig => ({
  mode: "required", adapterName: "http-json", apiUrl: "https://example.invalid/check", apiKey: "k",
  timeoutMs: 1000, maxAgeHours: 24, ...over,
});
const fixed = (status: "reassigned" | "not_reassigned" | "unknown"): ReassignedNumberAdapter => ({
  name: "fake", check: async () => ({ status, reference: "ref-1", detail: null }),
});

describe("loadReassignedConfig", () => {
  it("defaults to required and clamps numbers", () => {
    const c = loadReassignedConfig((k) => ({ REASSIGNED_NUMBER_TIMEOUT_MS: "1", REASSIGNED_NUMBER_MAX_AGE_HOURS: "99999" } as Record<string, string>)[k]);
    expect(c.mode).toBe("required");
    expect(c.timeoutMs).toBe(500);
    expect(c.maxAgeHours).toBe(720);
  });
  it("only the exact value 'off' disables; a typo stays required", () => {
    expect(loadReassignedConfig((k) => (k === "REASSIGNED_NUMBER_CHECK_MODE" ? "OFF" : undefined)).mode).toBe("off");
    expect(loadReassignedConfig((k) => (k === "REASSIGNED_NUMBER_CHECK_MODE" ? "of" : undefined)).mode).toBe("required");
  });
});

describe("decideReassigned (fail closed)", () => {
  it("allows only on an explicit not_reassigned", async () => {
    const d = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { adapter: fixed("not_reassigned"), config: cfg(), now: NOW });
    expect(d.allow).toBe(true);
  });
  it("blocks reassigned, non-retryable", async () => {
    const d = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { adapter: fixed("reassigned"), config: cfg(), now: NOW });
    expect(d).toMatchObject({ allow: false, reason: "REASSIGNED", retryable: false });
  });
  it("blocks unknown, retryable", async () => {
    const d = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { adapter: fixed("unknown"), config: cfg(), now: NOW });
    expect(d).toMatchObject({ allow: false, reason: "CHECK_UNKNOWN_STATUS", retryable: true });
  });
  it("blocks when no adapter is configured", async () => {
    const d = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { adapter: null, config: cfg(), now: NOW });
    expect(d).toMatchObject({ allow: false, reason: "CHECK_NOT_CONFIGURED", retryable: true });
  });
  it("blocks when the provider throws", async () => {
    const adapter: ReassignedNumberAdapter = { name: "boom", check: async () => { throw new Error("http_503"); } };
    const d = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { adapter, config: cfg(), now: NOW });
    expect(d).toMatchObject({ allow: false, reason: "CHECK_UNAVAILABLE", retryable: true });
  });
  it("blocks on timeout", async () => {
    const adapter: ReassignedNumberAdapter = {
      name: "slow",
      check: (_r, { signal }) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    };
    const d = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { adapter, config: cfg({ timeoutMs: 20 }), now: NOW });
    expect(d).toMatchObject({ allow: false, reason: "CHECK_TIMEOUT", retryable: true });
  });
  it("blocks malformed provider output", async () => {
    const adapter: ReassignedNumberAdapter = { name: "bad", check: async () => parseAnswer({ status: "maybe" }) };
    const d = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { adapter, config: cfg(), now: NOW });
    expect(d).toMatchObject({ allow: false, reason: "CHECK_INVALID_RESPONSE" });
  });
  it("blocks invalid input", async () => {
    const d1 = await decideReassigned({ phoneE164: "5125550123", consentCapturedAt: CONSENT }, { adapter: fixed("not_reassigned"), config: cfg(), now: NOW });
    const d2 = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: "nope" }, { adapter: fixed("not_reassigned"), config: cfg(), now: NOW });
    expect(d1).toMatchObject({ allow: false, reason: "INVALID_INPUT" });
    expect(d2).toMatchObject({ allow: false, reason: "INVALID_INPUT" });
  });
  it("reuses a fresh clear result only for the same consent date", async () => {
    const cached = { status: "not_reassigned" as const, adapter: "fake", reference: "r", checkedAt: new Date("2026-11-17T06:00:00Z"), consentCapturedAt: CONSENT };
    const spy = vi.fn(async () => ({ status: "reassigned" as const }));
    const adapter: ReassignedNumberAdapter = { name: "fake", check: spy };
    const hit = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { adapter, config: cfg(), now: NOW, cached });
    expect(hit).toMatchObject({ allow: true, source: "cache" });
    expect(spy).not.toHaveBeenCalled();
    const otherConsent = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: "2026-11-02T00:00:00.000Z" }, { adapter, config: cfg(), now: NOW, cached });
    expect(otherConsent.allow).toBe(false);
    const stale = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { adapter, config: cfg(), now: NOW, cached: { ...cached, checkedAt: new Date("2026-11-10T00:00:00Z") } });
    expect(stale.allow).toBe(false);
  });
  it("never caches a reassigned/unknown result", async () => {
    const cached = { status: "unknown" as never, adapter: "fake", reference: null, checkedAt: NOW, consentCapturedAt: CONSENT };
    const d = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { adapter: fixed("reassigned"), config: cfg(), now: NOW, cached });
    expect(d.allow).toBe(false);
  });
  it("mode off is an explicit, labelled allow", async () => {
    const d = await decideReassigned({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { adapter: null, config: cfg({ mode: "off" }), now: NOW });
    expect(d).toMatchObject({ allow: true, source: "mode_off" });
  });
});

describe("adapter resolution", () => {
  it("http-json needs both url and key", () => {
    expect(resolveAdapter(cfg({ apiKey: null }))).toBeNull();
    expect(resolveAdapter(cfg())?.name).toBe("http-json");
  });
  it("http-json adapter turns a non-2xx into an error and a good body into an answer", async () => {
    const bad = resolveAdapter(cfg(), (async () => new Response("", { status: 500 })) as typeof fetch)!;
    await expect(bad.check({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { signal: new AbortController().signal })).rejects.toThrow("http_500");
    const good = resolveAdapter(cfg(), (async () => new Response(JSON.stringify({ status: "not_reassigned", reference: "abc" }), { status: 200 })) as typeof fetch)!;
    await expect(good.check({ phoneE164: PHONE, consentCapturedAt: CONSENT }, { signal: new AbortController().signal })).resolves.toMatchObject({ status: "not_reassigned", reference: "abc" });
  });
  it("custom adapters can be registered by name; unknown names resolve to null", () => {
    registerAdapter("custom-x", () => fixed("not_reassigned"));
    expect(resolveAdapter(cfg({ adapterName: "custom-x" }))?.name).toBe("fake");
    expect(resolveAdapter(cfg({ adapterName: "nope" }))).toBeNull();
  });
});

describe("parseRevocation", () => {
  const sms = (text: string) => parseRevocation({ channel: "sms", text });
  it("handles keywords with noise", () => {
    for (const t of ["STOP", " stop. ", "Stop!!", "UNSUBSCRIBE", "opt out", "Quit"]) expect(sms(t).revoked, t).toBe(true);
  });
  it("handles natural language", () => {
    for (const t of ["Please stop texting me", "don't text me again", "remove me from your list", "leave me alone", "no more messages", "I revoke my consent"]) {
      expect(sms(t).revoked, t).toBe(true);
    }
  });
  it("does not fire on negated or unrelated text", () => {
    for (const t of ["Don't stop the repair, keep going", "I can't stop thinking about the quote", "Thanks, see you Tuesday", "What time do you end?"]) {
      expect(sms(t).revoked, t).toBe(false);
    }
  });
  it("a negation in one sentence does not mask a revocation in another", () => {
    expect(sms("Don't stop the repair. But stop texting me.").revoked).toBe(true);
  });
  it("START re-subscribes on SMS only and is never a revocation", () => {
    expect(sms("START")).toMatchObject({ revoked: false, reinstate: true });
    expect(parseRevocation({ channel: "voice", text: "customer: START" }).reinstate).toBe(false);
  });
  it("voice: only the customer's lines are scanned", () => {
    const t = "AI: You can say stop calling me at any time.\nCustomer: sure that works";
    expect(parseRevocation({ channel: "voice", text: t }).revoked).toBe(false);
    expect(parseRevocation({ channel: "voice", text: "AI: hi\nCustomer: please don't call me again" }).revoked).toBe(true);
  });
  it("voice: structured flags win and wrong number is detected", () => {
    expect(parseRevocation({ channel: "voice", text: "", structured: { do_not_call: true } })).toMatchObject({ revoked: true, matchKind: "structured" });
    expect(parseRevocation({ channel: "voice", text: "Customer: wrong number, this isn't his phone" })).toMatchObject({ revoked: true, wrongNumber: true });
  });
  it("email: ignores quoted history and signature, reads the subject", () => {
    const body = "Thanks!\n\nOn Mon, Nov 9, 2026 at 9:00 AM Acme <hi@acme.test> wrote:\n> Reply STOP to unsubscribe\n> more";
    expect(parseRevocation({ channel: "email", text: body, subject: "Re: your quote" }).revoked).toBe(false);
    expect(parseRevocation({ channel: "email", text: "Hello", subject: "Unsubscribe" }).revoked).toBe(true);
    expect(parseRevocation({ channel: "email", text: "Please remove me from all of your emails.\n-- \nJohn" }).revoked).toBe(true);
    expect(stripEmailQuoting("keep\n> drop\n-- \nsig")).toBe("keep");
  });
  it("is robust to unicode and zero-width characters", () => {
    expect(sms("ＳＴＯＰ").revoked).toBe(true);
    expect(sms("ST\u200bOP").revoked).toBe(true);
  });
  it("empty / null input is not a revocation", () => {
    expect(parseRevocation({ channel: "sms", text: null }).revoked).toBe(false);
    expect(parseRevocation({ channel: "email", text: "" }).revoked).toBe(false);
  });
});

describe("revocation config", () => {
  it("defaults to strictest scope and a 24h window; clamps", () => {
    expect(loadRevocationConfig(() => undefined)).toEqual({ scope: "all_channels", windowHours: 24 });
    expect(loadRevocationConfig((k) => (k === "REVOCATION_WINDOW_HOURS" ? "9999" : undefined)).windowHours).toBe(240);
    expect(loadRevocationConfig((k) => (k === "REVOCATION_WINDOW_HOURS" ? "-5" : undefined)).windowHours).toBe(0);
    expect(loadRevocationConfig((k) => (k === "REVOCATION_SCOPE" ? "this_channel" : undefined)).scope).toBe("this_channel");
    expect(loadRevocationConfig((k) => (k === "REVOCATION_SCOPE" ? "garbage" : undefined)).scope).toBe("all_channels");
  });
  it("computes the deadline", () => {
    expect(revocationDeadline(NOW, { scope: "all_channels", windowHours: 2 }).toISOString()).toBe("2026-11-17T14:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Gate with a fake Supabase client
// ---------------------------------------------------------------------------

type Rows = Record<string, unknown>[];
function fakeAdmin(opts: { revoked?: boolean; rpcError?: boolean; insertError?: boolean; consent?: { captured_at: string; granted: boolean } | null; rpcLog?: unknown[] } = {}) {
  const inserted: Rows = [];
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: table === "speed_to_lead_consents" ? opts.consent ?? null : null, error: null });
    q.insert = async (row: Record<string, unknown>) => {
      if (opts.insertError) return { error: { message: "insert failed" } };
      inserted.push(row);
      return { error: null };
    };
    return q;
  };
  const admin = {
    from: (t: string) => chain(t),
    rpc: async (fn: string, args: unknown) => {
      opts.rpcLog?.push({ fn, args });
      if (opts.rpcError) return { data: null, error: { message: "rpc down" } };
      if (fn === "consent_revocation_active") return { data: opts.revoked === true, error: null };
      return { data: "rev-1", error: null };
    },
  };
  return { admin: admin as never, inserted };
}
const env = (m: Record<string, string> = {}) => (k: string) => m[k];

describe("gateContact", () => {
  const base = { ownerId: "owner-1", channel: "call" as const, phoneE164: PHONE, source: "outbound-dialer" };
  it("blocks a revoked number before ever calling the provider, and logs it", async () => {
    const { admin, inserted } = fakeAdmin({ revoked: true });
    const adapter = { name: "x", check: vi.fn(async () => ({ status: "not_reassigned" as const })) };
    const r = await gateContact(base, { admin, getEnv: env(), adapter });
    expect(r).toEqual({ allow: false, reason: "REVOKED", retryable: false });
    expect(adapter.check).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ check_type: "revocation", decision: "block", reason: "REVOKED" });
  });
  it("fails closed when the revocation lookup errors", async () => {
    const { admin } = fakeAdmin({ rpcError: true });
    expect(await gateContact(base, { admin, getEnv: env(), adapter: fixed("not_reassigned") })).toEqual({ allow: false, reason: "CHECK_UNAVAILABLE", retryable: true });
  });
  it("fails closed when no provider is configured (default mode required)", async () => {
    const { admin, inserted } = fakeAdmin({ consent: { captured_at: CONSENT, granted: true } });
    const r = await gateContact(base, { admin, getEnv: env(), now: NOW });
    expect(r).toEqual({ allow: false, reason: "CHECK_NOT_CONFIGURED", retryable: true });
    expect(inserted.at(-1)).toMatchObject({ check_type: "reassigned_number", decision: "block", reason: "CHECK_NOT_CONFIGURED" });
  });
  it("allows on a clear provider answer and logs reference + consent date", async () => {
    const { admin, inserted } = fakeAdmin({ consent: { captured_at: CONSENT, granted: true } });
    const r = await gateContact(base, { admin, getEnv: env(), now: NOW, adapter: fixed("not_reassigned") });
    expect(r).toEqual({ allow: true });
    expect(inserted.at(-1)).toMatchObject({ decision: "allow", provider_status: "not_reassigned", provider_reference: "ref-1", adapter: "fake" });
  });
  it("blocks a reassigned number", async () => {
    const { admin } = fakeAdmin({ consent: { captured_at: CONSENT, granted: true } });
    expect(await gateContact(base, { admin, getEnv: env(), now: NOW, adapter: fixed("reassigned") })).toEqual({ allow: false, reason: "REASSIGNED", retryable: false });
  });
  it("blocks when there is no consent date and no fallback; uses the fallback (and labels it) when given", async () => {
    const a = fakeAdmin({ consent: null });
    expect(await gateContact(base, { admin: a.admin, getEnv: env(), now: NOW, adapter: fixed("not_reassigned") })).toEqual({ allow: false, reason: "NO_CONSENT_DATE", retryable: false });
    const b = fakeAdmin({ consent: null });
    const r = await gateContact({ ...base, fallbackConsentAt: CONSENT }, { admin: b.admin, getEnv: env(), now: NOW, adapter: fixed("not_reassigned") });
    expect(r).toEqual({ allow: true });
    expect(String(b.inserted.at(-1)?.detail)).toContain("fallback");
  });
  it("an ungrantable (revoked/denied) latest consent is not used as a consent date", async () => {
    const { admin } = fakeAdmin({ consent: { captured_at: CONSENT, granted: false } });
    expect(await gateContact(base, { admin, getEnv: env(), now: NOW, adapter: fixed("not_reassigned") })).toMatchObject({ allow: false, reason: "NO_CONSENT_DATE" });
  });
  it("NO LOG, NO CONTACT: an allow that cannot be logged becomes a retryable block", async () => {
    const { admin } = fakeAdmin({ insertError: true, consent: { captured_at: CONSENT, granted: true } });
    expect(await gateContact(base, { admin, getEnv: env(), now: NOW, adapter: fixed("not_reassigned") })).toEqual({ allow: false, reason: "AUDIT_LOG_UNAVAILABLE", retryable: true });
  });
  it("email contact only runs the revocation gate", async () => {
    const { admin } = fakeAdmin();
    const adapter = { name: "x", check: vi.fn(async () => ({ status: "reassigned" as const })) };
    const r = await gateContact({ ownerId: "o", channel: "email", email: "A@B.com", source: "mailer" }, { admin, getEnv: env(), adapter });
    expect(r).toEqual({ allow: true });
    expect(adapter.check).not.toHaveBeenCalled();
  });
  it("rejects a gate call with no subject", async () => {
    const { admin } = fakeAdmin();
    expect(await gateContact({ ownerId: "o", channel: "sms", source: "x" }, { admin, getEnv: env() })).toMatchObject({ allow: false, reason: "INVALID_INPUT" });
  });
  it("mode off skips the provider but is logged as MODE_OFF", async () => {
    const { admin, inserted } = fakeAdmin({ consent: { captured_at: CONSENT, granted: true } });
    const r = await gateContact(base, { admin, getEnv: env({ REASSIGNED_NUMBER_CHECK_MODE: "off" }), now: NOW });
    expect(r).toEqual({ allow: true });
    expect(inserted.at(-1)).toMatchObject({ decision: "allow", reason: "MODE_OFF" });
  });
});

describe("recordInboundRevocation", () => {
  it("records a revocation through the RPC with the configured scope and window", async () => {
    const rpcLog: unknown[] = [];
    const { admin } = fakeAdmin({ rpcLog });
    const r = await recordInboundRevocation(
      { ownerId: "o", channel: "sms", text: "STOP", phoneE164: PHONE, sourceRef: "SM123", source: "sms-webhook" },
      { admin, getEnv: env({ REVOCATION_WINDOW_HOURS: "6" }) },
    );
    expect(r).toMatchObject({ revoked: true, recorded: true, revocationId: "rev-1" });
    expect(rpcLog[0]).toMatchObject({ fn: "consent_record_revocation", args: { p_phone: PHONE, p_scope: "all_channels", p_window_hours: 6, p_source_ref: "SM123", p_channel: "sms" } });
  });
  it("does nothing for non-revocations", async () => {
    const rpcLog: unknown[] = [];
    const { admin } = fakeAdmin({ rpcLog });
    const r = await recordInboundRevocation({ ownerId: "o", channel: "sms", text: "see you at 3", phoneE164: PHONE, source: "sms-webhook" }, { admin, getEnv: env() });
    expect(r.revoked).toBe(false);
    expect(rpcLog).toHaveLength(0);
  });
  it("surfaces a detected-but-unrecorded revocation instead of hiding it", async () => {
    const { admin } = fakeAdmin({ rpcError: true });
    const r = await recordInboundRevocation({ ownerId: "o", channel: "email", text: "unsubscribe me", email: "x@y.com", source: "email-webhook" }, { admin, getEnv: env() });
    expect(r).toMatchObject({ revoked: true, recorded: false, error: "rpc down" });
  });
  it("needs a subject to attach the revocation to", async () => {
    const { admin } = fakeAdmin();
    const r = await recordInboundRevocation({ ownerId: "o", channel: "voice", text: "customer: stop calling", source: "vapi-webhook" }, { admin, getEnv: env() });
    expect(r).toMatchObject({ revoked: true, recorded: false, error: "no_subject" });
  });
});
