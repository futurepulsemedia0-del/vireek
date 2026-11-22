import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redact, redactError, safeConsole } from "./core.ts";

const written: string[] = [];
const text = (a: unknown[]) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
beforeEach(() => {
  written.length = 0;
  for (const l of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, l).mockImplementation((...a: unknown[]) => { written.push(text(a)); });
});
afterEach(() => vi.restoreAllMocks());

const PII = ["+14155550100", "(415) 555-0100", "jane.doe@example.com", "123 Main St", "4500 N. Central Avenue Apt 4", "Jane Doe"];
const clean = () => { const all = written.join("\n"); for (const p of PII) expect(all).not.toContain(p); return all; };

describe("redact: phone, email, address", () => {
  it("scrubs free text", () => {
    expect(redact("call +1 415 555 0100 or (415) 555-0100")).toBe("call [number] or [number]");
    expect(redact("mail jane.doe@example.com")).toBe("mail [email]");
    expect(redact("at 123 Main St, then 4500 N. Central Avenue Apt 4")).toBe("at [address], then [address]");
  });
  it("redacts PII-named keys and keeps ids", () => {
    expect(redact({ caller_phone: "+14155550100", address: "123 Main St", customer_name: "Jane Doe", street: "x", zip: "94110", call_id: "c1" }))
      .toEqual({ caller_phone: "[redacted]", address: "[redacted]", customer_name: "[redacted]", street: "[redacted]", zip: "[redacted]", call_id: "c1" });
  });
  it("redacts inside Error objects", () => expect(redactError(new Error("failed for jane.doe@example.com"))).toBe("Error: failed for [email]"));
});

describe("safeConsole", () => {
  it("redacts a serialised request body / payload by key", () => {
    safeConsole.log(JSON.stringify({ event: "received", requestId: "r1", payload: { caller_phone: "+14155550100", address: "123 Main St", name: "Jane Doe" } }));
    expect(clean()).toContain("r1");
  });
  it("scrubs PII inside values of non-PII keys", () => {
    safeConsole.log(JSON.stringify({ event: "ready", technician: "+14155550100", customer: "(415) 555-0100", issue: "leak at 123 Main St, call jane.doe@example.com" }));
    clean();
  });
  it("scrubs positional args, errors and objects on every level", () => {
    safeConsole.error("Send failed for", "jane.doe@example.com", new Error("boom at 123 Main St"));
    safeConsole.warn({ customer_name: "Jane Doe", id: "c1" });
    safeConsole.info("note", "4500 N. Central Avenue Apt 4");
    safeConsole.debug("p", "+14155550100");
    expect(clean()).toContain("c1");
  });
  it("non-JSON strings that merely start with a brace are still scrubbed", () => {
    safeConsole.log("{not json} jane.doe@example.com");
    clean();
  });
});
