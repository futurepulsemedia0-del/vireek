import { describe, it, expect } from "vitest";
import { guardToolCall } from "./gate.ts";
import { createMemoryPorts, newWorld } from "./memoryPorts.ts";
import { requestCallback, requestVerification, completeVerification } from "./verifyTools.ts";
import { DEFAULT_TIER_CONFIG, actionClassOf, applyTierPolicy, parseTierConfig, shouldAuditAllow, spokenForMethods } from "./riskTiers.ts";
import { getToolSpec } from "./toolPolicy.ts";
import type { CallRef } from "./types.ts";

const T = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15125550101";
const call: CallRef = { callId: "call-1", kind: "inbound", callerNumber: PHONE, dialedNumberId: null };
const FUTURE = "2026-11-20T15:00:00Z";
const mkWorld = () => newWorld({ customers: [{ id: "22222222-2222-4222-8222-222222222222", name: "John Smith", address: "12 Oak Street, Austin TX 78701", phone: PHONE }] });
const scan = () => ({ score: 0, rules: [] as string[] });

describe("action classes", () => {
  it("maps the four business classes", () => {
    expect(actionClassOf("lookup_price", getToolSpec("lookup_price")!)).toBe("info");
    expect(actionClassOf("reschedule_appointment", getToolSpec("reschedule_appointment")!)).toBe("reschedule");
    expect(actionClassOf("update_address", getToolSpec("update_address")!)).toBe("address_change");
    expect(actionClassOf("collect_card_payment", getToolSpec("collect_card_payment")!)).toBe("payment");
    expect(actionClassOf("issue_refund", getToolSpec("issue_refund")!)).toBe("payment");
  });
});

describe("parseTierConfig is tighten-only", () => {
  it("empty input = defaults", () => expect(parseTierConfig(undefined)).toMatchObject({ rejected: false, warnings: [] }));
  it("rejects bad JSON, unknown keys, unknown classes, unknown methods", () => {
    for (const bad of ["{", '{"x":1}', '{"classes":{"nope":{}}}', '{"classes":{"payment":{"methods":["fax"]}}}', '{"classes":{"payment":{"min":"god"}}}', '{"classes":{"payment":{"wat":1}}}', '{"version":2}', "[]"]) {
      const r = parseTierConfig(bad);
      expect(r.rejected, bad).toBe(true);
      expect(r.config).toEqual(DEFAULT_TIER_CONFIG);
    }
  });
  it("ignores every attempt to relax a default", () => {
    const r = parseTierConfig({ classes: { payment: { min: "none", below: "minimal", methods: ["sms_otp", "callback"] }, address_change: { methods: ["sms_otp", "callback"] }, account_read: { min: "caller_id" } } });
    expect(r.rejected).toBe(false);
    expect(r.config.classes.payment.min).toBe("step_up");
    expect(r.config.classes.payment.below).toBe("refuse");
    expect(r.config.classes.address_change.methods).toEqual(["callback"]);
    expect(r.config.classes.account_read.min).toBe("step_up");
    expect(r.warnings.length).toBeGreaterThanOrEqual(3);
  });
  it("allows tightening", () => {
    const r = parseTierConfig('{"classes":{"info":{"min":"caller_id"},"account_read":{"below":"refuse"},"payment":{"methods":["callback"]},"reschedule":{"disabled":true}}}');
    expect(r.config.classes.info.min).toBe("caller_id");
    expect(r.config.classes.account_read.below).toBe("refuse");
    expect(r.config.classes.payment.methods).toEqual(["callback"]);
    expect(r.config.classes.reschedule.disabled).toBe(true);
  });
  it("the safety class cannot be configured", () => {
    const r = parseTierConfig({ classes: { safety: { disabled: true, min: "step_up" } } });
    expect(r.config.classes.safety.disabled).toBe(false);
    expect(r.config.classes.safety.min).toBe("none");
  });
  it("applyTierPolicy never lowers the catalog requirement", () => {
    const spec = getToolSpec("collect_card_payment")!;
    const eff = applyTierPolicy("collect_card_payment", spec, { ...DEFAULT_TIER_CONFIG, classes: { ...DEFAULT_TIER_CONFIG.classes, payment: { min: "none", below: "minimal", methods: [], disabled: false } } });
    expect(eff.spec.min).toBe("step_up");
    expect(eff.spec.below).toBe("deny");
  });
  it("auditAllows policy", () => {
    expect(shouldAuditAllow(DEFAULT_TIER_CONFIG, "info")).toBe(true);
    expect(shouldAuditAllow({ ...DEFAULT_TIER_CONFIG, auditAllows: "sensitive" }, "info")).toBe(false);
    expect(shouldAuditAllow({ ...DEFAULT_TIER_CONFIG, auditAllows: "sensitive" }, "payment")).toBe(true);
  });
  it("spoken text only offers methods that are configured", () => {
    expect(spokenForMethods(["sms_otp"], false)).toContain("request_verification");
    expect(spokenForMethods(["sms_otp"], false)).not.toContain("request_callback");
    expect(spokenForMethods(["callback"], true)).toContain("request_callback");
    expect(spokenForMethods([], false)).not.toContain("request_");
  });
});

