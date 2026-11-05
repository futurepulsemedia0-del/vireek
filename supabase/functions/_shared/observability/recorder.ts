// supabase/functions/_shared/observability/recorder.ts
//
// I/O layer of voice observability. CONTRACT: every export is best-effort and NEVER throws —
// a telemetry failure must not change a webhook response, a booking, or a call.
// Structural client type (no npm import) so the logic is unit-testable without Deno.

import { buildCallTimeline, type CallTimeline, type TimelineEvent, type ToolEventRow } from "./callTimeline.ts";
import { detectBadCall, type BadCallFlag } from "./badCallDetect.ts";
import { SpanCollector, otlpConfigFromEnv, type OtlpConfig } from "./otlp.ts";
import { scrubString, toSafeAttributes } from "./redact.ts";
import { newSpanId } from "./traceContext.ts";
import { callingCode } from "./geo.ts";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdminLike = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };

export interface TraceCtx { userId: string; vapiCallId: string; traceId: string }

/** Tool results are natural-language strings, so success is classified explicitly (and tested). */
export type ToolOutcome = "ok" | "soft_fail" | "exception";
const SOFT_FAIL_RE = /system error|wasn'?t able to|could not be matched|account is suspended|is not implemented|something went wrong|went wrong handling/i;
export function classifyToolResult(result: string | null | undefined, threw: boolean): ToolOutcome {
  if (threw) return "exception";
  return SOFT_FAIL_RE.test(result ?? "") ? "soft_fail" : "ok";
}
/** book_appointment returns "Booked for …" on success (see toolBookAppointment). Anything else is a conversational no-op or failure. */
export const isBookingSuccess = (result: string | null | undefined): boolean => /^Booked for /.test(result ?? "");

const ERROR_END_RE = /error|failed|did-not|timed-out|timeout|exceeded|no-available|not-found|pipeline-/i;
/** A call that ended for a technical reason (vs. normal hang-ups / assistant-ended / transfers). */
export function isErrorEnd(reason: string | null | undefined): boolean {
  return !!reason && ERROR_END_RE.test(reason);
}

export async function recordTraceEvent(
  admin: AdminLike,
  ctx: TraceCtx,
  ev: { kind: "lifecycle" | "tool" | "provider" | "notify" | "crm"; name: string; toolCallId?: string | null; ok?: boolean | null; durationMs?: number | null; attrs?: Record<string, unknown> },
): Promise<void> {
  try {
    await admin.from("call_trace_events").insert({
      user_id: ctx.userId, vapi_call_id: ctx.vapiCallId, trace_id: ctx.traceId,
      kind: ev.kind, name: ev.name.slice(0, 64), tool_call_id: ev.toolCallId?.slice(0, 128) ?? null,
      ok: ev.ok ?? null, duration_ms: ev.durationMs !== undefined && ev.durationMs !== null ? Math.max(0, Math.round(ev.durationMs)) : null,
      attrs: toSafeAttributes(ev.attrs ?? {}),
    });
  } catch { /* telemetry must never break the call */ }
}

interface EventRowDb { name: string; kind?: string; tool_call_id: string | null; ok: boolean | null; duration_ms: number | null; attrs: { error?: string; booked?: boolean } | null; occurred_at: string }

/** Tool events (retry/booking aware) + non-tool events (notify / crm / provider) recorded live during the call. */
export async function loadCallEvents(admin: AdminLike, ctx: TraceCtx, callStartMs: number | null): Promise<{ tools: ToolEventRow[]; extra: TimelineEvent[] }> {
  try {
    const { data } = await admin.from("call_trace_events")
      .select("name, kind, tool_call_id, ok, duration_ms, attrs, occurred_at")
      .eq("user_id", ctx.userId).eq("vapi_call_id", ctx.vapiCallId).order("occurred_at", { ascending: true }).limit(300);
    const tools: ToolEventRow[] = [];
    const extra: TimelineEvent[] = [];
    for (const r of (data ?? []) as EventRowDb[]) {
      const at = Date.parse(r.occurred_at);
      const offset = callStartMs !== null && Number.isFinite(at) ? Math.max(0, at - callStartMs) : null;
      const kind = r.kind ?? "tool";
      if (kind === "tool") {
        tools.push({ tool: r.name, toolCallId: r.tool_call_id, ok: r.ok !== false, ms: r.duration_ms, occurredAtMs: offset, error: r.attrs?.error ?? null, booked: r.attrs?.booked === true });
      } else if (kind === "notify" || kind === "crm" || kind === "provider") {
        extra.push({ t: offset ?? 0, kind, name: r.name.slice(0, 48), ok: r.ok !== false, ms: r.duration_ms ?? undefined });
      }
    }
    return { tools, extra };
  } catch { return { tools: [], extra: [] }; }
}

