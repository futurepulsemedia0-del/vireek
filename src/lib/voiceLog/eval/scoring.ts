import type { VoiceExtraction } from '../../../../supabase/functions/_shared/voice-log/extract';
import type { Dictation } from './dictations';

export const THRESHOLDS = {
  findingsRecall: 0.9, findingsPrecision: 0.85, partsExact: 0.85, timeAccuracy: 0.9, safetyRecall: 1, safetyFalseAlarm: 0.1,
} as const;

export interface CaseScore {
  findingsHit: number; findingsExpected: number; findingsActual: number; findingsActualMatched: number;
  partsExact: number; partsNameOnly: number; partsExpected: number;
  timeOk: boolean; safetyExpected: number; safetyHit: number; falseSafety: boolean;
}
export interface Metrics {
  cases: number; findingsRecall: number; findingsPrecision: number; partsExact: number; partsNameOnly: number;
  timeAccuracy: number; safetyRecall: number; safetyFalseAlarm: number; pass: boolean; failures: string[];
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase();
const has = (text: string, kw: string) => norm(text).includes(norm(kw));

export function scoreCase(exp: Dictation['expected'], act: VoiceExtraction): CaseScore {
  const nonSafety = act.findings.filter((f) => f.severity !== 'safety');
  const allKw = [...exp.findings, ...exp.safety];
  const findingsHit = exp.findings.filter((kw) => act.findings.some((f) => has(f.text, kw))).length;
  const findingsActualMatched = nonSafety.filter((f) => allKw.some((kw) => has(f.text, kw))).length;
  let partsExact = 0; let partsNameOnly = 0;
  for (const p of exp.parts) {
    const m = act.parts.find((x) => has(x.name, p.kw));
    if (m) { partsNameOnly++; if (m.quantity === p.qty) partsExact++; }
  }
  const safetyHit = exp.safety.filter((kw) => act.findings.some((f) => f.severity === 'safety' && has(f.text, kw))).length;
  return {
    findingsHit, findingsExpected: exp.findings.length, findingsActual: nonSafety.length, findingsActualMatched,
    partsExact, partsNameOnly, partsExpected: exp.parts.length,
    timeOk: exp.timeMinutes === null ? act.time_minutes === null : act.time_minutes === exp.timeMinutes,
    safetyExpected: exp.safety.length, safetyHit,
    falseSafety: exp.safety.length === 0 && act.findings.some((f) => f.severity === 'safety'),
  };
}

const div = (a: number, b: number, empty = 1) => (b === 0 ? empty : a / b);

export function aggregate(scores: CaseScore[]): Metrics {
  const sum = (k: (s: CaseScore) => number) => scores.reduce((n, s) => n + k(s), 0);
  const noSafetyCases = scores.filter((s) => s.safetyExpected === 0);
  const m = {
    cases: scores.length,
    findingsRecall: div(sum((s) => s.findingsHit), sum((s) => s.findingsExpected)),
    findingsPrecision: div(sum((s) => s.findingsActualMatched), sum((s) => s.findingsActual)),
    partsExact: div(sum((s) => s.partsExact), sum((s) => s.partsExpected)),
    partsNameOnly: div(sum((s) => s.partsNameOnly), sum((s) => s.partsExpected)),
    timeAccuracy: div(scores.filter((s) => s.timeOk).length, scores.length),
    safetyRecall: div(sum((s) => s.safetyHit), sum((s) => s.safetyExpected)),
    safetyFalseAlarm: div(noSafetyCases.filter((s) => s.falseSafety).length, noSafetyCases.length, 0),
  };
  const failures: string[] = [];
  if (m.findingsRecall < THRESHOLDS.findingsRecall) failures.push('findingsRecall');
  if (m.findingsPrecision < THRESHOLDS.findingsPrecision) failures.push('findingsPrecision');
  if (m.partsExact < THRESHOLDS.partsExact) failures.push('partsExact');
  if (m.timeAccuracy < THRESHOLDS.timeAccuracy) failures.push('timeAccuracy');
  if (m.safetyRecall < THRESHOLDS.safetyRecall) failures.push('safetyRecall');
  if (m.safetyFalseAlarm > THRESHOLDS.safetyFalseAlarm) failures.push('safetyFalseAlarm');
  return { ...m, pass: failures.length === 0, failures };
}

/** Builds the "perfect" extraction from labels. Used only to prove the scorer itself is correct. */
export function oracleExtraction(d: Dictation): VoiceExtraction {
  return {
    language: d.lang, transcript: d.text, summary: '',
    findings: [...d.expected.findings.map((kw) => ({ text: kw, severity: 'minor' as const, equipment_hint: null, confidence: 1 })),
      ...d.expected.safety.map((kw) => ({ text: kw, severity: 'safety' as const, equipment_hint: null, confidence: 1 }))],
    parts: d.expected.parts.map((p) => ({ name: p.kw, quantity: p.qty, confidence: 1 })),
    time_minutes: d.expected.timeMinutes, time_confidence: 1, customer_notes: [], needs_review: false,
  };
}
