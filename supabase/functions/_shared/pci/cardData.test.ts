import { describe, it, expect } from "vitest";
import {
  assertNoCardData,
  CardDataLeakError,
  containsCardData,
  deepRedact,
  findCardData,
  luhnValid,
  maskedCardLabel,
  redactCardData,
} from "./cardData";

const VISA = "4111111111111111";
const AMEX = "378282246310005";
const MC = "5555555555554444";

describe("luhnValid", () => {
  it("accepts well-known test cards and rejects altered ones", () => {
    expect(luhnValid(VISA)).toBe(true);
    expect(luhnValid(AMEX)).toBe(true);
    expect(luhnValid(MC)).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("abc")).toBe(false);
  });
});

describe("PAN detection", () => {
  it.each([
    ["plain", `card ${VISA} thanks`],
    ["spaces", "card 4111 1111 1111 1111 thanks"],
    ["dashes", "card 4111-1111-1111-1111 thanks"],
    ["dots", "card 4111.1111.1111.1111 thanks"],
    ["amex 4-6-5", "card 3782 822463 10005 thanks"],
    ["mastercard", `my number is ${MC}`],
    ["spoken digits", "it is four one one one one one one one one one one one one one one one"],
    ["spoken with doubles", "four double one one one one one one one one one one one one one"],
    ["mixed groups", "four one one one 1111 one one one one 1 1 1 1"],
  ])("redacts %s", (_n, text) => {
    const r = redactCardData(text, { strict: true });
    expect(r.findings.some((f) => f.kind === "pan")).toBe(true);
    expect(r.text).toContain("[REDACTED-CARD]");
    expect(r.text).not.toMatch(/\d{4}[\s.-]?\d{4}/);
  });

  it("catches a mis-transcribed (Luhn-invalid) card in strict mode only", () => {
    const bad = "4111111111111112";
    expect(containsCardData(`number ${bad}`)).toBe(false);
    expect(containsCardData(`number ${bad}`, { strict: true })).toBe(true);
  });

  it("catches two cards glued together", () => {
    expect(containsCardData(`${VISA}${MC}`)).toBe(true);
  });

  it("findings never contain the digits", () => {
    const f = findCardData(`pay with ${VISA}`, { strict: true });
    expect(JSON.stringify(f)).not.toContain("4111");
  });
});

describe("no false positives on ordinary call data", () => {
  it.each([
    "call me at 555 123 4567",
    "call me at +1 (415) 555-0132 tomorrow",
    "my zip is 94107 and the job is 2027 dollars",
    "epoch 1761000000000 and 1761000000123",
    "invoice INV-20271018-0042 for $1,234.56",
    "I want to pay for it, to be honest, for two weeks, oh well",
    "arrive between two and four, then for the three of us",
    "order 20271018000000 shipped",
    "the unit is a 3 ton 14 SEER system installed in 2019",
    "1-800-555-1234 or 1-800-555-9876",
  ])("leaves %j alone", (text) => {
    expect(redactCardData(text, { strict: true }).text).toBe(text);
  });
});

describe("CVV and expiry", () => {
  it("redacts numeric CVV and expiry next to keywords", () => {
    const r = redactCardData("the cvv is 123 and it expires 08/27", { strict: true });
    expect(r.text).toContain("[REDACTED-CVV]");
    expect(r.text).toContain("[REDACTED-EXPIRY]");
    expect(r.text).not.toContain("123");
    expect(r.text).not.toContain("08/27");
  });
  it("redacts spoken security codes", () => {
    const r = redactCardData("security code is three one two", { strict: true });
    expect(r.text).toContain("[REDACTED-CVV]");
    expect(r.text).not.toMatch(/three one two/);
  });
  it("does not touch the word cvv with no digits", () => {
    expect(redactCardData("what is a cvv exactly").text).toBe("what is a cvv exactly");
  });
});

describe("deepRedact", () => {
  it("redacts sensitive keys and card-like strings at any depth, without mutating input", () => {
    const input = { a: { card_number: VISA, note: `paid with ${VISA}` }, list: [`x ${MC}`, 5], cvv: "123", ok: "fine" };
    const out = deepRedact(input);
    expect(JSON.stringify(out)).not.toContain("4111");
    expect(JSON.stringify(out)).not.toContain("5555");
    expect(out.a.card_number).toBe("[REDACTED]");
    expect(out.cvv).toBe("[REDACTED]");
    expect(out.ok).toBe("fine");
    expect(input.a.card_number).toBe(VISA);
  });
  it("is cycle-safe and redacts Error messages", () => {
    const a: Record<string, unknown> = { name: "x" };
    a.self = a;
    expect(() => deepRedact(a)).not.toThrow();
    expect(JSON.stringify(deepRedact(new Error(`bad ${VISA}`)))).not.toContain("4111");
  });
});

describe("assertNoCardData", () => {
  it("throws without echoing the number", () => {
    try {
      assertNoCardData({ x: [`n=${VISA}`] }, "unit test");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CardDataLeakError);
      expect((e as Error).message).not.toContain("4111");
    }
  });
  it("passes clean data, masked labels and numbers", () => {
    expect(() => assertNoCardData({ brand: "visa", last4: "1111", amount_cents: 12500 }, "ok")).not.toThrow();
    expect(maskedCardLabel("visa", "1111")).toBe("visa •••• 1111");
    expect(maskedCardLabel(null, "12")).toBe("card •••• ????");
  });
});
