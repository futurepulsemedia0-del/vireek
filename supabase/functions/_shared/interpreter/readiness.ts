// supabase/functions/_shared/interpreter/readiness.ts
//
// Honest per-language readiness, computed from measured evidence — never
// hard-coded. A language is "ga" only when EVERY gate below is met by a real
// eval report; with no evidence it is "unsupported"; anything in between is
// "beta" and the UI must say so.

import type { InterpLang } from "./languages.ts";

export interface LangEval {
  lang: InterpLang;
  /** Text-level golden cases run. */
  textCases: number;
  /** Real-audio cases run (0 when no audio evaluation exists). */
  audioCases: number;
  criticalFieldAccuracy: number;
  emergencyRecall: number;
  langIdAccuracy: number;
  /** Mean chrF vs reference translations, null when the live translation eval was not run. */
  chrf: number | null;
  /** Mean WER (CER for zh/ja) on real audio, null when not measured. */
  wer: number | null;
  /** p50 added latency from a live run, null when not measured. */
  p50AddedMs: number | null;
  nativeReviewed: boolean;
}

export const GA_GATES = {
  criticalFieldAccuracy: 0.99,
  emergencyRecall: 1,
  langIdAccuracy: 0.95,
  chrf: 0.6,
  maxWer: 0.15,
  minAudioCases: 50,
  minTextCases: 40,
  maxP50Ms: 700,
} as const;

export type Readiness = "ga" | "beta" | "unsupported";

export function readinessOf(e: LangEval | null | undefined): { status: Readiness; blockers: string[] } {
  if (!e || e.textCases === 0) return { status: "unsupported", blockers: ["no evaluation evidence"] };
  const b: string[] = [];
  if (e.criticalFieldAccuracy < GA_GATES.criticalFieldAccuracy) b.push(`critical-field accuracy ${(e.criticalFieldAccuracy * 100).toFixed(1)}% < 99%`);
  if (e.emergencyRecall < GA_GATES.emergencyRecall) b.push("emergency recall below 100%");
  if (e.langIdAccuracy < GA_GATES.langIdAccuracy) b.push("language-ID accuracy below 95%");
  if (e.textCases < GA_GATES.minTextCases) b.push(`only ${e.textCases} golden cases (need ${GA_GATES.minTextCases})`);
  if (e.chrf === null) b.push("live translation quality not measured");
  else if (e.chrf < GA_GATES.chrf) b.push("translation quality below threshold");
  if (e.wer === null || e.audioCases < GA_GATES.minAudioCases) b.push(`real-audio WER not measured on >= ${GA_GATES.minAudioCases} calls`);
  else if (e.wer > GA_GATES.maxWer) b.push("WER above threshold");
  if (e.p50AddedMs === null) b.push("live latency not measured");
  else if (e.p50AddedMs > GA_GATES.maxP50Ms) b.push("p50 added latency over 700ms");
  if (!e.nativeReviewed) b.push("no native-speaker review of fixed phrases and safety text");
  return { status: b.length ? "beta" : "ga", blockers: b };
}
