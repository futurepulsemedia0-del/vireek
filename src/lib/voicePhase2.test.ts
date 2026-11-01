import { describe, expect, it } from "vitest";
import { analyzeAudio, clampHoldOptions, encodeWav, generateHoldWav, HOLD_PEAK_LIMIT, HOLD_TARGET_RMS, synthesizeHoldAudio } from "./holdAudio";
import { buildIvrScript, validateIvrMenu } from "./ivrStandards";
import { A2P_CHECKLIST, a2pSampleMessages, buildVoicemailEmail, checklistProgress, classifyInboundKeyword, validateCnam } from "./telephonyBrand";
import { resolveOverrideBody, validateOverride } from "./voiceScriptOverrides";
import { extractTurnLatencies, summarizeLatency } from "../../supabase/functions/_shared/voice-brand/latency";
import { ALL_GOLDEN_TURNS, toEvalCaseInputs } from "../../supabase/functions/_shared/voice-brand/golden";
import { scoreTurn } from "../../supabase/functions/_shared/voice-brand/styleCheck";
import { smsSegments } from "../../supabase/functions/_shared/voice-brand/scripts";

describe("hold audio", () => {
  it("clamps options", () => {
    expect(clampHoldOptions({ durationSec: 5000 }).durationSec).toBe(120);
    expect(clampHoldOptions({ durationSec: 1 }).durationSec).toBe(10);
    expect(clampHoldOptions({ sampleRate: 44100 as unknown as 8000 }).sampleRate).toBe(8000);
  });
  it("is normalized, peak-limited and loops without a click", () => {
    const s = synthesizeHoldAudio({ durationSec: 10 });
    const a = analyzeAudio(s);
    expect(Math.abs(a.rms - HOLD_TARGET_RMS) < 0.005).toBe(true);
    expect(a.peak).toBeLessThanOrEqual(HOLD_PEAK_LIMIT);
    let maxStep = 0;
    for (let i = 1; i < s.length; i++) maxStep = Math.max(maxStep, Math.abs(s[i] - s[i - 1]));
    const seam = Math.abs(s[0] - s[s.length - 1]); // wrap-around step must be no larger than any normal step
    expect(seam <= maxStep).toBe(true);
  });
  it("is deterministic and encodes a valid WAV header", () => {
    expect(JSON.stringify(Array.from(synthesizeHoldAudio({ durationSec: 10 }).slice(0, 50)))).toBe(JSON.stringify(Array.from(synthesizeHoldAudio({ durationSec: 10 }).slice(0, 50))));
    const w = generateHoldWav({ style: "warm", durationSec: 10 });
    expect(String.fromCharCode(...w.bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...w.bytes.slice(8, 12))).toBe("WAVE");
    expect(w.bytes.length).toBe(44 + 10 * 8000 * 2);
    expect(w.fileName).toBe("vireek-hold-warm-10s.wav");
    expect(encodeWav(new Float32Array([2, -2]), 8000).length).toBe(48);
  });
});

describe("ivr standards", () => {
  const ok = { businessName: "Acme", greeting: "Thanks for calling Acme. How can we help?", options: [{ digit: "1", label: "Emergency service" }, { digit: "2", label: "Scheduling" }, { digit: "0", label: "Speak to someone" }] };
  it("accepts a good menu and builds the spoken script", () => {
    const v = validateIvrMenu(ok);
    expect(v.ok).toBe(true);
    expect(buildIvrScript(ok)).toContain("For Emergency service, press 1.");
  });
  it("flags errors and warnings", () => {
    expect(validateIvrMenu({ ...ok, options: [] }).ok).toBe(false);
    expect(validateIvrMenu({ ...ok, options: [{ digit: "1", label: "A" }, { digit: "1", label: "B" }] }).ok).toBe(false);
    const w = validateIvrMenu({ ...ok, options: [{ digit: "1", label: "Press 1 for billing 24" }, { digit: "2", label: "Emergency" }] });
    expect(w.issues.some((i) => i.rule === "label_press")).toBe(true);
    expect(w.issues.some((i) => i.rule === "emergency_first")).toBe(true);
    expect(w.issues.some((i) => i.rule === "no_human")).toBe(true);
  });
});

