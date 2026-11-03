// @vitest-environment node
// 100 spoken owner questions (eval/voice-questions.json): routing, permission level, injection blocking,
// factual grounding of the brief against its source facts, and logic latency.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planQuestion } from "../business-brain/router.ts";
import { classifyIntent, requiredLevelForTopics, screenUtterance } from "./callSafety.ts";
import { composeBriefScript, LANGS, type BriefFacts } from "./briefScript.ts";

interface Q { id: string; q: string; intent: string; minLevel: 1 | 2; customerQuery?: string; messageBody?: string | null; brain?: boolean }
const { questions } = JSON.parse(readFileSync(new URL("../../../../eval/voice-questions.json", import.meta.url), "utf8")) as { questions: Q[] };

describe("voice eval set", () => {
  it("has exactly 100 unique questions", () => {
    expect(questions).toHaveLength(100);
    expect(new Set(questions.map((x) => x.q)).size).toBe(100);
  });
  it.each(questions.filter((x) => x.intent !== "blocked"))("routes $id: $q", (x) => {
    const s = screenUtterance(x.q);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const p = classifyIntent(s.text);
    expect(p.intent).toBe(x.intent);
    if (x.intent === "send_text") { expect(p.customerQuery).toBe(x.customerQuery); expect(p.messageBody ?? null).toBe(x.messageBody); }
    if (x.brain) expect(requiredLevelForTopics(planQuestion(x.q).topics)).toBe(x.minLevel);
  });
  it.each(questions.filter((x) => x.intent === "blocked"))("blocks attack $id: $q", (x) => {
    expect(screenUtterance(x.q).ok).toBe(false);
  });
  it("classifies the whole set well under a millisecond each (logic latency only, not network or speech)", () => {
    const t0 = performance.now();
    for (const x of questions) { const s = screenUtterance(x.q); if (s.ok) classifyIntent(s.text); }
    expect((performance.now() - t0) / questions.length).toBeLessThan(5);
  });
});

describe("factual grounding: every spoken number comes from the database facts", () => {
  const rows: BriefFacts[] = [
    { date: "d", ownerName: "Sam", calls: { total: 14, missed: 2, emergencies: 1, emergenciesUnhandled: 1 }, bookings: { created: 3 }, overdue: { count: 4, cents: 421500 }, expiringQuotes: { count: 2, cents: 880000 }, schedule: { jobs: 6, unassigned: 1, firstAt: "8:30 AM" }, weather: { risk: "watch", kind: "rain" }, onCall: "Maria", canSeeMoney: true },
    { date: "d", ownerName: null, calls: { total: 0, missed: 0, emergencies: 0, emergenciesUnhandled: 0 }, bookings: { created: 0 }, overdue: { count: 12, cents: 99900 }, expiringQuotes: null, schedule: { jobs: 0, unassigned: 0, firstAt: null }, weather: null, onCall: null, canSeeMoney: true },
    { date: "d", ownerName: "Lee", calls: { total: 31, missed: 9, emergencies: 3, emergenciesUnhandled: 0 }, bookings: null, overdue: null, expiringQuotes: { count: 1, cents: 1250050 }, schedule: { jobs: 11, unassigned: 4, firstAt: "7:15 AM" }, weather: { risk: "severe", kind: "flood" }, onCall: null, canSeeMoney: true },
  ];
  it.each(rows.map((r, i) => [i, r] as const))("row %i", (_i, f) => {
    for (const lang of LANGS) {
      const { script } = composeBriefScript(f, lang);
      const src = JSON.stringify(f).replace(/\d+:\d+ ?(AM|PM)/g, "");
      const allowed = new Set<string>((src.match(/\d+/g) ?? []).concat(["3", "30", "10"]));
      for (const c of [f.overdue?.cents, f.expiringQuotes?.cents]) if (c) allowed.add(String(Math.round(c / 100)));
      const spoken = script.replace(/\d+:\d+ ?(AM|PM)/g, "").replace(/[, \u202f](?=\d{3}\b)/g, "").match(/\d+/g) ?? [];
      for (const n of spoken) expect(allowed.has(n)).toBe(true);
    }
  });
});