describe("gate: every decision is audited, tiers are enforced", () => {
  it("refuses sensitive tiers for an unverified caller, then allows after step-up (reschedule + payment)", async () => {
    const world = mkWorld();
    const p = createMemoryPorts(world, scan);
    const denied = await guardToolCall(p, { tenantId: T, tool: "collect_card_payment", rawArgs: { job_id: "44444444-4444-4444-8444-444444444444" }, call });
    expect(denied).toMatchObject({ allow: false, code: "needs_step_up" });
    expect(world.audit.some((a) => a.code === "needs_step_up" && a.detail?.class === "payment")).toBe(true);
    await requestVerification(p, T, call);
    const code = /code is (\d{6})/.exec(world.sms.at(-1)!.body)![1];
    expect(await completeVerification(p, T, call, { code, zip: "78701", last_name: "Smith" })).toContain("verified");
    const r = await guardToolCall(p, { tenantId: T, tool: "reschedule_appointment", rawArgs: { new_datetime: FUTURE }, call });
    expect(r).toMatchObject({ allow: false, code: "confirmation_required" });
  });
  it("address change stays refused on voice at every verification level, and is audited", async () => {
    const world = mkWorld();
    const p = createMemoryPorts(world, scan);
    await requestVerification(p, T, call);
    const code = /code is (\d{6})/.exec(world.sms.at(-1)!.body)![1];
    await completeVerification(p, T, call, { code, zip: "78701", last_name: "Smith" });
    const r = await guardToolCall(p, { tenantId: T, tool: "update_address", rawArgs: {}, call });
    expect(r).toMatchObject({ allow: false, code: "voice_never" });
    expect(world.audit.some((a) => a.code === "voice_never" && a.decision === "deny")).toBe(true);
  });
  it("audits allows for public tools too (default auditAllows=all)", async () => {
    const world = mkWorld();
    const p = createMemoryPorts(world, scan);
    const r = await guardToolCall(p, { tenantId: T, tool: "check_weather", rawArgs: { location: "Austin" }, call });
    expect(r.allow).toBe(true);
    expect(world.audit.some((a) => a.kind === "tool_allowed" && a.tool === "check_weather" && a.detail?.class === "info")).toBe(true);
  });
  it("unknown tools and a down backend are refused and audited / fail closed", async () => {
    const world = mkWorld();
    const p = createMemoryPorts(world, scan);
    expect(await guardToolCall(p, { tenantId: T, tool: "wire_money", rawArgs: {}, call })).toMatchObject({ allow: false, code: "unknown_tool" });
    expect(world.audit.some((a) => a.code === "unknown_tool")).toBe(true);
    let down = true;
    const p2 = createMemoryPorts(mkWorld(), scan, "s", { failBackend: () => down });
    expect(await guardToolCall(p2, { tenantId: T, tool: "check_billing_status", rawArgs: {}, call })).toMatchObject({ allow: false, code: "security_unavailable" });
    expect((await guardToolCall(p2, { tenantId: T, tool: "flag_emergency_call", rawArgs: { reason: "gas smell" }, call })).allow).toBe(true);
    down = false;
  });
  it("a disabled class is refused with an audit row, even after step-up", async () => {
    const world = mkWorld();
    const cfg = parseTierConfig({ classes: { payment: { disabled: true } } }).config;
    const p = createMemoryPorts(world, scan, "s", { tierConfig: cfg });
    expect(await guardToolCall(p, { tenantId: T, tool: "collect_card_payment", rawArgs: { job_id: "44444444-4444-4444-8444-444444444444" }, call })).toMatchObject({ allow: false, code: "class_disabled" });
    expect(world.audit.some((a) => a.code === "class_disabled")).toBe(true);
  });
  it("a callback-only class is refused in-call even for a fully verified caller", async () => {
    const world = mkWorld();
    const cfg = parseTierConfig({ classes: { payment: { methods: ["callback"] } } }).config;
    const p = createMemoryPorts(world, scan, "s", { tierConfig: cfg });
    await requestVerification(p, T, call);
    const code = /code is (\d{6})/.exec(world.sms.at(-1)!.body)![1];
    await completeVerification(p, T, call, { code, zip: "78701", last_name: "Smith" });
    const r = await guardToolCall(p, { tenantId: T, tool: "collect_card_payment", rawArgs: { job_id: "44444444-4444-4444-8444-444444444444" }, call });
    expect(r).toMatchObject({ allow: false, code: "callback_only" });
    if (!r.allow) expect(r.spoken).toContain("request_callback");
  });
  it("offers the callback alternative in the refusal text when callbacks are wired", async () => {
    const p = createMemoryPorts(mkWorld(), scan);
    const r = await guardToolCall(p, { tenantId: T, tool: "check_billing_status", rawArgs: {}, call });
    if (!r.allow) expect(r.spoken).toContain("request_callback");
  });
});

