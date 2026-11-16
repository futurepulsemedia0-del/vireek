import { describe, expect, it } from "vitest";
import { buildLogRow, buildTurn, logAnswer, type InsertClient, type TurnInput } from "./siteAssistantTurn";

const base = (over: Partial<TurnInput> = {}): TurnInput => ({
  question: "How much does Vireek cost?", available: true, grounded: true, topSimilarity: 0.7, fromCache: false,
  chunks: [{ title: "Pricing", url: "https://vireek.com/pricing", similarity: 0.7 }], kbBlock: "[Pricing — /pricing]\nPlans start at ...", ...over,
});

describe("buildTurn", () => {
  it("grounded: injects the KB block, builds safe sources and 3 follow-up chips", () => {
    const t = buildTurn(base());
    expect(t.intent).toBe("pricing");
    expect(t.instructions).toContain("Plans start at");
    expect(t.instructions).not.toContain("Do NOT invent");
    expect(t.sources[0]).toEqual({ title: "Pricing", url: "/pricing" });
    expect(t.suggestions.length).toBeLessThanOrEqual(3);
    expect(t.handoff).toBe(false);
  });
  it("ungrounded: forbids guessing and (for support intent) offers a human", () => {
    const t = buildTurn(base({ question: "my calls are not working", grounded: false, chunks: [], kbBlock: "" }));
    expect(t.instructions).toContain("Do NOT invent");
    expect(t.handoff).toBe(true);
  });
  it("retrieval unavailable: makes no grounding claim and adds no instructions", () => {
    const t = buildTurn(base({ available: false, grounded: false, chunks: [], kbBlock: "" }));
    expect(t.instructions).toBe("");
    expect(t.handoff).toBe(false);
  });
  it("never links off-site (poisoned chunk URL)", () => {
    const t = buildTurn(base({ chunks: [{ title: "Evil", url: "https://evil.example/pricing", similarity: 0.9 }] }));
    expect(t.sources.every((s) => s.url.startsWith("/"))).toBe(true);
  });
  it("explicit request for a person triggers hand-off", () => {
    expect(buildTurn(base({ question: "can I talk to a real person?" })).handoff).toBe(true);
  });
});

describe("buildLogRow", () => {
  it("redacts PII and rounds numbers", () => {
    const row = buildLogRow(buildTurn(base({ question: "mail me at jo@x.com or 555-123-4567" })), { provider: "p", model: "m", latencyMs: 812.6, firstTokenMs: 140.2 });
    expect(String(row.question_redacted)).not.toMatch(/jo@x\.com|555-123-4567/);
    expect(row.latency_ms).toBe(813);
    expect(row.first_token_ms).toBe(140);
  });
  it("marks answers ungrounded when retrieval did not run", () => {
    const row = buildLogRow(buildTurn(base({ available: false })), { provider: null, model: null, latencyMs: null, firstTokenMs: null });
    expect(row.grounded).toBe(false);
    expect(row.top_similarity).toBeNull();
  });
});

describe("logAnswer", () => {
  const client = (result: unknown, delay = 0): InsertClient => ({
    from: () => ({ insert: () => ({ select: () => ({ single: () => new Promise((r) => setTimeout(() => r(result as never), delay)) }) }) }),
  });
  it("returns the id on success", async () => expect(await logAnswer(client({ data: { id: "abc" }, error: null }), {})).toBe("abc"));
  it("returns null on db error, throw, or timeout — never throws", async () => {
    expect(await logAnswer(client({ data: null, error: { message: "x" } }), {})).toBeNull();
    const boom: InsertClient = { from: () => { throw new Error("boom"); } };
    expect(await logAnswer(boom, {})).toBeNull();
    expect(await logAnswer(client({ data: { id: "late" }, error: null }, 200), {}, 20)).toBeNull();
  });
});