/** Back-compat: tool events only. */
export async function loadToolEvents(admin: AdminLike, ctx: TraceCtx, callStartMs: number | null): Promise<ToolEventRow[]> {
  return (await loadCallEvents(admin, ctx, callStartMs)).tools;
}

/**
 * Time an arbitrary side-effect (SMS, e-mail, CRM push, provider call) and attach it to the call trace.
 * Behaviour of `fn` is untouched: its result is returned and its errors are rethrown unchanged.
 * `ctx === null` (no call id) degrades to a plain call.
 */
export async function traceStep<T>(
  admin: AdminLike,
  ctx: TraceCtx | null,
  ev: { kind: "notify" | "crm" | "provider"; name: string; attrs?: Record<string, unknown> },
  fn: () => Promise<T>,
  isOk: (result: T) => boolean = () => true,
): Promise<T> {
  if (!ctx) return fn();
  const started = Date.now();
  try {
    const result = await fn();
    await recordTraceEvent(admin, ctx, { ...ev, ok: isOk(result), durationMs: Date.now() - started });
    return result;
  } catch (e) {
    await recordTraceEvent(admin, ctx, { ...ev, ok: false, durationMs: Date.now() - started, attrs: { ...(ev.attrs ?? {}), error: e instanceof Error ? e.name : "error" } });
    throw e;
  }
}

async function loadIsSyntheticTenant(admin: AdminLike, userId: string): Promise<boolean> {
  try {
    const { data } = await admin.from("profiles").select("is_synthetic_tenant").eq("id", userId).maybeSingle();
    return data?.is_synthetic_tenant === true;
  } catch { return false; }
}

export interface EndOfCallInput {
  admin: AdminLike;
  ctx: TraceCtx;
  message: unknown;
  region: string | null;
  /** calls.id of the already-upserted row, needed to enqueue quality findings. */
  callRowId: string | null;
  /** True when the call produced a booking / transfer / emergency flag (suppresses hang-up noise). */
  resolvedOutcome: boolean;
  /** Override. When undefined it is read from profiles.is_synthetic_tenant (the synthetic-probe tenants, see synthetic-monitoring runbook). */
  isSynthetic?: boolean;
  /** Env getter (Deno.env.get) so the OTLP exporter can be configured without importing Deno here. */
  getEnv: (k: string) => string | undefined;
}

export interface EndOfCallResult { timeline: CallTimeline | null; flags: BadCallFlag[]; enqueued: number }

/** Called once per call from the end-of-call-report handler (already idempotent via the webhook ledger). */
export async function recordEndOfCall(input: EndOfCallInput): Promise<EndOfCallResult> {
  const empty: EndOfCallResult = { timeline: null, flags: [], enqueued: 0 };
  try {
    const { admin, ctx } = input;
    const call = (input.message as { call?: { startedAt?: string } } | null)?.call;
    const startMs = call?.startedAt ? Date.parse(call.startedAt) : NaN;
    const { tools, extra } = await loadCallEvents(admin, ctx, Number.isFinite(startMs) ? startMs : null);
    const { timeline, conversation } = buildCallTimeline({ traceId: ctx.traceId, vapiCallId: ctx.vapiCallId, message: input.message, toolEvents: tools, extraEvents: extra });
    const s = timeline.summary;

    const bookingTools = tools.filter((t) => t.tool === "book_appointment");
    const bookingAttempted = bookingTools.length > 0;
    const booked = bookingTools.some((t) => t.booked === true);
    const resolvedByTool = tools.some((t) => t.ok && (t.tool === "flag_emergency_call" || t.tool === "request_human_transfer"));
    const answered = s.timeToFirstWordMs !== null || conversation.utterances.some((u) => u.role === "agent");
    const completed = timeline.endedReason ? !isErrorEnd(timeline.endedReason) : null;

    const isSynthetic = input.isSynthetic ?? (await loadIsSyntheticTenant(admin, ctx.userId));
    const flags = detectBadCall({ conversation, timeline, resolvedOutcome: input.resolvedOutcome || booked || resolvedByTool, isSynthetic });
    const turnSamples = timeline.events.filter((e) => e.kind === "turn" && typeof e.ms === "number").map((e) => e.ms as number).slice(0, 200);

    await admin.from("call_traces").upsert({
      user_id: ctx.userId, vapi_call_id: ctx.vapiCallId, trace_id: ctx.traceId, region: input.region?.slice(0, 40) ?? null,
      dial_code: callingCode((input.message as { phoneNumber?: { number?: unknown } } | null)?.phoneNumber?.number),
      asr_provider: timeline.providers.asr, llm_provider: timeline.providers.llm, tts_provider: timeline.providers.tts, telephony_provider: timeline.providers.telephony,
      started_at: timeline.startedAt, ended_at: timeline.endedAt, duration_ms: timeline.durationMs, ended_reason: timeline.endedReason,
      answered, completed, booking_attempted: bookingAttempted, booked,
      turn_ms: turnSamples, turn_count: s.turnCount, turn_p50_ms: s.turnP50, turn_p95_ms: s.turnP95, turn_p99_ms: s.turnP99, turn_max_ms: s.turnMax,
      ttfw_ms: s.timeToFirstWordMs, llm_ttfb_p95_ms: s.llmTtfbP95, tts_ttfb_p95_ms: s.ttsTtfbP95, asr_p95_ms: s.asrP95,
      asr_conf_avg: s.asrConfidenceAvg, interruptions: s.interruptions,
      tool_total: s.toolTotal, tool_failed: s.toolFailed, tool_retried: s.toolRetried,
      jitter_ms: s.jitterMs, packet_loss_pct: s.packetLossPct, mos: s.mos,
      flags: [...new Set(flags.map((f) => f.kind))], is_synthetic: isSynthetic, timeline,
    }, { onConflict: "user_id,vapi_call_id" });

    let enqueued = 0;
    if (flags.length && input.callRowId) {
      const { data } = await admin.rpc("enqueue_call_quality_flags", {
        p_user_id: ctx.userId, p_call_id: input.callRowId,
        p_flags: flags.map((f) => ({ kind: f.kind, severity: f.severity, title: f.title, detail: f.detail, turn_index: f.turnIndex, fingerprint: f.fingerprint })),
      });
      enqueued = typeof data === "number" ? data : 0;
    }

    await exportCallSpans(timeline, flags, input.getEnv, ctx);
    return { timeline, flags, enqueued };
  } catch {
    return empty;
  }
}

