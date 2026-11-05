// supabase/functions/_shared/observability/callTimeline.ts
//
// Turns a Vapi end-of-call-report into (a) a COMPACT, PII-FREE per-call timeline that is
// safe to store and (b) an in-memory conversation view used only for bad-call detection.
// The conversation view contains text; it must never be persisted or logged. The timeline never does.
//
// UNVERIFIED PROVIDER ASSUMPTIONS (the parser is defensive: a missing/other shape yields
// null metrics, never a throw and never an invented number). Confirm against a real payload:
//   message.artifact.performanceMetrics.turnLatencies[] = { modelLatency, voiceLatency,
//        transcriberLatency, endpointingLatency, turnLatency }   (ms)   (same assumption as voice-brand/latency.ts)
//   message.artifact.messages[] = { role: user|bot|assistant|system|tool_calls|tool_call_result,
//        message, time (epoch ms), secondsFromStart, duration (ms), confidence? }
//   Audio quality (jitter / packet loss / MOS) is stored ONLY if numeric fields with those names exist
//   under message.artifact (excluding messages/transcript). Vapi may not supply them.

import { percentile } from "../voice-brand/styleCheck.ts";

export const TIMELINE_VERSION = 1;
const MAX_EVENTS = 150;
const MAX_TIMELINE_BYTES = 24_000;
const MAX_SANE_MS = 120_000;
const BARGE_IN_TOLERANCE_MS = 300;

export type EventKind = "lifecycle" | "turn" | "tool" | "interruption" | "silence" | "asr" | "provider" | "notify" | "crm";
export type AttrScalar = string | number | boolean | null;

export interface TimelineEvent {
  /** ms since call start (0 when unknown). */
  t: number;
  kind: EventKind;
  name: string;
  ok?: boolean;
  ms?: number;
  attrs?: Record<string, AttrScalar>;
}

export interface TimelineSummary {
  turnCount: number;
  turnP50: number | null;
  turnP95: number | null;
  turnP99: number | null;
  turnMax: number | null;
  llmTtfbP50: number | null;
  llmTtfbP95: number | null;
  asrP95: number | null;
  ttsTtfbP95: number | null;
  endpointingP95: number | null;
  timeToFirstWordMs: number | null;
  asrConfidenceAvg: number | null;
  asrConfidenceMin: number | null;
  asrLowConfidenceTurns: number;
  interruptions: number;
  toolTotal: number;
  toolFailed: number;
  toolRetried: number;
  jitterMs: number | null;
  packetLossPct: number | null;
  mos: number | null;
}

export interface CallTimeline {
  version: number;
  traceId: string;
  vapiCallId: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  endedReason: string | null;
  providers: { asr: string | null; llm: string | null; tts: string | null; telephony: string | null };
  summary: TimelineSummary;
  events: TimelineEvent[];
  truncated: boolean;
}

/** In-memory only. Contains text. NEVER store or log. */
export interface Utterance { role: "caller" | "agent"; startMs: number | null; endMs: number | null; text: string; confidence: number | null }
export interface Conversation { utterances: Utterance[]; durationMs: number | null; endedReason: string | null }

export interface ToolEventRow { tool: string; toolCallId: string | null; ok: boolean; ms: number | null; occurredAtMs: number | null; error?: string | null; booked?: boolean }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 80): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const sane = (v: unknown): number | null => { const n = num(v); return n !== null && n > 0 && n <= MAX_SANE_MS ? Math.round(n) : null; };

function pct(samples: number[], p: number): number | null {
  const v = percentile(samples, p);
  return Number.isFinite(v) ? Math.round(v) : null;
}

function artifactOf(message: unknown): Obj {
  const m = isObj(message) ? message : {};
  return isObj(m.artifact) ? m.artifact : {};
}

interface TurnMetric { turn: number | null; model: number | null; voice: number | null; transcriber: number | null; endpointing: number | null }

function turnMetrics(message: unknown): { turns: number[]; parts: TurnMetric[] } {
  const art = artifactOf(message);
  const pm = isObj(art.performanceMetrics) ? art.performanceMetrics : isObj((message as Obj)?.performanceMetrics) ? ((message as Obj).performanceMetrics as Obj) : {};
  const arr = Array.isArray(pm.turnLatencies) ? pm.turnLatencies : [];
  const turns: number[] = [];
  const parts: TurnMetric[] = [];
  for (const raw of arr) {
    const o = isObj(raw) ? raw : { turnLatency: raw };
    const turn = sane(o.turnLatency);
    parts.push({ turn, model: sane(o.modelLatency), voice: sane(o.voiceLatency), transcriber: sane(o.transcriberLatency), endpointing: sane(o.endpointingLatency) });
    if (turn !== null) turns.push(turn);
  }
  return { turns, parts };
}

