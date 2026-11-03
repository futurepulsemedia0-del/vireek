// supabase/functions/_shared/notify/liveSurface.ts — pure builders for Live Activity / ongoing-notification state.
// No I/O. Customer names are only included when the person turned hiding OFF.

export type LiveEvent = "started" | "updated" | "ended";
export type LiveStage = "ringing" | "in_progress" | "handoff" | "ended";

export interface LiveCallRow {
  id: string;
  vapi_call_id: string;
  status: "ringing" | "in_progress" | "ended";
  is_emergency: boolean;
  handoff_status: "none" | "requested" | "failed";
  started_at: string;
  ended_at: string | null;
  caller_name: string | null;
  intent: string | null;
}

export interface LiveState {
  callId: string;          // vapi_call_id — Live Activity id / Android notification tag
  stage: LiveStage;
  emergency: boolean;
  headline: string;        // lock-screen line 1
  detail: string;          // lock-screen line 2
  startedAtMs: number;     // client renders the 00:42 timer from this; no per-second pushes needed
  endedAtMs: number | null;
}

export function stageOf(r: LiveCallRow): LiveStage {
  if (r.status === "ended") return "ended";
  if (r.handoff_status === "requested") return "handoff";
  return r.status === "ringing" ? "ringing" : "in_progress";
}

export function buildLiveState(r: LiveCallRow, hideNames: boolean): LiveState {
  const stage = stageOf(r);
  const who = !hideNames && r.caller_name ? r.caller_name : null;
  const headline = r.is_emergency ? "Emergency call" : "Live call";
  const detail =
    stage === "ended" ? "Call ended"
    : stage === "handoff" ? "Handing off to your team"
    : stage === "ringing" ? (who ? `Incoming — ${who}` : "Incoming")
    : (who ? `In progress — ${who}` : "In progress");
  const started = Date.parse(r.started_at);
  const ended = r.ended_at ? Date.parse(r.ended_at) : NaN;
  return {
    callId: r.vapi_call_id,
    stage,
    emergency: r.is_emergency,
    headline,
    detail,
    startedAtMs: Number.isFinite(started) ? started : Date.now(),
    endedAtMs: Number.isFinite(ended) ? ended : null,
  };
}

/** Apple stale-date / dismissal helpers (seconds since epoch). */
export function dismissalDateSec(endedAtMs: number | null, nowMs: number): number {
  return Math.floor(((endedAtMs ?? nowMs) + 60_000) / 1000); // keep final state ~1 min, then remove
}
