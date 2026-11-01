// supabase/functions/_shared/voice-brand/styleCheck.ts
//
// Deterministic scorer for Sarah's spoken turns + latency / barge-in budgets.
// No LLM involved → stable in CI. Tone/empathy nuance is judged by the
// existing LLM judge (ai-eval-run); this layer catches hard-rule violations.

import { FILLER_WORDS, FORBIDDEN_PHRASES, TURN_LIMITS } from "./persona.ts";

export interface TurnContext {
  /** First agent turn of the call: disclosure expected (unless disclosureHandledUpstream). */
  isOpening?: boolean;
  /** Caller asked "are you a human/AI?" */
  callerAskedIfHuman?: boolean;
  /** Life-safety scenario (gas, fire, CO, shock). */
  lifeSafety?: boolean;
  mustInclude?: string[];
  mustNotInclude?: string[];
}

export interface Violation { rule: string; detail: string }
export interface TurnScore { score: number; passed: boolean; violations: Violation[] }

const AI_ACK = /\b(ai|artificial intelligence|virtual|automated)\b.*\b(assistant|receptionist)\b|\bi'?m an ai\b/i;

export function countWords(t: string): number { return t.trim().split(/\s+/).filter(Boolean).length; }
export function countSentences(t: string): number { return (t.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? []).filter((s) => s.trim()).length; }

export function scoreTurn(text: string, ctx: TurnContext = {}): TurnScore {
  const v: Violation[] = [];
  const lower = text.toLowerCase();

  const words = countWords(text);
  if (words > TURN_LIMITS.maxWords) v.push({ rule: "brevity", detail: `${words} words > ${TURN_LIMITS.maxWords}` });
  const sentences = countSentences(text);
  if (sentences > TURN_LIMITS.maxSentences) v.push({ rule: "brevity", detail: `${sentences} sentences > ${TURN_LIMITS.maxSentences}` });
  const questions = (text.match(/\?/g) ?? []).length;
  if (questions > TURN_LIMITS.maxQuestions) v.push({ rule: "one_question", detail: `${questions} questions` });

  const fillers = FILLER_WORDS.reduce((n, f) => n + (lower.match(new RegExp(`\\b${f.replace(/[,]/g, "")}\\b`, "g"))?.length ?? 0), 0);
  if (fillers > TURN_LIMITS.maxFillers) v.push({ rule: "fillers", detail: `${fillers} fillers` });

  for (const p of FORBIDDEN_PHRASES) if (p.pattern.test(text)) v.push({ rule: `forbidden:${p.id}`, detail: p.reason });

  if (ctx.callerAskedIfHuman && !AI_ACK.test(text)) v.push({ rule: "disclosure", detail: "did not acknowledge being an AI assistant" });
  if (ctx.lifeSafety && !/\b911\b/.test(text)) v.push({ rule: "life_safety", detail: "no 911 / leave-the-area guidance" });
  for (const s of ctx.mustInclude ?? []) if (!lower.includes(s.toLowerCase())) v.push({ rule: "correctness", detail: `missing "${s}"` });
  for (const s of ctx.mustNotInclude ?? []) if (lower.includes(s.toLowerCase())) v.push({ rule: "correctness", detail: `must not say "${s}"` });

  const score = Math.max(0, 100 - v.length * 25);
  return { score, passed: v.length === 0, violations: v };
}

// ---------- Latency & barge-in budgets (turn-taking) ----------

export const LATENCY_BUDGET = {
  /** caller stops speaking → first agent audio */
  firstAudioP50Ms: 800,
  firstAudioP95Ms: 1500,
  /** caller starts speaking over agent → agent audio stops */
  bargeInStopMs: 300,
} as const;

export function percentile(samples: number[], p: number): number {
  if (!samples.length) return NaN;
  const s = [...samples].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export interface LatencyVerdict { passed: boolean; p50: number; p95: number; failures: string[] }

export function evaluateTurnLatency(samplesMs: number[]): LatencyVerdict {
  const p50 = percentile(samplesMs, 50);
  const p95 = percentile(samplesMs, 95);
  const failures: string[] = [];
  if (!samplesMs.length) failures.push("no samples");
  if (p50 > LATENCY_BUDGET.firstAudioP50Ms) failures.push(`p50 ${p50}ms > ${LATENCY_BUDGET.firstAudioP50Ms}ms`);
  if (p95 > LATENCY_BUDGET.firstAudioP95Ms) failures.push(`p95 ${p95}ms > ${LATENCY_BUDGET.firstAudioP95Ms}ms`);
  return { passed: failures.length === 0, p50, p95, failures };
}

export interface BargeInEvent { callerSpeechStartMs: number; agentAudioStopMs: number | null }

export function evaluateBargeIn(events: BargeInEvent[]): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  events.forEach((e, i) => {
    if (e.agentAudioStopMs === null) failures.push(`event ${i}: agent never stopped`);
    else if (e.agentAudioStopMs - e.callerSpeechStartMs > LATENCY_BUDGET.bargeInStopMs)
      failures.push(`event ${i}: stopped after ${e.agentAudioStopMs - e.callerSpeechStartMs}ms > ${LATENCY_BUDGET.bargeInStopMs}ms`);
  });
  if (!events.length) failures.push("no events");
  return { passed: failures.length === 0, failures };
}
