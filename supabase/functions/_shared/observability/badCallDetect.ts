// supabase/functions/_shared/observability/badCallDetect.ts
//
// Deterministic bad-call detection that feeds the EXISTING ai_quality_findings queue.
// Runs on the in-memory conversation; emits flags that carry ONLY indexes, counts and
// templated English titles — never transcript text — so nothing sensitive is persisted.

import type { CallTimeline, Conversation } from "./callTimeline.ts";

export type BadCallKind = "long_silence" | "repeated_ask" | "abrupt_hangup" | "low_asr_confidence" | "slow_response" | "tool_failure";
export type FlagSeverity = "low" | "medium" | "high" | "critical";

export interface BadCallFlag {
  kind: BadCallKind;
  severity: FlagSeverity;
  title: string;
  detail: string;
  turnIndex: number | null;
  /** Unique per (call, fingerprint) in ai_quality_findings. */
  fingerprint: string;
}

export const THRESHOLDS = {
  silenceMs: 6_000,
  silenceHighMs: 12_000,
  repeatSimilarity: 0.72,
  repeatMinTokens: 3,
  repeatMinCount: 2,
  shortCallMs: 25_000,
  hangupAfterAgentQuestionMs: 8_000,
  asrAvgMin: 0.75,
  asrLowTurnMax: 0.6,
  asrLowTurnCount: 3,
  asrMinSamples: 3,
  slowTurnP95Ms: 3_000,
  slowTurnAnyMs: 8_000,
  slowMinTurns: 5,
} as const;

const CALLER_HANGUP_RE = /(customer|caller)[-_ ]?(ended|hung|hangup)|hangup|hung-up/i;

export function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