describe("telephony brand", () => {
  it("builds a CNAM within 15 chars", () => {
    expect(validateCnam("Northside Plumbing & Heating LLC").suggested.length).toBeLessThanOrEqual(15);
    expect(validateCnam("Acme").ok).toBe(true);
    expect(validateCnam("").ok).toBe(false);
  });
  it("tracks checklist progress and pending legal items", () => {
    expect(checklistProgress({}).done).toBe(0);
    expect(checklistProgress({ legal_name: true }).total).toBe(A2P_CHECKLIST.length);
    expect(checklistProgress({}).legalPending.length > 0).toBe(true);
  });
  it("generates registration samples that match templates (name + opt-out)", () => {
    for (const s of a2pSampleMessages({ business_name: "Acme" })) {
      expect(s).toContain("Acme");
      expect(/STOP/.test(s)).toBe(true);
    }
  });
  it("classifies inbound keywords", () => {
    expect(classifyInboundKeyword(" stop. ")).toBe("stop");
    expect(classifyInboundKeyword("Unsubscribe")).toBe("stop");
    expect(classifyInboundKeyword("START")).toBe("start");
    expect(classifyInboundKeyword("help")).toBe("help");
    expect(classifyInboundKeyword("please stop calling")).toBe(null);
  });
  it("escapes the voicemail email and blocks header injection / non-https links", () => {
    const e = buildVoicemailEmail({ businessName: "Acme", callerName: "Eve\r\nBcc: x@y.z", receivedAt: new Date("2026-10-29T10:00:00Z"), transcript: "<script>alert(1)</script>", listenUrl: "javascript:alert(1)", primaryColor: "red;" });
    expect(e.subject.includes("\n")).toBe(false);
    expect(e.html.includes("<script>")).toBe(false);
    expect(e.html.includes("javascript:")).toBe(false);
    expect(e.html.includes("#1d4ed8")).toBe(true);
    expect(e.text).toContain("automatically");
  });
});

describe("script overrides", () => {
  it("accepts a valid voice override and rejects bad ones", () => {
    expect(validateOverride("greeting_business_hours", "Hi, {{business_name}} here, this is {{assistant_name}}. How can I help?").ok).toBe(true);
    expect(validateOverride("greeting_business_hours", "Hi there, how can I help?").ok).toBe(false);
    expect(validateOverride("greeting_business_hours", "Hi {{business_name}} {{assistant_name}} {{secret}}").ok).toBe(false);
    expect(validateOverride("greeting_business_hours", "Hi {{business_name}} {{assistant_name}} I guarantee it. {{").ok).toBe(false);
    expect(validateOverride("nope", "x").ok).toBe(false);
  });
  it("requires opt-out wording and limits segments for SMS", () => {
    expect(validateOverride("sms_eta", "{{business_name}}: {{tech_name}} arrives {{eta_window}}.").ok).toBe(false);
    expect(validateOverride("sms_eta", "{{business_name}}: {{tech_name}} arrives {{eta_window}}. Reply STOP to opt out.").ok).toBe(true);
    expect(validateOverride("sms_eta", "{{business_name}} {{tech_name}} {{eta_window}} " + "x".repeat(380)).ok).toBe(false);
  });
  it("ignores invalid stored overrides at resolve time", () => {
    expect(resolveOverrideBody("sms_eta", { sms_eta: "no fields" })).toBe(undefined);
  });
});

describe("latency extraction and golden suite", () => {
  it("extracts sane samples defensively", () => {
    const msg = { artifact: { performanceMetrics: { turnLatencies: [{ turnLatency: 700 }, { turnLatency: -5 }, { turnLatency: "x" }, 900, { turnLatency: 999999 }] } } };
    expect(extractTurnLatencies(msg)).toEqual([700, 900]);
    expect(extractTurnLatencies(null)).toEqual([]);
    expect(extractTurnLatencies({})).toEqual([]);
  });
  it("summarizes against the budget", () => {
    expect(summarizeLatency([]).turnCount).toBe(0);
    expect(summarizeLatency([600, 700, 800]).withinBudget).toBe(true);
    expect(summarizeLatency([2000, 2500, 3000]).withinBudget).toBe(false);
  });
  it("barge-in and unclear-audio goldens pass/fail as designed", () => {
    for (const g of ALL_GOLDEN_TURNS) {
      expect(scoreTurn(g.good, g.ctx).violations).toEqual([]);
      expect(scoreTurn(g.bad, g.ctx).passed).toBe(false);
    }
  });
  it("exports voice_style assertions for ai_eval_cases", () => {
    const c = toEvalCaseInputs();
    expect(c.length).toBe(ALL_GOLDEN_TURNS.length);
    expect(c.every((x) => x.assertions[0].type === "voice_style")).toBe(true);
    expect(smsSegments("a").segments).toBe(1);
  });
});
