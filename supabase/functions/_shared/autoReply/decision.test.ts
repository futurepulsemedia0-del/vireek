import { describe, it, expect } from "vitest";
import {
  DEFAULT_ESCALATION_KEYWORDS,
  combineConfidence,
  decideAction,
  findEscalationKeyword,
  findReplyViolations,
  finalizeReply,
  isAutomatedSender,
  isBusinessOpen,
  isCarrierKeyword,
  parseModelOutput,
  sanitizeKeywords,
  summarizeHours,
  truncateAtBoundary,
} from "./decision.ts";

describe("findEscalationKeyword", () => {
  it("matches built-in safety words as whole words", () => {
    expect(findEscalationKeyword("I smell gas in the basement!")).toBe("smell gas");
    expect(findEscalationKeyword("There is a FIRE near the panel")).toBe("fire");
  });

  it("does not match inside longer words", () => {
    expect(findEscalationKeyword("Do you service fireplaces and homeowner policies?")).toBeNull();
    expect(findEscalationKeyword("What is the human resources number")).toBe("human"); // whole word → escalates (conservative)
  });

  it("matches owner keywords first, case-insensitively, including phrases", () => {
    expect(findEscalationKeyword("Need a Quote For Mold removal", ["mold removal"])).toBe("mold removal");
  });

  it("supports non-English keywords", () => {
    expect(findEscalationKeyword("نشت گاز داریم")).toBe("نشت گاز");
    expect(findEscalationKeyword("necesito un abogado")).toBe("abogado");
  });

  it("can disable the built-in list", () => {
    expect(findEscalationKeyword("gas leak", [], false)).toBeNull();
    expect(findEscalationKeyword("gas leak", ["leak"], false)).toBe("leak");
  });

  it("is safe against regex metacharacters in owner keywords", () => {
    expect(findEscalationKeyword("price is $5 (cheap)", ["(cheap)"])).toBe("(cheap)");
    expect(findEscalationKeyword("anything", [".*"])).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(findEscalationKeyword("   ")).toBeNull();
    expect(DEFAULT_ESCALATION_KEYWORDS.length).toBeGreaterThan(20);
  });
});

describe("sanitizeKeywords", () => {
  it("trims, de-duplicates case-insensitively and caps", () => {
    expect(sanitizeKeywords(["  Mold ", "mold", "", "Asbestos"])).toEqual(["Mold", "Asbestos"]);
    expect(sanitizeKeywords(Array.from({ length: 300 }, (_, i) => `k${i}`)).length).toBe(100);
    expect(sanitizeKeywords(null)).toEqual([]);
  });
});

describe("isCarrierKeyword", () => {
  it("recognises carrier-owned keywords only when they are the whole message", () => {
    expect(isCarrierKeyword("stop")).toBe(true);
    expect(isCarrierKeyword(" HELP! ")).toBe(true);
    expect(isCarrierKeyword("please stop by tomorrow")).toBe(false);
  });
});

describe("isAutomatedSender", () => {
  it("flags robots, bounces and auto-responders", () => {
    expect(isAutomatedSender("no-reply@shop.com")).toBe(true);
    expect(isAutomatedSender("MAILER-DAEMON@x.com")).toBe(true);
    expect(isAutomatedSender("jane@x.com", { "Auto-Submitted": "auto-replied" })).toBe(true);
    expect(isAutomatedSender("jane@x.com", { Precedence: "bulk" })).toBe(true);
    expect(isAutomatedSender("jane@x.com", { "List-Unsubscribe": "<mailto:x>" })).toBe(true);
    expect(isAutomatedSender("jane@x.com", null, "Out of office until Monday")).toBe(true);
  });
  it("lets real customers through", () => {
    expect(isAutomatedSender("jane@x.com", { "Auto-Submitted": "no" }, "Question about my quote")).toBe(false);
  });
});

