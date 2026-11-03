#!/usr/bin/env node
// scripts/interpreter-eval.mjs  (Node >= 22.18)
//
//   node scripts/interpreter-eval.mjs                 deterministic layer only (no network) — the CI gate
//   GEMINI_API_KEY=… node scripts/interpreter-eval.mjs --live   + translation quality (chrF), critical fields
//                                                    preserved through translation, glossary adherence, latency
//   node scripts/interpreter-eval.mjs --audio eval/interpreter/audio-results.json   + WER from real-audio ASR output
//                                                    [{ "lang":"es", "reference":"…", "hypothesis":"…" }, …]
//   --update-baseline   store the current numbers as eval/interpreter/baseline.json (after a reviewed improvement)
//
// Exit code 1 when any gate fails or a metric regresses against the baseline.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { runDeterministic } from "../supabase/functions/_shared/interpreter/evaluate.ts";
import { geminiTranslate } from "../supabase/functions/_shared/interpreter/gemini.ts";
import { verifyTranslation } from "../supabase/functions/_shared/interpreter/mt.ts";
import { INTERP_META } from "../supabase/functions/_shared/interpreter/languages.ts";
import { chrf, wer } from "../supabase/functions/_shared/interpreter/score.ts";
import { GA_GATES, readinessOf } from "../supabase/functions/_shared/interpreter/readiness.ts";

const dir = new URL("../supabase/functions/_shared/interpreter/golden/", import.meta.url);
const args = process.argv.slice(2);
const live = args.includes("--live");
const audioPath = args.includes("--audio") ? args[args.indexOf("--audio") + 1] : null;
const baselineUrl = new URL("../eval/interpreter/baseline.json", import.meta.url);
const reportUrl = new URL("../eval/interpreter/report.json", import.meta.url);
const baseline = existsSync(baselineUrl) ? JSON.parse(readFileSync(baselineUrl, "utf8")) : {};

const langs = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).filter((l) => l !== "en");
const report = {};
let failed = false;
const fail = (m) => { failed = true; console.error(`FAIL ${m}`); };

for (const lang of langs) {
  const cases = JSON.parse(readFileSync(new URL(`${lang}.json`, dir), "utf8"));
  const d = runDeterministic(lang, cases);
  const r = { textCases: cases.length, audioCases: 0, langIdAccuracy: d.langIdAccuracy, criticalFieldAccuracy: d.criticalFieldAccuracy, emergencyRecall: d.emergencyRecall, emergencyFalseAlarms: d.emergencyFalseAlarms, chrf: null, wer: null, p50AddedMs: null, liveCriticalPreserved: null };
  d.failures.forEach((f) => console.error(`  [${lang}] ${f}`));
  if (r.criticalFieldAccuracy < GA_GATES.criticalFieldAccuracy) fail(`${lang}: critical-field accuracy ${r.criticalFieldAccuracy}`);
  if (r.emergencyRecall < 1 || r.emergencyFalseAlarms > 0) fail(`${lang}: emergency recall/false alarms`);
  if (r.langIdAccuracy < GA_GATES.langIdAccuracy) fail(`${lang}: language-ID accuracy ${r.langIdAccuracy}`);

  if (live) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) { fail("--live needs GEMINI_API_KEY"); }
    else {
      const tr = geminiTranslate({ apiKey: key, model: process.env.GEMINI_MODEL || undefined });
      const scores = [], lat = []; let preserved = 0, total = 0;
      for (const c of cases.filter((x) => x.en)) {
        const t0 = Date.now();
        const out = await tr({ text: c.text, from: lang, to: "en", speaker: "caller" });
        lat.push(Date.now() - t0);
        total++;
        if (!out) { scores.push(0); continue; }
        scores.push(chrf(c.en, out.text));
        if (verifyTranslation(c.text, lang, out.text, "en").criticalOk) preserved++;
      }
      lat.sort((a, b) => a - b);
      r.chrf = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
      r.liveCriticalPreserved = total ? preserved / total : 1;
      r.p50AddedMs = lat[Math.floor(lat.length / 2)] ?? null; // translation-only latency; TTS/ASR not included
      const b = baseline[lang];
      if (b?.chrf != null && r.chrf < b.chrf - 0.03) fail(`${lang}: chrF regressed ${b.chrf.toFixed(3)} -> ${r.chrf.toFixed(3)}`);
      if (r.liveCriticalPreserved < 0.99) fail(`${lang}: only ${(r.liveCriticalPreserved * 100).toFixed(0)}% of critical fields survived translation`);
    }
  }
  report[lang] = r;
}

if (audioPath) {
  const rows = JSON.parse(readFileSync(audioPath, "utf8"));
  for (const lang of langs) {
    const mine = rows.filter((x) => x.lang === lang);
    if (!mine.length) continue;
    report[lang].audioCases = mine.length;
    report[lang].wer = mine.reduce((a, x) => a + wer(x.reference, x.hypothesis, INTERP_META[lang].noSpaces), 0) / mine.length;
    const b = baseline[lang];
    if (b?.wer != null && report[lang].wer > b.wer + 0.02) fail(`${lang}: WER regressed ${b.wer.toFixed(3)} -> ${report[lang].wer.toFixed(3)}`);
  }
}

console.log("\nlang  cases  langID  critical  emergency  chrF   WER    readiness");
for (const [lang, r] of Object.entries(report)) {
  const rd = readinessOf({ lang, ...r, nativeReviewed: false });
  r.readiness = rd.status;
  console.log(`${lang.padEnd(5)} ${String(r.textCases).padEnd(6)} ${r.langIdAccuracy.toFixed(2).padEnd(7)} ${r.criticalFieldAccuracy.toFixed(3).padEnd(9)} ${String(r.emergencyRecall).padEnd(10)} ${(r.chrf?.toFixed(2) ?? "n/a").padEnd(6)} ${(r.wer?.toFixed(2) ?? "n/a").padEnd(6)} ${rd.status.toUpperCase()}`);
}
writeFileSync(reportUrl, JSON.stringify(report, null, 2));
if (args.includes("--update-baseline")) writeFileSync(baselineUrl, JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