function audioQuality(message: unknown): { jitterMs: number | null; packetLossPct: number | null; mos: number | null } {
  const art = artifactOf(message);
  const found: { jitterMs: number | null; packetLossPct: number | null; mos: number | null } = { jitterMs: null, packetLossPct: null, mos: null };
  const walk = (o: unknown, depth: number) => {
    if (!isObj(o) || depth > 3) return;
    for (const [k, v] of Object.entries(o)) {
      if (k === "messages" || k === "transcript" || k === "messagesOpenAIFormatted") continue;
      const key = k.toLowerCase().replace(/[^a-z]/g, "");
      const n = num(v);
      if (n !== null) {
        if (key.includes("jitter") && found.jitterMs === null && n >= 0 && n < 10_000) found.jitterMs = n;
        else if (key.includes("packetloss") && found.packetLossPct === null && n >= 0 && n <= 100) found.packetLossPct = n;
        else if ((key === "mos" || key.endsWith("mos") || key.includes("mosscore")) && found.mos === null && n >= 1 && n <= 5) found.mos = n;
      } else walk(v, depth + 1);
    }
  };
  walk(art, 0);
  return found;
}

/** Parse the conversation (text stays in memory) and the timestamps/confidence used for the timeline. */
export function parseConversation(message: unknown): Conversation {
  const m = isObj(message) ? message : {};
  const art = artifactOf(message);
  const call = isObj(m.call) ? m.call : {};
  const startedMs = typeof call.startedAt === "string" ? Date.parse(call.startedAt) : NaN;
  const endedMs = typeof call.endedAt === "string" ? Date.parse(call.endedAt) : NaN;
  const raw = Array.isArray(art.messages) ? art.messages : [];
  const utterances: Utterance[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const role = r.role === "user" ? "caller" : r.role === "bot" || r.role === "assistant" ? "agent" : null;
    const text = typeof r.message === "string" ? r.message : typeof r.content === "string" ? r.content : "";
    if (!role || !text.trim()) continue;
    const sfs = num(r.secondsFromStart);
    const abs = num(r.time);
    let startMs: number | null = sfs !== null ? Math.round(sfs * 1000) : abs !== null && Number.isFinite(startedMs) ? Math.round(abs - startedMs) : null;
    if (startMs !== null && (startMs < 0 || startMs > 6 * 3_600_000)) startMs = null;
    const dur = num(r.duration);
    const endMs = startMs !== null && dur !== null && dur > 0 && dur < 600_000 ? startMs + Math.round(dur) : null;
    const conf = num(r.confidence);
    utterances.push({ role, startMs, endMs, text: text.slice(0, 1000), confidence: conf !== null && conf >= 0 && conf <= 1 ? conf : null });
  }
  const dSec = num(m.durationSeconds) ?? num(art.durationSeconds);
  const durationMs = dSec !== null ? Math.round(dSec * 1000) : Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : null;
  return { utterances, durationMs, endedReason: str(m.endedReason) ?? str(call.endedReason) };
}

function providersOf(message: unknown): CallTimeline["providers"] {
  const m = isObj(message) ? message : {};
  const asst = isObj(m.assistant) ? m.assistant : isObj(m.call) && isObj((m.call as Obj).assistant) ? ((m.call as Obj).assistant as Obj) : {};
  const prov = (o: unknown): string | null => (isObj(o) ? str(o.provider, 40) : null);
  const phone = isObj(m.phoneNumber) ? m.phoneNumber : {};
  return { asr: prov(asst.transcriber), llm: prov(asst.model), tts: prov(asst.voice), telephony: str(phone.provider, 40) };
}

export interface BuildTimelineInput { traceId: string; vapiCallId: string; message: unknown; toolEvents?: ToolEventRow[]; extraEvents?: TimelineEvent[] }