describe("isBusinessOpen", () => {
  const hours = { mon: { open: "08:00", close: "17:00" }, tue: { closed: true }, sat: { open: "22:00", close: "02:00" } };
  // 2026-10-05 is a Monday
  it("respects the configured timezone", () => {
    // 14:00 UTC = 10:00 New York (EDT) → open
    expect(isBusinessOpen(hours, null, new Date("2026-10-05T14:00:00Z"), "America/New_York")).toBe(true);
    // 11:00 UTC = 07:00 New York → closed
    expect(isBusinessOpen(hours, null, new Date("2026-10-05T11:00:00Z"), "America/New_York")).toBe(false);
  });
  it("treats closed days, missing days and holidays as closed", () => {
    expect(isBusinessOpen(hours, null, new Date("2026-10-06T15:00:00Z"), "UTC")).toBe(false);
    expect(isBusinessOpen(hours, null, new Date("2026-10-07T15:00:00Z"), "UTC")).toBe(false);
    expect(isBusinessOpen(hours, [{ date: "2026-10-05" }], new Date("2026-10-05T15:00:00Z"), "UTC")).toBe(false);
  });
  it("handles overnight ranges", () => {
    expect(isBusinessOpen(hours, null, new Date("2026-10-10T23:30:00Z"), "UTC")).toBe(true); // Saturday 23:30
    expect(isBusinessOpen(hours, null, new Date("2026-10-10T12:00:00Z"), "UTC")).toBe(false);
  });
  it("returns null when no hours are configured and falls back on a bad timezone", () => {
    expect(isBusinessOpen(null, null, new Date(), "UTC")).toBeNull();
    expect(isBusinessOpen({}, null, new Date(), "UTC")).toBeNull();
    expect(isBusinessOpen(hours, null, new Date("2026-10-05T14:00:00Z"), "Not/AZone")).toBe(true);
  });
  it("summarises hours for the prompt", () => {
    expect(summarizeHours(hours)).toContain("Mon 08:00-17:00");
    expect(summarizeHours(hours)).toContain("Tue closed");
    expect(summarizeHours(null)).toBeNull();
  });
});

describe("parseModelOutput", () => {
  it("parses clean JSON and clamps values", () => {
    const out = parseModelOutput('{"reply":"We open at 8.","confidence":1.7,"intent":"faq","needs_human":false,"reason":"in kb"}');
    expect(out).toEqual({ reply: "We open at 8.", confidence: 1, intent: "faq", needsHuman: false, reason: "in kb" });
  });
  it("tolerates code fences and surrounding prose", () => {
    const out = parseModelOutput('Sure!\n```json\n{"reply":"Hi","confidence":0.8,"intent":"smalltalk","needs_human":false}\n```');
    expect(out?.reply).toBe("Hi");
    expect(out?.intent).toBe("smalltalk");
  });
  it("defaults unknown intents and bad confidence safely", () => {
    const out = parseModelOutput('{"reply":"Hi","confidence":"high","intent":"weird"}');
    expect(out?.intent).toBe("other");
    expect(out?.confidence).toBe(0);
  });
  it("rejects garbage and empty replies", () => {
    expect(parseModelOutput("")).toBeNull();
    expect(parseModelOutput("not json")).toBeNull();
    expect(parseModelOutput('{"reply":"","confidence":0.9}')).toBeNull();
    expect(parseModelOutput('{"reply":"","needs_human":true}')?.needsHuman).toBe(true);
  });
});