export function similarity(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface DetectInput {
  conversation: Conversation;
  timeline: CallTimeline;
  /** True when the call legitimately ended in a booking / transfer / emergency flag — suppresses hang-up noise. */
  resolvedOutcome?: boolean;
  isSynthetic?: boolean;
}

export function detectBadCall(input: DetectInput): BadCallFlag[] {
  if (input.isSynthetic) return [];
  const { conversation: c, timeline: t } = input;
  const flags: BadCallFlag[] = [];
  const ut = c.utterances;

  // 1) Long silence between speakers.
  for (let i = 1; i < ut.length; i++) {
    const prev = ut[i - 1];
    const cur = ut[i];
    const gapStart = prev.endMs ?? prev.startMs;
    if (gapStart === null || cur.startMs === null) continue;
    const gap = cur.startMs - gapStart;
    if (gap >= THRESHOLDS.silenceMs) {
      const who = cur.role === "agent" ? "agent was slow to respond" : "caller was silent after the agent spoke";
      flags.push({
        kind: "long_silence", severity: gap >= THRESHOLDS.silenceHighMs ? "high" : "medium",
        title: `Dead air of ${Math.round(gap / 1000)}s`, detail: `A ${Math.round(gap / 1000)}s gap before turn ${i}: ${who}.`,
        turnIndex: i, fingerprint: `long_silence:${i}`,
      });
    }
  }

  // 2) Repeated asks: the caller had to repeat themselves, or the agent asked the same thing again.
  for (const role of ["caller", "agent"] as const) {
    const list = ut.map((u, i) => ({ u, i })).filter((x) => x.u.role === role && tokens(x.u.text).length >= THRESHOLDS.repeatMinTokens);
    let best: { first: number; count: number } | null = null;
    for (let a = 0; a < list.length; a++) {
      const group = [list[a].i];
      for (let b = a + 1; b < list.length; b++) if (similarity(list[a].u.text, list[b].u.text) >= THRESHOLDS.repeatSimilarity) group.push(list[b].i);
      if (group.length >= THRESHOLDS.repeatMinCount && (!best || group.length > best.count)) best = { first: group[0], count: group.length };
    }
    if (best) {
      flags.push({
        kind: "repeated_ask", severity: best.count >= 3 ? "high" : "medium",
        title: role === "caller" ? "Caller had to repeat themselves" : "Agent repeated the same question",
        detail: `${role === "caller" ? "The caller" : "The agent"} said essentially the same thing ${best.count} times (first at turn ${best.first}).`,
        turnIndex: best.first, fingerprint: `repeated_ask:${role}`,
      });
    }
  }

  // 3) Abrupt hang-up.
  if (!input.resolvedOutcome && c.endedReason && CALLER_HANGUP_RE.test(c.endedReason) && ut.length) {
    const lastAgentIdx = [...ut].map((u, i) => ({ u, i })).reverse().find((x) => x.u.role === "agent");
    const dur = c.durationMs;
    const lastAgentAskedQuestion = !!lastAgentIdx && /[?؟]\s*$/.test(lastAgentIdx.u.text.trim());
    const afterLastAgent = lastAgentIdx && dur !== null && lastAgentIdx.u.endMs !== null ? dur - lastAgentIdx.u.endMs : null;
    const tooShort = dur !== null && dur < THRESHOLDS.shortCallMs && ut.some((u) => u.role === "agent");
    const hungUpOnQuestion = lastAgentAskedQuestion && afterLastAgent !== null && afterLastAgent >= 0 && afterLastAgent <= THRESHOLDS.hangupAfterAgentQuestionMs && ut[ut.length - 1].role === "agent";
    if (tooShort || hungUpOnQuestion) {
      flags.push({
        kind: "abrupt_hangup", severity: tooShort ? "high" : "medium",
        title: tooShort ? "Caller hung up within seconds" : "Caller hung up right after a question",
        detail: tooShort ? `Call ended by the caller after ${Math.round((dur ?? 0) / 1000)}s with no resolved outcome.` : "The caller ended the call right after the agent asked a question, with no outcome recorded.",
        turnIndex: lastAgentIdx?.i ?? null, fingerprint: "abrupt_hangup:call",
      });
    }
  }

  // 4) Low ASR confidence (only if the provider supplied confidence).
  const s = t.summary;
  const confSamples = ut.filter((u) => u.role === "caller" && u.confidence !== null).length;
  if (confSamples >= THRESHOLDS.asrMinSamples && ((s.asrConfidenceAvg ?? 1) < THRESHOLDS.asrAvgMin || s.asrLowConfidenceTurns >= THRESHOLDS.asrLowTurnCount)) {
    flags.push({
      kind: "low_asr_confidence", severity: (s.asrConfidenceAvg ?? 1) < 0.6 ? "high" : "medium",
      title: "Speech recognition confidence was low",
      detail: `Average ASR confidence ${s.asrConfidenceAvg ?? "n/a"} over ${confSamples} caller turns; ${s.asrLowConfidenceTurns} turns below ${THRESHOLDS.asrLowTurnMax}.`,
      turnIndex: null, fingerprint: "low_asr_confidence:call",
    });
  }

  // 5) Slow responses.
  if ((s.turnCount >= THRESHOLDS.slowMinTurns && (s.turnP95 ?? 0) > THRESHOLDS.slowTurnP95Ms) || (s.turnMax ?? 0) > THRESHOLDS.slowTurnAnyMs) {
    flags.push({
      kind: "slow_response", severity: (s.turnMax ?? 0) > THRESHOLDS.slowTurnAnyMs ? "high" : "medium",
      title: "Agent responded slowly",
      detail: `Turn latency p95 ${s.turnP95 ?? "n/a"}ms, max ${s.turnMax ?? "n/a"}ms over ${s.turnCount} turns.`,
      turnIndex: null, fingerprint: "slow_response:call",
    });
  }

  // 6) Tool failures.
  if (s.toolFailed > 0) {
    const failedNames = [...new Set(t.events.filter((e) => e.kind === "tool" && e.ok === false).map((e) => e.name))].slice(0, 4).join(", ");
    flags.push({
      kind: "tool_failure", severity: /book|schedule|transfer|emergency/i.test(failedNames) ? "high" : "medium",
      title: `${s.toolFailed} tool call${s.toolFailed > 1 ? "s" : ""} failed`,
      detail: `Failed: ${failedNames || "unknown"}; ${s.toolRetried} retried.`,
      turnIndex: null, fingerprint: "tool_failure:call",
    });
  }
  return flags;
}
