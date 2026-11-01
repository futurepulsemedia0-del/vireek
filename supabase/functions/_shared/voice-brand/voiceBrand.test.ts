import { describe, expect, it } from "vitest";
import { buildVoicePersonaContext, resolveTrade, TRADE_KEYS, TURN_LIMITS } from "./persona.ts";
import { MERGE_FIELDS, SCRIPT_LIBRARY, composeOpening, renderScript, sanitizeMergeValue, smsSegments } from "./scripts.ts";
import { LATENCY_BUDGET, evaluateBargeIn, evaluateTurnLatency, scoreTurn } from "./styleCheck.ts";
import { GOLDEN_TURNS, toEvalCaseInputs } from "./golden.ts";

describe("persona", () => {
  it("resolves trades from free text and defaults to general", () => {
    expect(resolveTrade("Residential Plumbing & Drain")).toBe("plumbing");
    expect(resolveTrade("HVAC")).toBe("hvac");
    expect(resolveTrade("Electrical contractor")).toBe("electrical");
    expect(resolveTrade("Roofing")).toBe("roofing");
    expect(resolveTrade(null)).toBe("general");
  });
  it("builds a compact context for every trade without the AI disclosure sentence", () => {
    for (const trade of TRADE_KEYS) {
      const ctx = buildVoicePersonaContext({ trade });
      expect(ctx.length).toBeLessThan(2200);
      expect(ctx).not.toContain("This call is answered by");
    }
  });
  it("sanitizes the assistant name", () => {
    expect(buildVoicePersonaContext({ trade: "general", assistantName: "Sarah{{x}}<b>" })).toContain("you are Sarahxb:");
  });
});

describe("scripts", () => {
  it("renders merge fields and reports missing required ones", () => {
    const ok = renderScript("greeting_business_hours", { business_name: "Acme Plumbing", assistant_name: "Sarah" });
    expect(ok.missing).toEqual([]);
    expect(ok.text).toContain("Acme Plumbing");
    expect(renderScript("sms_eta", { business_name: "Acme" }).missing).toEqual(["tech_name", "eta_window"]);
  });
  it("neutralizes injection / template syntax / urls in values and never re-interpolates", () => {
    expect(sanitizeMergeValue("Acme {{assistant_name}} https://evil.example\n")).toBe("Acme assistant_name");
    const r = renderScript("greeting_business_hours", { business_name: "{{assistant_name}}", assistant_name: "Sarah" });
    expect(r.text).not.toContain("{{");
  });
  it("throws on unknown template", () => {
    expect(() => renderScript("nope", {})).toThrow();
  });
  it("every template uses only whitelisted merge fields", () => {
    for (const t of Object.values(SCRIPT_LIBRARY)) {
      for (const variant of t.variants) {
        for (const m of variant.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
          expect((MERGE_FIELDS as readonly string[]).includes(m[1])).toBe(true);
        }
      }
    }
  });
  it("voice scripts pass the style scorer; greetings carry no disclosure", () => {
    const vals = { business_name: "Acme", assistant_name: "Sarah", callback_number: "five five five, oh one two three", holiday_name: "New Year", appointment_time: "Tuesday at two", tech_name: "Sam", eta_window: "between 2 and 3" };
    for (const t of Object.values(SCRIPT_LIBRARY).filter((s) => s.channel === "voice")) {
      t.variants.forEach((_v, i) => {
        const text = renderScript(t.id, vals, i).text;
        expect(scoreTurn(text).passed).toBe(true);
        if (t.id.startsWith("greeting")) expect(text).not.toContain("AI");
      });
    }
  });
  it("every SMS names the business, fits one GSM-7 segment, and has opt-out wording (except STOP confirmation)", () => {
    const vals = { business_name: "Acme Plumbing", callback_number: "555-0123", appointment_time: "Tue 2pm", tech_name: "Sam", eta_window: "2-3pm" };
    for (const t of Object.values(SCRIPT_LIBRARY).filter((s) => s.channel === "sms")) {
      const text = renderScript(t.id, vals).text;
      expect(text).toContain("Acme Plumbing");
      expect(smsSegments(text).encoding).toBe("GSM-7");
      expect(smsSegments(text).segments).toBe(1);
      if (t.id !== "sms_stop_reply") expect(/\bSTOP\b/.test(text)).toBe(true);
    }
  });
  it("composes opening in order disclosure, greeting, recording notice", () => {
    expect(composeOpening({ disclosure: "D.", greeting: "G.", recordingNotice: "R." })).toBe("D. G. R.");
    expect(composeOpening({ greeting: "G." })).toBe("G.");
  });
  it("counts UCS-2 segments for non-GSM text", () => {
    expect(smsSegments("سلام").encoding).toBe("UCS-2");
  });
});

describe("style scorer and golden conversations", () => {
  it("reference replies pass, known-bad replies fail", () => {
    for (const g of GOLDEN_TURNS) {
      expect(scoreTurn(g.good, g.ctx).violations).toEqual([]);
      expect(scoreTurn(g.bad, g.ctx).passed).toBe(false);
    }
  });
  it("every reference reply respects the turn limits", () => {
    for (const g of GOLDEN_TURNS) expect(g.good.split(/\s+/).length).toBeLessThanOrEqual(TURN_LIMITS.maxWords);
  });
  it("exports live eval cases in the ai-eval-run shape", () => {
    const cases = toEvalCaseInputs();
    expect(cases.length >= GOLDEN_TURNS.length).toBe(true);
    expect(cases.every((c) => c.assertions.some((a) => a.type === "max_latency_ms"))).toBe(true);
  });
});

describe("latency and barge-in budgets", () => {
  it("passes within budget and fails above it", () => {
    expect(evaluateTurnLatency([500, 600, 700, 800, 900]).passed).toBe(true);
    expect(evaluateTurnLatency([900, 1000, 1200, 1600, 2000]).passed).toBe(false);
    expect(evaluateTurnLatency([]).passed).toBe(false);
  });
  it("flags slow or missing barge-in stops", () => {
    expect(evaluateBargeIn([{ callerSpeechStartMs: 0, agentAudioStopMs: LATENCY_BUDGET.bargeInStopMs }]).passed).toBe(true);
    expect(evaluateBargeIn([{ callerSpeechStartMs: 0, agentAudioStopMs: 900 }]).passed).toBe(false);
    expect(evaluateBargeIn([{ callerSpeechStartMs: 0, agentAudioStopMs: null }]).passed).toBe(false);
    expect(evaluateBargeIn([]).passed).toBe(false);
  });
});
