import { describe, expect, it } from "vitest";
import {
  evaluateDisclosure, findDisclosure, normalizeForMatch, turnsFromTranscript, turnsFromVapiMessages,
} from "./match.ts";

const D = "This call is answered by an AI voice assistant, not a live person.";
const cand = [{ key: "planned", text: D }];

describe("normalizeForMatch", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeForMatch("  THIS call—is answered!  ")).toBe("this call is answered");
  });
  it("unifies Arabic/Persian letter variants and strips ZWNJ", () => {
    expect(normalizeForMatch("می‌خواهم كيف")).toBe(normalizeForMatch("میخواهم کیف"));
  });
});

describe("turn builders", () => {
  it("maps Vapi messages, drops system/tool entries, reads secondsFromStart", () => {
    const t = turnsFromVapiMessages([
      { role: "system", message: "prompt" },
      { role: "bot", message: "Hello", secondsFromStart: 1.2 },
      { role: "user", message: "Hi", secondsFromStart: 4 },
      { role: "tool", message: "x" },
      null,
    ]);
    expect(t.map((x) => x.role)).toEqual(["assistant", "caller"]);
    expect(t[0].secondsFromStart).toBe(1.2);
  });
  it("derives seconds from absolute time when secondsFromStart is absent", () => {
    const t = turnsFromVapiMessages([{ role: "assistant", message: "Hi", time: 10_000 }], 4_000);
    expect(t[0].secondsFromStart).toBe(6);
  });
  it("parses a plain transcript with exact character offsets and wrapped lines", () => {
    const text = "AI: Hello there\nstill the AI\nUser: Hi";
    const t = turnsFromTranscript(text);
    expect(t).toHaveLength(2);
    expect(t[0].text).toBe("Hello there still the AI");
    expect(text.slice(t[0].charStart!, t[0].charStart! + 5)).toBe("Hello");
    expect(t[1].role).toBe("caller");
  });
  it("tolerates non-arrays and empty input", () => {
    expect(turnsFromVapiMessages(undefined)).toEqual([]);
    expect(turnsFromTranscript(null)).toEqual([]);
  });
});

describe("evaluateDisclosure", () => {
  const turns = (assistant: string[], secs = 1) =>
    assistant.map((text, i) => ({ role: "assistant" as const, text, secondsFromStart: secs + i, charStart: null }));

  it("delivered: exact disclosure in the opening turn, with offset + excerpt", () => {
    const r = evaluateDisclosure({ turns: turns([`${D} How can I help?`], 0.8), candidates: cand, durationSeconds: 90 });
    expect(r.status).toBe("delivered");
    expect(r.match.score).toBe(1);
    expect(r.match.secondsFromStart).toBe(0.8);
    expect(r.match.excerpt).toContain("AI voice assistant");
  });
  it("delivered despite punctuation/case drift", () => {
    const r = evaluateDisclosure({ turns: turns(["this call is answered by an ai voice assistant not a live person"]), candidates: cand, durationSeconds: 60 });
    expect(r.status).toBe("delivered");
  });
  it("delivered when the sentence is split across two assistant messages", () => {
    const r = evaluateDisclosure({ turns: turns(["This call is answered by an AI", "voice assistant, not a live person."]), candidates: cand, durationSeconds: 60 });
    expect(r.status).toBe("delivered");
  });
  it("late: only said after the opening", () => {
    const r = evaluateDisclosure({
      turns: [
        { role: "assistant", text: "Hi, thanks for calling.", secondsFromStart: 1, charStart: null },
        { role: "assistant", text: "How can I help?", secondsFromStart: 6, charStart: null },
        { role: "assistant", text: D, secondsFromStart: 45, charStart: null },
      ],
      candidates: cand, durationSeconds: 120,
    });
    expect(r.status).toBe("late");
  });
  it("partial: caller interrupted, only the start was spoken", () => {
    const r = evaluateDisclosure({ turns: turns(["This call is answered by an AI voice"]), candidates: cand, durationSeconds: 60 });
    expect(r.status).toBe("partial");
  });
  it("missing: assistant spoke but never disclosed", () => {
    const r = evaluateDisclosure({ turns: turns(["Hello, thanks for calling Acme Heating. How can I help?"]), candidates: cand, durationSeconds: 60 });
    expect(r.status).toBe("missing");
  });
  it("matches an older/alternate wording through extra candidates", () => {
    const r = evaluateDisclosure({
      turns: turns(["Heads up: you are speaking with an automated AI assistant."]),
      candidates: [...cand, { key: "v-old", text: "Heads up: you are speaking with an automated AI assistant." }],
      durationSeconds: 60,
    });
    expect(r.status).toBe("delivered");
    expect(r.match.candidateKey).toBe("v-old");
  });
  it("works for non-spaced scripts (Japanese)", () => {
    const ja = "この通話はAI音声アシスタントが対応しており、実際の人間ではありません。";
    const r = evaluateDisclosure({ turns: turns([`${ja}ご用件は？`]), candidates: [{ key: "planned", text: ja }], durationSeconds: 60 });
    expect(r.status).toBe("delivered");
  });
  it("no transcript vs not applicable", () => {
    expect(evaluateDisclosure({ turns: [], candidates: cand, durationSeconds: 80 }).status).toBe("no_transcript");
    expect(evaluateDisclosure({ turns: [], candidates: cand, durationSeconds: 2 }).status).toBe("not_applicable");
    expect(evaluateDisclosure({ turns: [], candidates: cand, durationSeconds: null }).status).toBe("no_transcript");
  });
  it("caller-only transcript: missing for a real call, not applicable for a blip", () => {
    const only = [{ role: "caller" as const, text: "hello?", secondsFromStart: 1, charStart: null }];
    expect(evaluateDisclosure({ turns: only, candidates: cand, durationSeconds: 40 }).status).toBe("missing");
    expect(evaluateDisclosure({ turns: only, candidates: cand, durationSeconds: 3 }).status).toBe("not_applicable");
  });
  it("findDisclosure returns a zero match for empty candidates", () => {
    expect(findDisclosure(turns(["x"]), []).found).toBe(false);
  });
});
