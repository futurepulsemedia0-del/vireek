import { describe, expect, it } from "vitest";
import {
  isLegacySecretHeaderAccepted,
  timingSafeEqualStr,
  verifyVapiRequestSecret,
  verifyVapiSecret,
} from "./webhookAuth.ts";

const SECRET = "s3cret-value-0123456789";
const h = (init: Record<string, string>) => new Headers(init);

describe("timingSafeEqualStr", () => {
  it("is true only for identical strings", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("", "")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("héllo✓", "héllo✓")).toBe(true);
    expect(timingSafeEqualStr("héllo✓", "héllo✗")).toBe(false);
  });
  it("never treats a prefix/extension as equal (length is part of the result)", () => {
    expect(timingSafeEqualStr(SECRET, SECRET + "x")).toBe(false);
    expect(timingSafeEqualStr(SECRET + "x", SECRET)).toBe(false);
    expect(timingSafeEqualStr(SECRET, SECRET.slice(0, -1))).toBe(false);
    expect(timingSafeEqualStr("", "a")).toBe(false);
    expect(timingSafeEqualStr("a", "")).toBe(false);
    expect(timingSafeEqualStr("abc", "abc\u0000")).toBe(false);
  });
});

describe("verifyVapiSecret", () => {
  it("fails closed without a configured secret, and on empty/missing input", () => {
    expect(verifyVapiSecret("anything", undefined)).toBe(false);
    expect(verifyVapiSecret("anything", null)).toBe(false);
    expect(verifyVapiSecret("", "")).toBe(false);
    expect(verifyVapiSecret("", SECRET)).toBe(false);
    expect(verifyVapiSecret(undefined, SECRET)).toBe(false);
    expect(verifyVapiSecret(null, SECRET)).toBe(false);
    expect(verifyVapiSecret(SECRET, SECRET)).toBe(true);
  });
});

describe("verifyVapiRequestSecret", () => {
  it("accepts the current Bearer credential", () => {
    expect(verifyVapiRequestSecret(h({ authorization: `Bearer ${SECRET}` }), SECRET)).toEqual({ ok: true, via: "authorization" });
  });
  it("accepts the Bearer scheme case-insensitively and a raw token (Vapi 'Include Bearer Prefix' off)", () => {
    expect(verifyVapiRequestSecret(h({ authorization: `bearer   ${SECRET}` }), SECRET).ok).toBe(true);
    expect(verifyVapiRequestSecret(h({ authorization: SECRET }), SECRET)).toEqual({ ok: true, via: "authorization" });
  });
  it("accepts the legacy x-vapi-secret header", () => {
    expect(verifyVapiRequestSecret(h({ "x-vapi-secret": SECRET }), SECRET)).toEqual({ ok: true, via: "x-vapi-secret" });
    expect(verifyVapiRequestSecret(h({ "X-VAPI-SECRET": SECRET }), SECRET).ok).toBe(true);
  });
  it("reports 'authorization' when both headers are valid", () => {
    expect(verifyVapiRequestSecret(h({ authorization: `Bearer ${SECRET}`, "x-vapi-secret": SECRET }), SECRET).via).toBe("authorization");
  });
  it("voice-reconcile shape: legacy header valid + Authorization carrying the service-role key -> accepted via legacy", () => {
    const res = verifyVapiRequestSecret(h({ "x-vapi-secret": SECRET, authorization: "Bearer service-role-key-not-the-secret" }), SECRET);
    expect(res).toEqual({ ok: true, via: "x-vapi-secret" });
  });
  it("the service-role key alone is never accepted", () => {
    expect(verifyVapiRequestSecret(h({ authorization: "Bearer service-role-key-not-the-secret" }), SECRET).ok).toBe(false);
  });
  it("rejects missing, empty, wrong, truncated and extended values in either header", () => {
    const bad = [
      {},
      { authorization: "" },
      { authorization: "Bearer " },
      { authorization: "Bearer" },
      { authorization: `Basic ${SECRET}` },
      { authorization: `Bearer ${SECRET}x` },
      { authorization: `Bearer ${SECRET.slice(0, -1)}` },
      { "x-vapi-secret": "" },
      { "x-vapi-secret": "nope" },
      { "x-vapi-secret": SECRET + "x" },
      { "x-vapi-secret": SECRET.slice(0, -1) },
    ];
    for (const headers of bad) expect(verifyVapiRequestSecret(h(headers), SECRET)).toEqual({ ok: false, via: null });
  });
  it("fails closed when no secret is configured, even if the header is empty-equal", () => {
    for (const expected of [undefined, null, ""]) {
      expect(verifyVapiRequestSecret(h({ "x-vapi-secret": "" }), expected).ok).toBe(false);
      expect(verifyVapiRequestSecret(h({ authorization: "Bearer " }), expected).ok).toBe(false);
      expect(verifyVapiRequestSecret(h({ authorization: "Bearer x", "x-vapi-secret": "x" }), expected).ok).toBe(false);
    }
  });
  it("acceptLegacyHeader:false rejects x-vapi-secret alone but still accepts Bearer", () => {
    expect(verifyVapiRequestSecret(h({ "x-vapi-secret": SECRET }), SECRET, { acceptLegacyHeader: false }).ok).toBe(false);
    expect(verifyVapiRequestSecret(h({ authorization: `Bearer ${SECRET}` }), SECRET, { acceptLegacyHeader: false }).ok).toBe(true);
    expect(verifyVapiRequestSecret(h({ authorization: `Bearer ${SECRET}`, "x-vapi-secret": SECRET }), SECRET, { acceptLegacyHeader: false }).via).toBe("authorization");
  });
  it("works with plain header records (Node-style, mixed case, array values, null)", () => {
    expect(verifyVapiRequestSecret({ Authorization: `Bearer ${SECRET}` }, SECRET).ok).toBe(true);
    expect(verifyVapiRequestSecret({ "X-Vapi-Secret": [SECRET, "other"] }, SECRET).ok).toBe(true);
    expect(verifyVapiRequestSecret({ "x-vapi-secret": null, authorization: undefined }, SECRET).ok).toBe(false);
    expect(verifyVapiRequestSecret({}, SECRET).ok).toBe(false);
  });
});

describe("isLegacySecretHeaderAccepted", () => {
  it("defaults to ON; only explicit off values turn it off", () => {
    for (const v of [undefined, null, "", "1", "true", "on", "yes", "garbage"]) expect(isLegacySecretHeaderAccepted(v)).toBe(true);
    for (const v of ["0", "false", "FALSE", "off", "Off", "no", " 0 "]) expect(isLegacySecretHeaderAccepted(v)).toBe(false);
  });
});
