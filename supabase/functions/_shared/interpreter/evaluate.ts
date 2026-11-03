// supabase/functions/_shared/interpreter/evaluate.ts
//
// Deterministic evaluation of everything that does NOT need a model or audio:
// language-ID, critical-field extraction, emergency recall and false alarms,
// glossary coverage. This is what the CI gate runs on every change.
// The live layer (translation quality, WER, latency) is scripts/interpreter-eval.mjs.

import { extractCritical, type CriticalEntity } from "./critical.ts";
import { glossaryHints } from "./glossary.ts";
import { identifyLanguage } from "./langid.ts";
import type { InterpLang } from "./languages.ts";
import { detectEmergency } from "./safety.ts";
import { fieldAccuracy } from "./score.ts";

export interface GoldenCase {
  id: string;
  lang: InterpLang;
  text: string;
  en?: string;
  critical: { kind: CriticalEntity["kind"]; value: string; mer?: "am" | "pm" }[];
  tags: string[];
  emergency?: boolean;
  noisy?: string[];
}

export interface DeterministicReport {
  lang: InterpLang;
  cases: number;
  langIdAccuracy: number;
  criticalFieldAccuracy: number;
  criticalFields: { correct: number; total: number };
  emergencyRecall: number;
  emergencyFalseAlarms: number;
  glossaryCoverage: number;
  failures: string[];
}

export function runDeterministic(lang: InterpLang, cases: GoldenCase[]): DeterministicReport {
  const failures: string[] = [];
  let idOk = 0, idTotal = 0, fc = 0, ft = 0, emTotal = 0, emHit = 0, falseAlarms = 0, gTotal = 0, gHit = 0;
  for (const c of cases) {
    const texts = [c.text, ...(c.noisy ?? [])];
    for (const t of texts) {
      if (lang !== "en" && !c.tags.includes("short")) {
        idTotal++;
        const id = identifyLanguage(t);
        if (id.lang === lang) idOk++; else failures.push(`langid ${c.id}: got ${id.lang} (${id.confidence.toFixed(2)}) for "${t}"`);
      }
      if (c.emergency) {
        emTotal++;
        if (detectEmergency(t).isEmergency) emHit++; else failures.push(`emergency miss ${c.id}: "${t}"`);
      }
    }
    if (!c.emergency && detectEmergency(c.text).isEmergency) { falseAlarms++; failures.push(`false emergency ${c.id}`); }
    const got = extractCritical(c.text, lang).filter((e) => e.kind !== "number");
    const exp = c.critical as CriticalEntity[];
    const r = fieldAccuracy(exp, got);
    fc += r.correct; ft += r.total;
    const extra = got.length - r.correct;
    if (r.correct < r.total || extra > 0) {
      failures.push(`critical ${c.id}: expected ${JSON.stringify(exp.map((e) => `${e.kind}:${e.value}`))} got ${JSON.stringify(got.map((e) => `${e.kind}:${e.value}${e.mer ? e.mer : ""}`))}`);
    }
    if (c.tags.includes("glossary") && c.en) {
      gTotal++;
      if (glossaryHints(c.text, lang, "en").length > 0) gHit++; else failures.push(`glossary miss ${c.id}`);
    }
  }
  return {
    lang, cases: cases.length,
    langIdAccuracy: idTotal ? idOk / idTotal : 1,
    criticalFieldAccuracy: ft ? fc / ft : 1,
    criticalFields: { correct: fc, total: ft },
    emergencyRecall: emTotal ? emHit / emTotal : 1,
    emergencyFalseAlarms: falseAlarms,
    glossaryCoverage: gTotal ? gHit / gTotal : 1,
    failures,
  };
}
