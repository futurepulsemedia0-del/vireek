import { describe, it, expect } from "vitest";
import {
  buildCard, CardError, clip, encodePostback, formatMoney, formatWhen, LIMITS, parsePostback, renderCardAsText, validateContent,
} from "./cards.ts";
import type { RichContent } from "./types.ts";

const brand = { name: "Acme HVAC", phone: "+15559998888" };
const card = (c: RichContent) => (c.kind === "card" ? c.card : (() => { throw new Error("not a card"); })());

describe("helpers", () => {
  it("clip keeps short text and ellipsises long text within the limit", () => {
    expect(clip("hello", 10)).toBe("hello");
    const out = clip("x".repeat(50), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("postback round-trips and strips unsafe characters", () => {
    const p = encodePostback("reschedule", "job 123;DROP");
    expect(p).toBe("act:reschedule:job123DROP");
    expect(parsePostback(p)).toEqual({ action: "reschedule", ref: "job123DROP" });
    expect(parsePostback("hello")).toBeNull();
    expect(parsePostback(null)).toBeNull();
  });

  it("formats dates in the customer's timezone without narrow no-break spaces", () => {
    const s = formatWhen("2026-10-07T20:00:00Z", "America/New_York");
    expect(s).toBe("Wed, Oct 7, 4:00 PM");
    expect(s).not.toMatch(/[\u202f\u00a0]/);
    expect(formatWhen("garbage", "UTC")).toBe("");
    expect(formatWhen("2026-10-07T20:00:00Z", "Not/AZone")).toContain("8:00 PM"); // falls back to UTC
  });

  it("formats money", () => {
    expect(formatMoney(12500)).toBe("$125.00");
    expect(formatMoney(5, "USD")).toBe("$0.05");
  });
});

describe("card templates", () => {
  it("booking confirmation: details, manage link, reschedule button, call button, SMS fallback", () => {
    const c = buildCard({ template: "booking_confirmation", jobId: "j1", service: "AC tune-up", startsAt: "2026-10-07T20:00:00Z", timeZone: "America/New_York", address: "12 Elm St", manageUrl: "https://app.example.com/b/j1" }, brand);
    const k = card(c);
    expect(k.title).toBe("Booking confirmed");
    expect(k.description).toContain("AC tune-up");
    expect(k.description).toContain("Wed, Oct 7, 4:00 PM");
    expect(k.actions.map((a) => a.type)).toEqual(["url", "reply", "call"]);
    expect(validateContent(c)).toBeNull();
    const fb = (c as { fallbackText: string }).fallbackText;
    expect(fb).toContain("Acme HVAC: Booking confirmed");
    expect(fb).toContain("View details: https://app.example.com/b/j1");
    expect(fb).toContain("Reply RESCHEDULE to reschedule.");
    expect(fb).toContain("Call us: +15559998888");
  });

  it("technician ETA: minutes and absolute time variants", () => {
    const a = card(buildCard({ template: "technician_eta", jobId: "j1", technicianName: "Sam", etaMinutes: 25, timeZone: "UTC", trackUrl: "https://t.example.com/x" }, brand));
    expect(a.title).toBe("Sam is on the way");
    expect(a.description).toBe("Arriving in about 25 min");
    const b = card(buildCard({ template: "technician_eta", jobId: "j1", technicianName: "Sam", etaAt: "2026-10-07T20:30:00Z", timeZone: "America/New_York", vehicle: "White van" }, brand));
    expect(b.description).toBe("Arriving around 4:30 PM\nWhite van");
    expect(() => buildCard({ template: "technician_eta", jobId: "j1", technicianName: "Sam", timeZone: "UTC" }, brand)).toThrow(CardError);
  });

  it("pay-now: amount in title, https pay button first, never builds with a bad URL", () => {
    const c = buildCard({ template: "pay_now", invoiceRef: "INV-7", amountCents: 12500, payUrl: "https://pay.example.com/i/7", description: "Furnace repair", dueDate: "2026-10-20T12:00:00Z" }, brand);
    const k = card(c);
    expect(k.title).toBe("Invoice INV-7 · $125.00");
    expect(k.description).toBe("Furnace repair\nDue Oct 20");
    expect(k.actions[0]).toEqual({ type: "url", label: "Pay now", value: "https://pay.example.com/i/7" });
    expect(() => buildCard({ template: "pay_now", invoiceRef: "I", amountCents: 100, payUrl: "http://insecure.example.com" }, brand)).toThrow(CardError);
    expect(() => buildCard({ template: "pay_now", invoiceRef: "I", amountCents: 100, payUrl: "javascript:alert(1)" }, brand)).toThrow(CardError);
    expect(() => buildCard({ template: "pay_now", invoiceRef: "I", amountCents: 0, payUrl: "https://x.example.com" }, brand)).toThrow(CardError);
  });

  it("reschedule: self-serve link optional, keep/reschedule replies always present", () => {
    const k = card(buildCard({ template: "reschedule", jobId: "j1", service: "Install", startsAt: "2026-10-07T20:00:00Z", timeZone: "America/New_York" }, brand));
    expect(k.actions.map((a) => a.label)).toEqual(["Reschedule", "Keep appointment"]);
    const withUrl = card(buildCard({ template: "reschedule", jobId: "j1", service: "Install", startsAt: "2026-10-07T20:00:00Z", timeZone: "UTC", rescheduleUrl: "https://r.example.com/j1" }, brand));
    expect(withUrl.actions[0].label).toBe("Pick a new time");
  });

  it("falls back to a neutral brand name and omits an invalid phone", () => {
    const c = buildCard({ template: "booking_confirmation", jobId: "j", service: "S", startsAt: "2026-10-07T20:00:00Z", timeZone: "UTC" }, { name: " ", phone: "555-1234" });
    expect((c as { fallbackText: string }).fallbackText.startsWith("Your service team:")).toBe(true);
    expect(card(c).actions.some((a) => a.type === "call")).toBe(false);
  });

  it("rejects an invalid date", () => {
    expect(() => buildCard({ template: "booking_confirmation", jobId: "j", service: "S", startsAt: "soon", timeZone: "UTC" }, brand)).toThrow(CardError);
  });
});

describe("validateContent", () => {
  const ok: RichContent = { kind: "card", fallbackText: "x", card: { title: "T", actions: [] } };

  it("accepts a minimal card and text", () => {
    expect(validateContent(ok)).toBeNull();
    expect(validateContent({ kind: "text", text: "hi" })).toBeNull();
  });

  it("enforces limits", () => {
    expect(validateContent({ kind: "text", text: "" })).toMatch(/required/);
    expect(validateContent({ kind: "text", text: "x".repeat(LIMITS.text + 1) })).toMatch(/exceeds/);
    expect(validateContent({ ...ok, card: { title: "x".repeat(LIMITS.title + 1), actions: [] } } as RichContent)).toMatch(/title/);
    const five = Array.from({ length: 5 }, (_, i) => ({ type: "reply" as const, label: `L${i}`, value: `v${i}` }));
    expect(validateContent({ ...ok, card: { title: "T", actions: five } } as RichContent)).toMatch(/at most/);
    expect(validateContent({ ...ok, card: { title: "T", actions: [{ type: "reply", label: "x".repeat(26), value: "v" }] } } as RichContent)).toMatch(/label/);
    expect(validateContent({ ...ok, card: { title: "T", imageUrl: "http://x.example.com/a.png", actions: [] } } as RichContent)).toMatch(/image/);
    expect(validateContent({ ...ok, card: { title: "T", actions: [{ type: "call", label: "Call", value: "123" }] } } as RichContent)).toMatch(/E\.164/);
  });
});

describe("renderCardAsText", () => {
  it("never exceeds the SMS-safe limit", () => {
    const out = renderCardAsText({ title: "T", description: "d".repeat(400), actions: [{ type: "url", label: "Go", value: `https://x.example.com/${"a".repeat(1500)}` }] }, "B");
    expect(out.length).toBeLessThanOrEqual(LIMITS.text);
  });
});