export function buildCallTimeline(input: BuildTimelineInput): { timeline: CallTimeline; conversation: Conversation } {
  const conversation = parseConversation(input.message);
  const m = isObj(input.message) ? input.message : {};
  const call = isObj(m.call) ? m.call : {};
  const { turns, parts } = turnMetrics(input.message);
  const audio = audioQuality(input.message);
  const events: TimelineEvent[] = [];

  // Per-turn latency events (aligned to caller utterances when counts match; otherwise unanchored t=0).
  const callerStarts = conversation.utterances.filter((u) => u.role === "caller").map((u) => u.startMs);
  parts.forEach((p, i) => {
    if (p.turn === null) return;
    const anchored = parts.length === callerStarts.length ? callerStarts[i] : null;
    events.push({
      t: anchored ?? 0, kind: "turn", name: "turn", ms: p.turn, ok: p.turn <= 4000,
      attrs: { i, llm_ttfb_ms: p.model, tts_ttfb_ms: p.voice, asr_ms: p.transcriber, endpointing_ms: p.endpointing },
    });
  });

  // Barge-ins: caller starts speaking before the agent utterance ended.
  let interruptions = 0;
  const ut = conversation.utterances;
  for (let i = 1; i < ut.length; i++) {
    const prev = ut[i - 1];
    const cur = ut[i];
    if (prev.role === "agent" && cur.role === "caller" && prev.endMs !== null && cur.startMs !== null && cur.startMs < prev.endMs - BARGE_IN_TOLERANCE_MS) {
      interruptions++;
      events.push({ t: cur.startMs, kind: "interruption", name: "barge_in", attrs: { overlap_ms: prev.endMs - cur.startMs, turn: i } });
    }
  }

  // ASR confidence (only when the provider supplied it).
  const confs = ut.filter((u) => u.role === "caller" && u.confidence !== null).map((u) => u.confidence as number);
  const lowConf = confs.filter((c) => c < 0.6).length;

  // Time to first word: first agent utterance start.
  const firstAgent = ut.find((u) => u.role === "agent" && u.startMs !== null);
  const ttfw = firstAgent?.startMs ?? null;
  if (ttfw !== null) events.push({ t: ttfw, kind: "lifecycle", name: "first_word", ms: ttfw });

  // Tool events recorded live by the webhook (never reconstructed from text).
  const tools = input.toolEvents ?? [];
  const seen = new Map<string, number>();
  for (const t of tools) if (t.toolCallId) seen.set(t.toolCallId, (seen.get(t.toolCallId) ?? 0) + 1);
  const retried = [...seen.values()].filter((n) => n > 1).length;
  for (const t of tools) {
    events.push({ t: t.occurredAtMs ?? 0, kind: "tool", name: t.tool.slice(0, 48), ok: t.ok, ms: t.ms ?? undefined, attrs: t.error ? { error: t.error.slice(0, 80) } : undefined });
  }
  for (const e of input.extraEvents ?? []) events.push(e);

  const toolFailed = tools.filter((t) => !t.ok).length;
  const model = parts.map((p) => p.model).filter((v): v is number => v !== null);
  const voice = parts.map((p) => p.voice).filter((v): v is number => v !== null);
  const asr = parts.map((p) => p.transcriber).filter((v): v is number => v !== null);
  const endp = parts.map((p) => p.endpointing).filter((v): v is number => v !== null);

  const summary: TimelineSummary = {
    turnCount: turns.length,
    turnP50: pct(turns, 50), turnP95: pct(turns, 95), turnP99: pct(turns, 99), turnMax: turns.length ? Math.max(...turns) : null,
    llmTtfbP50: pct(model, 50), llmTtfbP95: pct(model, 95), asrP95: pct(asr, 95), ttsTtfbP95: pct(voice, 95), endpointingP95: pct(endp, 95),
    timeToFirstWordMs: ttfw,
    asrConfidenceAvg: confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 1000) / 1000 : null,
    asrConfidenceMin: confs.length ? Math.min(...confs) : null,
    asrLowConfidenceTurns: lowConf,
    interruptions, toolTotal: tools.length, toolFailed, toolRetried: retried,
    jitterMs: audio.jitterMs, packetLossPct: audio.packetLossPct, mos: audio.mos,
  };

  const compacted = compactEvents(events);
  const timeline: CallTimeline = {
    version: TIMELINE_VERSION,
    traceId: input.traceId,
    vapiCallId: input.vapiCallId,
    startedAt: str(call.startedAt, 40),
    endedAt: str(call.endedAt, 40),
    durationMs: conversation.durationMs,
    endedReason: conversation.endedReason,
    providers: providersOf(input.message),
    summary,
    events: compacted.events,
    truncated: compacted.truncated,
  };
  return { timeline, conversation };
}

/** Keep failures and the slowest turns first when over the event/byte budget; keep chronological order. */
export function compactEvents(events: TimelineEvent[]): { events: TimelineEvent[]; truncated: boolean } {
  let list = [...events].sort((a, b) => a.t - b.t);
  let truncated = false;
  const priority = (e: TimelineEvent): number => (e.ok === false ? 3 : e.kind === "interruption" ? 2 : (e.ms ?? 0) > 3000 ? 2 : 1);
  if (list.length > MAX_EVENTS) {
    truncated = true;
    list = [...list].sort((a, b) => priority(b) - priority(a) || a.t - b.t).slice(0, MAX_EVENTS).sort((a, b) => a.t - b.t);
  }
  while (JSON.stringify(list).length > MAX_TIMELINE_BYTES && list.length > 10) {
    truncated = true;
    const drop = list.reduce((best, e, i) => (priority(e) < priority(list[best]) ? i : best), 0);
    list.splice(drop, 1);
  }
  return { events: list, truncated };
}