/** Builds a small span tree from the timeline (root call span + per-turn / per-tool children) and exports it (sampled). */
async function exportCallSpans(timeline: CallTimeline, flags: BadCallFlag[], getEnv: (k: string) => string | undefined, ctx: TraceCtx): Promise<void> {
  try {
    const cfg: OtlpConfig | null = otlpConfigFromEnv(getEnv);
    if (!cfg) return;
    const col = new SpanCollector(ctx.traceId);
    const t0 = timeline.startedAt ? Date.parse(timeline.startedAt) : Date.now() - (timeline.durationMs ?? 0);
    const end = timeline.endedAt ? Date.parse(timeline.endedAt) : t0 + (timeline.durationMs ?? 0);
    const root = col.start("voice.call", {
      "call.duration_ms": timeline.durationMs ?? 0, "call.ended_reason": scrubString(timeline.endedReason ?? "unknown", 80),
      "call.flags": flags.map((f) => f.kind).join(","), "voice.asr": timeline.providers.asr ?? "", "voice.llm": timeline.providers.llm ?? "", "voice.tts": timeline.providers.tts ?? "",
      "turn.p95_ms": timeline.summary.turnP95 ?? -1, "ttfw_ms": timeline.summary.timeToFirstWordMs ?? -1,
    }, "server");
    // Child spans are emitted from timeline events with their own timestamps.
    for (const e of timeline.events as TimelineEvent[]) {
      if ((e.kind !== "turn" && e.kind !== "tool") || typeof e.ms !== "number") continue;
      col.spans.push({
        traceId: ctx.traceId, spanId: newSpanId(),
        parentSpanId: root.spanId, name: e.kind === "tool" ? `tool.${e.name}` : "voice.turn", kind: "internal",
        startMs: t0 + e.t, endMs: t0 + e.t + e.ms, ok: e.ok !== false, attributes: e.attrs ?? {},
      });
    }
    root.end(flags.every((f) => f.severity !== "high" && f.severity !== "critical"), {});
    const rootSpan = col.spans.find((s) => s.spanId === root.spanId);
    if (rootSpan) { rootSpan.startMs = t0; rootSpan.endMs = Math.max(end, t0); }
    await col.flush(cfg, { forceKeep: flags.length > 0 });
  } catch { /* never throw */ }
}

/**
 * Run telemetry work AFTER the response is sent (EdgeRuntime.waitUntil) so it adds zero latency to a live call.
 * Outside the edge runtime it simply runs detached. Never throws, never rejects.
 */
export function runInBackground(p: Promise<unknown>): void {
  const safe = p.catch(() => undefined);
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(safe);
}
