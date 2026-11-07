// @vitest-environment node
import { describe, it, expect } from "vitest";
import { batchCost, corsHeadersFor, originAllowed, parseAllowedOrigins, protocolHeaderValid } from "./guards.ts";

describe("agent-network guards", () => {
  const allowed = parseAllowedOrigins("https://app.vireek.com/, http://localhost:5173, not-a-url, https://evil.com/path");

  it("parses only well-formed origins", () => {
    expect(allowed).toEqual(["https://app.vireek.com", "http://localhost:5173"]);
  });
  it("allows non-browser clients (no Origin) and allow-listed origins only", () => {
    expect(originAllowed(null, allowed)).toBe(true);
    expect(originAllowed("https://app.vireek.com", allowed)).toBe(true);
    expect(originAllowed("https://APP.vireek.com/", allowed)).toBe(true);
    expect(originAllowed("https://evil.com", allowed)).toBe(false);
    expect(originAllowed("http://127.0.0.1:5173", allowed)).toBe(false); // DNS-rebinding style origin
  });
  it("empty allow-list blocks every browser origin", () => {
    expect(originAllowed("https://app.vireek.com", [])).toBe(false);
  });
  it("CORS never uses a wildcard and reflects only allowed origins", () => {
    expect(corsHeadersFor("https://app.vireek.com", allowed)["Access-Control-Allow-Origin"]).toBe("https://app.vireek.com");
    expect(corsHeadersFor("https://evil.com", allowed)["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeadersFor(null, allowed)["Access-Control-Allow-Origin"]).toBeUndefined();
  });
  it("validates MCP-Protocol-Version", () => {
    expect(protocolHeaderValid(null)).toBe(true);
    expect(protocolHeaderValid("2025-06-18")).toBe(true);
    expect(protocolHeaderValid("1999-01-01")).toBe(false);
  });
  it("a batch costs one unit per message, capped", () => {
    expect(batchCost(1)).toBe(1);
    expect(batchCost(20)).toBe(20);
    expect(batchCost(500)).toBe(20);
    expect(batchCost(0)).toBe(1);
    expect(batchCost(NaN)).toBe(1);
  });
});