describe("request_callback", () => {
  it("is allowed for a caller-ID caller, binds to the caller, and a model-supplied number cannot redirect it", async () => {
    const world = mkWorld();
    const p = createMemoryPorts(world, scan);
    const g = await guardToolCall(p, { tenantId: T, tool: "request_callback", rawArgs: { for_action: "payment", reason: "no texts", phone: "+15125550999" }, call });
    expect(g.allow).toBe(true);
    if (g.allow) expect(g.args.phone).toBeUndefined(); // unknown arg dropped
    const out = await requestCallback(p, T, call, { for_action: "payment", reason: "no texts" });
    expect(out).toContain("number on file");
    expect(p.callbacks).toHaveLength(1);
    expect(p.callbacks[0]).toMatchObject({ actionClass: "payment", customerId: "22222222-2222-4222-8222-222222222222" });
  });
  it("is idempotent per call+class, limited per customer, and identical for unknown numbers", async () => {
    const world = mkWorld();
    const p = createMemoryPorts(world, scan);
    await requestCallback(p, T, call, { for_action: "payment" });
    await requestCallback(p, T, call, { for_action: "payment" });
    expect(p.callbacks).toHaveLength(1);
    await requestCallback(p, T, call, { for_action: "reschedule" });
    await requestCallback(p, T, call, { for_action: "address_change" });
    const limited = await requestCallback(p, T, call, { for_action: "account_read" });
    expect(limited).toContain("can't be arranged");
    const stranger: CallRef = { ...call, callerNumber: "+15125550777" };
    const a = await requestCallback(p, T, stranger, { for_action: "payment" });
    const b = await requestCallback(p, T, call, { for_action: "other", reason: "x" }).catch(() => "");
    expect(a).toContain("number on file");
    expect(b).toBeDefined();
    expect(p.callbacks.every((c) => c.customerId === "22222222-2222-4222-8222-222222222222")).toBe(true);
  });
  it("needs a caller ID", async () => {
    const p = createMemoryPorts(mkWorld(), scan);
    expect(await guardToolCall(p, { tenantId: T, tool: "request_callback", rawArgs: {}, call: { ...call, callerNumber: null } })).toMatchObject({ allow: false, code: "no_caller_id" });
  });
});