describe("combineConfidence", () => {
  it("caps by retrieval quality for knowledge-bound intents", () => {
    expect(combineConfidence({ intent: "faq", modelConfidence: 0.98, tier: "no_coverage" })).toBe(0);
    expect(combineConfidence({ intent: "pricing", modelConfidence: 0.98, tier: "weak_match" })).toBe(0.55);
    expect(combineConfidence({ intent: "faq", modelConfidence: 0.9, tier: "confident" })).toBe(0.9);
  });
  it("does not require KB coverage for small talk and booking", () => {
    expect(combineConfidence({ intent: "smalltalk", modelConfidence: 0.99, tier: "no_coverage" })).toBe(0.95);
    expect(combineConfidence({ intent: "booking", modelConfidence: 0.8, tier: "no_coverage" })).toBe(0.8);
  });
  it("treats NaN as zero", () => {
    expect(combineConfidence({ intent: "faq", modelConfidence: NaN, tier: "confident" })).toBe(0);
  });
});

describe("findReplyViolations", () => {
  const ctx = { groundingText: "Diagnostic visit is $89. Open 8-5.", allowedUrls: ["https://app.vireek.com/book/acme"] };
  it("passes a grounded reply with the allowed booking link", () => {
    expect(findReplyViolations("A visit is $89. Book here: https://app.vireek.com/book/acme.", ctx)).toEqual([]);
  });
  it("blocks links that are not the booking link", () => {
    expect(findReplyViolations("See www.evil.com for details", ctx)).toContain("url_not_allowed");
  });
  it("blocks prices that are not in the knowledge base", () => {
    expect(findReplyViolations("That will cost $120.", ctx)).toContain("ungrounded_amount");
    expect(findReplyViolations("That will cost 120 dollars.", ctx)).toContain("ungrounded_amount");
  });
  it("blocks self-made commitments and human claims", () => {
    expect(findReplyViolations("Great, you're booked for Tuesday!", ctx)).toContain("unauthorised_commitment");
    expect(findReplyViolations("Our technician will arrive at 3pm", ctx)).toContain("unauthorised_commitment");
    expect(findReplyViolations("I'm a real person, promise", ctx)).toContain("claims_to_be_human");
  });
});

describe("finalizeReply / truncateAtBoundary", () => {
  it("strips markdown and flattens SMS", () => {
    expect(finalizeReply("**Hi**\nWe open at 8.", { channel: "sms" })).toBe("Hi We open at 8.");
  });
  it("keeps SMS within 320 chars including the signature and cuts on a sentence", () => {
    const long = "This is a sentence about our service area. ".repeat(20);
    const out = finalizeReply(long, { channel: "sms", signature: "— Acme bot", includeSignature: true });
    expect(out.length).toBeLessThan(321);
    expect(out.endsWith("— Acme bot")).toBe(true);
    expect(out).toContain("service area.");
  });
  it("adds the email signature on its own paragraph", () => {
    expect(finalizeReply("Hello!", { channel: "email", signature: "— Acme", includeSignature: true })).toBe("Hello!\n\n— Acme");
  });
  it("truncates on a word boundary when no sentence end exists", () => {
    expect(truncateAtBoundary("aaaa bbbb cccc dddd", 12)).toBe("aaaa bbbb");
  });
});

describe("decideAction", () => {
  const base = { mode: "auto" as const, threshold: 0.8, confidence: 0.9, modelNeedsHuman: false, violations: [] as string[] };
  it("sends in auto mode above the threshold", () => {
    expect(decideAction(base)).toEqual({ action: "send", reason: "auto_sent" });
  });
  it("queues below the threshold", () => {
    expect(decideAction({ ...base, confidence: 0.79 })).toEqual({ action: "queue", reason: "below_threshold" });
  });
  it("always queues in approval mode", () => {
    expect(decideAction({ ...base, mode: "approval" })).toEqual({ action: "queue", reason: "approval_mode" });
  });
  it("queues on any violation even at 100% confidence", () => {
    expect(decideAction({ ...base, confidence: 1, violations: ["ungrounded_amount"] })).toEqual({ action: "queue", reason: "guard_ungrounded_amount" });
  });
  it("escalates when the model asks for a human, before anything else", () => {
    expect(decideAction({ ...base, modelNeedsHuman: true, violations: ["x"] })).toEqual({ action: "escalate", reason: "model_requested_human" });
  });
});
