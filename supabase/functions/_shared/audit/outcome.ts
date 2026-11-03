// supabase/functions/_shared/audit/outcome.ts
//
// Turns a provider end-of-call report into the small, typed facts the score needs. Pure and defensive:
// the structured data comes from a model listening to a STRANGER's speech, so it is treated as untrusted input
// (whitelisted keys, clamped numbers, enums only). No transcript or audio is ever returned or stored.

import { classifyEndedReason, detectDncRequest } from "../speed-to-lead/core.ts";
import type { AnswerKind, CallObservations } from "./types.ts";

export interface RawCallReport {
  endedReason?: string | null;
  ringingAt?: string | null;
  answeredAt?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number | null;
  structured?: unknown;
  /** Used ONLY to detect "stop calling me" and then discarded; never persisted. */
  transientTranscript?: string | null;
  costUsd?: number | null;
}

export interface InterpretedCall {
  answer_kind: AnswerKind;
  ring_seconds: number | null;
  duration_seconds: number | null;
  observations: CallObservations;
  asked_to_stop: boolean;
  ended_reason: string | null;
  cost_cents: number;
}

const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const secs = (v: unknown): number | null | undefined => {
  if (v === null) return null;
  const n = typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(600, Math.round(n))) : undefined;
};
const ANSWERED_BY = new Set(["human", "ai_agent", "voicemail", "ivr_menu", "none"]);

export function sanitizeStructured(raw: unknown): { answered_by: string | null; observations: CallObservations; asked_to_stop: boolean } {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const by = typeof o.answered_by === "string" && ANSWERED_BY.has(o.answered_by) ? o.answered_by : null;
  const obs: CallObservations = {};
  const set = <K extends keyof CallObservations>(k: K, v: CallObservations[K] | undefined) => { if (v !== undefined) obs[k] = v; };
  set("greeting_present", bool(o.greeting_present));
  set("business_name_stated", bool(o.business_name_stated));
  set("callback_promised", bool(o.callback_promised));
  set("alternate_option_offered", bool(o.alternate_option_offered));
  set("greeting_seconds", secs(o.greeting_seconds));
  set("hold_seconds", secs(o.hold_seconds));
  set("offered_to_book", bool(o.offered_to_book_or_take_details));
  set("message_only", bool(o.could_take_message_only));
  return { answered_by: by, observations: obs, asked_to_stop: o.asked_to_stop === true || o.do_not_call === true };
}

const ms = (iso?: string | null): number => (iso ? Date.parse(iso) : NaN);

export function interpretCallReport(r: RawCallReport): InterpretedCall {
  const reason = (r.endedReason ?? "").toLowerCase();
  const s = sanitizeStructured(r.structured);

  let duration = typeof r.durationSeconds === "number" && Number.isFinite(r.durationSeconds) ? Math.round(r.durationSeconds) : null;
  if (duration === null && Number.isFinite(ms(r.startedAt)) && Number.isFinite(ms(r.endedAt)) && ms(r.endedAt) >= ms(r.startedAt)) {
    duration = Math.round((ms(r.endedAt) - ms(r.startedAt)) / 1000);
  }
  if (duration !== null) duration = Math.max(0, Math.min(3600, duration));

  const rangAt = ms(r.ringingAt);
  const stopAt = Number.isFinite(ms(r.answeredAt)) ? ms(r.answeredAt) : ms(r.endedAt);
  const ring = Number.isFinite(rangAt) && Number.isFinite(stopAt) && stopAt >= rangAt ? Math.min(600, Math.round((stopAt - rangAt) / 1000)) : null;

  let kind: AnswerKind;
  if (/busy/.test(reason)) kind = "busy";
  else {
    const base = classifyEndedReason(reason);
    if (base === "voicemail") kind = "voicemail";
    else if (base === "no_answer") kind = "no_answer";
    else if (base === "failed") kind = "failed";
    else {
      kind = s.answered_by === "human" ? "live_person"
        : s.answered_by === "ai_agent" ? "live_ai"
        : s.answered_by === "voicemail" ? "voicemail"
        : s.answered_by === "ivr_menu" ? "ivr"
        : s.answered_by === "none" && (duration ?? 0) < 8 ? "no_answer"
        : "unknown";
    }
  }

  return {
    answer_kind: kind,
    ring_seconds: ring,
    duration_seconds: duration,
    observations: s.observations,
    asked_to_stop: s.asked_to_stop || detectDncRequest(r.transientTranscript ?? null, null),
    ended_reason: r.endedReason ? String(r.endedReason).slice(0, 100) : null,
    cost_cents: typeof r.costUsd === "number" && Number.isFinite(r.costUsd) && r.costUsd >= 0 ? Math.min(500, Math.ceil(r.costUsd * 100)) : 0,
  };
}
