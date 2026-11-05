// supabase/functions/_shared/observability/replay.ts
//
// SANDBOX REPLAY. Raw audio and transcripts are deliberately NOT retained in the trace store, so a replay never
// re-runs the conversation. It re-evaluates a stored timeline (numbers only) against the CURRENT detector
// thresholds and reports which bad-call flags it would raise now vs. which were raised then — the practical use:
// tune thresholds / verify a fix against a real incident's latency + tool profile. Pure: no DB, no network.

import { THRESHOLDS, type BadCallKind } from "./badCallDetect.ts";
import type { CallTimeline } from "./callTimeline.ts";

export interface ReplayResult {
  vapiCallId: string;
  wouldFlagNow: BadCallKind[];
  flaggedThen: string[];
  newlyFlagged: BadCallKind[];
  noLongerFlagged: string[];
  /** Flags that need caller/agent text and therefore cannot be recomputed from the stored timeline. */
  notReplayable: BadCallKind[];
  notes: string[];
}

export function replayTimeline(timeline: CallTimeline, flaggedThen: string[]): ReplayResult {
  const s = timeline.summary;
  const now: BadCallKind[] = [];
  if ((s.turnCount >= THRESHOLDS.slowMinTurns && (s.turnP95 ?? 0) > THRESHOLDS.slowTurnP95Ms) || (s.turnMax ?? 0) > THRESHOLDS.slowTurnAnyMs) now.push("slow_response");
  if (s.toolFailed > 0) now.push("tool_failure");
  const confTurns = timeline.events.filter((e) => e.kind === "asr").length;
  if ((s.asrConfidenceAvg ?? 1) < THRESHOLDS.asrAvgMin && (confTurns >= THRESHOLDS.asrMinSamples || s.asrLowConfidenceTurns >= THRESHOLDS.asrLowTurnCount)) now.push("low_asr_confidence");
  const replayable: BadCallKind[] = ["slow_response", "tool_failure", "low_asr_confidence"];
  const notReplayable: BadCallKind[] = ["long_silence", "repeated_ask", "abrupt_hangup"];
  const then = new Set(flaggedThen);
  return {
    vapiCallId: timeline.vapiCallId,
    wouldFlagNow: now,
    flaggedThen,
    newlyFlagged: now.filter((k) => !then.has(k)),
    noLongerFlagged: flaggedThen.filter((k) => replayable.includes(k as BadCallKind) && !now.includes(k as BadCallKind)),
    notReplayable,
    notes: ["Audio and transcript are not stored in traces by design; this replays numeric signals only.", "No data was written and no provider was called."],
  };
}
