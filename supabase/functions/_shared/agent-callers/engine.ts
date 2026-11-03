// supabase/functions/_shared/agent-callers/engine.ts
//
// The orchestration for AI-agent callers, written against PORTS so the exact same code runs in production
// (runtime.ts: Supabase + capacity engine + SMS/email) and in the synthetic eval harness (eval/memoryPorts.ts).
// No Deno / npm imports. Every function returns the TEXT the voice assistant should act on and never throws:
// any failure degrades to "a team member will follow up", never to an invented number or time.

import type { PriceItemLite } from "../price-book/match.ts";
import { detectCaller, mergeDetections, type Detection } from "./detect.ts";
import { AGENT_MODE_INSTRUCTIONS, HUMAN_MODE_INSTRUCTIONS, composeHoldReply, composeQuote, type Coverage, type OfferedWindow, type QuoteData, type QuoteResult, type QuoteStatus } from "./protocol.ts";
import { assessAbuse, parseSummaryChannel, sanitizeCallerText, scanCallerText, type AbuseCounts, type SummaryChannel } from "./safety.ts";
import { makeHoldCode, buildSummaryEmail, buildSummarySms, type SummaryInput } from "./summary.ts";
import type { AgentCallerSettings } from "./settings.ts";
import type { AgentEventType } from "./funnel.ts";

export interface SessionState {
  detection: Detection | null;
  flags: number;
  quotes: number;
  lastQuote: { status: QuoteStatus; data: QuoteData } | null;
  hold: { code: string; status: "held" | "auto_booked"; windowId: string; windowStartIso: string; windowLabel: string; expiresAtIso: string | null } | null;
  summary: SummaryChannel | null;
  summarySent: boolean;
}

export const EMPTY_STATE: SessionState = { detection: null, flags: 0, quotes: 0, lastQuote: null, hold: null, summary: null, summarySent: false };

export type CommitOutcome =
  | { status: "ok" }
  | { status: "unavailable"; alternatives: string[] }
  | { status: "error" };

export interface Ports {
  loadState(): Promise<SessionState>;
  saveState(s: SessionState): Promise<void>;
  recordEvent(type: AgentEventType, detail?: Record<string, unknown>): Promise<void>;
  loadPriceItems(): Promise<PriceItemLite[]>;
  coverage(zip: string): Promise<Coverage>;
  /** null = capacity engine off/unavailable. Windows must come from the verified capacity engine only. */
  windows(service: string, zip: string): Promise<OfferedWindow[] | null>;
  abuseCounts(): Promise<Omit<AbuseCounts, "callFlags">>;
  holdsToday(): Promise<number>;
  summaryCounts(destination: string): Promise<{ toDestination24h: number; tenant24h: number }>;
  commit(a: { window: OfferedWindow; service: string; zip: string; mode: "hold" | "book"; code: string; expiresAtIso: string | null }): Promise<CommitOutcome>;
  sendSms(to: string, body: string): Promise<boolean>;
  sendEmail(to: string, subject: string, text: string, html: string): Promise<boolean>;
  now(): Date;
  random(): Uint8Array;
}

export interface CallContext {
  settings: AgentCallerSettings;
  businessName: string;
  currency: string;
  format?: (cents: number) => string;
}

const FOLLOW_UP = "A team member will follow up.";
const NOT_ACTIVE = "Agent quoting is not active for this call. Continue as for a human caller (use lookup_price for prices).";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function toTurns(statements: unknown): string[] {
  const raw = typeof statements === "string" ? statements : "";
  return raw.split(/\n+/).map((l) => sanitizeCallerText(l, 400)).filter(Boolean).slice(0, 20);
}

/** Tool: identify_caller_type. The model passes what the caller said; the SERVER decides what it means. */
export async function identifyCaller(p: Ports, ctx: CallContext, args: { caller_statements?: unknown }): Promise<string> {
  try {
    const state = await p.loadState();
    const turns = toTurns(args.caller_statements);
    const flags = scanCallerText(...turns);
    const next = detectCaller({ callerTurns: turns });
    const merged = mergeDetections(state.detection, next);
    const changed = !state.detection || state.detection.kind !== merged.kind;
    const updated: SessionState = { ...state, detection: merged, flags: state.flags + (flags.flagged ? 1 : 0) };
    await p.saveState(updated);
    if (changed) await p.recordEvent("detected", { kind: merged.kind, confidence: merged.confidence, platform_claimed: merged.platformClaimed, signals: merged.signals.map((s) => s.id) });
    if (flags.flagged) await p.recordEvent("injection_flagged", { injection: flags.injection, exfiltration: flags.exfiltration });
    return merged.useAgentProtocol && ctx.settings.enabled ? AGENT_MODE_INSTRUCTIONS : HUMAN_MODE_INSTRUCTIONS;
  } catch {
    return HUMAN_MODE_INSTRUCTIONS;
  }
}

export interface QuoteReply { text: string; emergency: boolean; result: QuoteResult | null }

/** Tool: agent_quote. */
export async function agentQuote(p: Ports, ctx: CallContext, args: { service?: unknown; zip?: unknown; caller_statements?: unknown }): Promise<QuoteReply> {
  try {
    const state = await p.loadState();
    if (!ctx.settings.enabled || !state.detection?.useAgentProtocol) return { text: NOT_ACTIVE, emergency: false, result: null };

    const service = sanitizeCallerText(args.service, 80);
    const statements = toTurns(args.caller_statements);
    const flags = scanCallerText(service, ...statements);
    let flagCount = state.flags;
    if (flags.flagged) {
      flagCount += 1;
      await p.recordEvent("injection_flagged", { injection: flags.injection, exfiltration: flags.exfiltration });
      await p.saveState({ ...state, flags: flagCount });
    }
    // An instruction-shaped "service" is never quoted; the caller is steered back to a plain service name.
    if (scanCallerText(service).flagged) {
      const verdict = assessAbuse({ callerQuotes24h: 0, callerDistinctServices24h: 0, callerDistinctZips24h: 0, tenantQuotes1h: 0, callFlags: flagCount }, ctx.settings);
      return { text: verdict.allow ? "That isn't a service name. Ask once: which service is needed?" : verdict.spoken, emergency: false, result: null };
    }

    const counts = await safe(() => p.abuseCounts(), { callerQuotes24h: 0, callerDistinctServices24h: 0, callerDistinctZips24h: 0, tenantQuotes1h: 0 });
    const verdict = assessAbuse({ ...counts, callFlags: flagCount }, ctx.settings);
    if (!verdict.allow) {
      await p.recordEvent("rate_limited", { reason: verdict.reason });
      return { text: verdict.spoken, emergency: false, result: null };
    }

    const zip = typeof args.zip === "string" ? args.zip : null;
    const zipOk = zip && /^\d{5}/.test(zip.trim()) ? zip.trim().slice(0, 5) : null;
    const [items, coverage, windows] = await Promise.all([
      safe(() => p.loadPriceItems(), [] as PriceItemLite[]),
      zipOk ? safe(() => p.coverage(zipOk), { status: "unknown", travelFeeCents: null } as Coverage) : Promise.resolve({ status: "unknown", travelFeeCents: null } as Coverage),
      zipOk && service ? safe(() => p.windows(service, zipOk), null) : Promise.resolve(null),
    ]);
    const holdsToday = await safe(() => p.holdsToday(), 0);
    const result = composeQuote({ settings: ctx.settings, items, service, zip: zipOk, callerContext: statements, coverage, windows, holdsToday, format: ctx.format });

    const next: SessionState = { ...state, flags: flagCount, quotes: state.quotes + (result.status === "quoted" ? 1 : 0), lastQuote: result.status === "quoted" ? { status: result.status, data: result.data } : state.lastQuote };
    await p.saveState(next);
    const evt: Partial<Record<QuoteStatus, AgentEventType>> = { quoted: "quote_given", emergency: "emergency_routed", refused_topic: "refused_topic", out_of_area: "out_of_area", blocked_area: "out_of_area" };
    const type = evt[result.status];
    if (type) await p.recordEvent(type, result.status === "quoted" ? { service: result.data.service, zip: result.data.zip, windows: result.data.windows.length } : { status: result.status });
    return { text: result.spoken, emergency: result.emergency, result };
  } catch {
    return { text: `I couldn't complete that quote. ${FOLLOW_UP}`, emergency: false, result: null };
  }
}

/** Tool: agent_hold_slot. Only windows from this call's last quote can be reserved. */
export async function agentHold(p: Ports, ctx: CallContext, args: { window_id?: unknown }): Promise<string> {
  try {
    const state = await p.loadState();
    if (!ctx.settings.enabled || !state.detection?.useAgentProtocol) return NOT_ACTIVE;
    if (state.hold) return composeHoldReply({ kind: "duplicate", code: state.hold.code, windowLabel: state.hold.windowLabel });
    if (ctx.settings.approvalMode === "quote_only") return composeHoldReply({ kind: "not_allowed", reason: "quote_only" });
    const q = state.lastQuote;
    if (!q || q.status !== "quoted" || !q.data.service || !q.data.zip) return composeHoldReply({ kind: "not_allowed", reason: "no_quote" });
    if (state.flags >= 2) return composeHoldReply({ kind: "not_allowed", reason: "abuse" });
    const id = typeof args.window_id === "string" ? args.window_id.trim().toUpperCase() : "";
    const window = q.data.windows.find((w) => w.id === id);
    if (!window) return composeHoldReply({ kind: "not_allowed", reason: "unknown_window" });
    if ((await safe(() => p.holdsToday(), ctx.settings.maxHoldsPerDay)) >= ctx.settings.maxHoldsPerDay) return composeHoldReply({ kind: "not_allowed", reason: "limit" });

    const mode = ctx.settings.approvalMode === "auto_book" ? "book" : "hold";
    const code = makeHoldCode(p.random());
    const expiresAtIso = mode === "hold" ? new Date(p.now().getTime() + ctx.settings.holdMinutes * 60_000).toISOString() : null;
    const out = await safe(() => p.commit({ window, service: q.data.service as string, zip: q.data.zip as string, mode, code, expiresAtIso }), { status: "error" } as CommitOutcome);
    if (out.status === "unavailable") return composeHoldReply({ kind: "unavailable", alternatives: out.alternatives });
    if (out.status !== "ok") return composeHoldReply({ kind: "error" });

    await p.saveState({ ...state, hold: { code, status: mode === "hold" ? "held" : "auto_booked", windowId: window.id, windowStartIso: window.startIso, windowLabel: window.label, expiresAtIso } });
    await p.recordEvent("hold_created", { mode, window: window.startIso });
    if (mode === "book") await p.recordEvent("hold_confirmed", { auto: true });
    return mode === "hold"
      ? composeHoldReply({ kind: "held", code, windowLabel: window.label, expiresLabel: expiresAtIso as string, holdMinutes: ctx.settings.holdMinutes })
      : composeHoldReply({ kind: "auto_booked", code, windowLabel: window.label });
  } catch {
    return composeHoldReply({ kind: "error" });
  }
}

/** Tool: agent_send_summary — records the channel; the message is sent after the call (finalizeAgentCall). */
export async function agentSummaryChannel(p: Ports, ctx: CallContext, args: { channel?: unknown; destination?: unknown }): Promise<string> {
  try {
    const state = await p.loadState();
    if (!ctx.settings.enabled || !state.detection?.useAgentProtocol) return NOT_ACTIVE;
    if (!state.lastQuote) return "Get a quote first, then ask for the summary channel.";
    const parsed = parseSummaryChannel(args.channel, args.destination, ctx.settings);
    if (!parsed.ok) {
      return parsed.reason === "disabled" ? "That channel is not available. Offer the other one, or skip it." : "That channel was not valid. Ask for a +1 phone number in international format or an email address, once.";
    }
    const counts = await safe(() => p.summaryCounts(parsed.value.destination), { toDestination24h: 0, tenant24h: 0 });
    if (counts.toDestination24h >= 3 || counts.tenant24h >= ctx.settings.maxSummariesPerDay) return "I can't send a summary to that channel right now.";
    await p.saveState({ ...state, summary: parsed.value });
    return "Noted: the written summary will be sent right after this call. No further action needed.";
  } catch {
    return "I couldn't record that channel. Skip the summary.";
  }
}

export interface FinalizeResult { kind: Detection["kind"] | null; confidence: number | null; platformClaimed: string | null; summarySent: boolean }

/** End-of-call: classify from the transcript if the tool was never used, then send the one-shot summary. */
export async function finalizeAgentCall(p: Ports, ctx: CallContext, callerTurns: string[]): Promise<FinalizeResult> {
  try {
    let state = await p.loadState();
    if (!state.detection) {
      const d = detectCaller({ callerTurns });
      state = { ...state, detection: d };
      await p.saveState(state);
      await p.recordEvent("detected", { kind: d.kind, confidence: d.confidence, platform_claimed: d.platformClaimed, signals: d.signals.map((s) => s.id), source: "transcript" });
    }
    let sent = state.summarySent;
    if (ctx.settings.enabled && state.detection?.useAgentProtocol && state.summary && state.lastQuote && !state.summarySent) {
      const q = state.lastQuote.data;
      const input: SummaryInput = {
        businessName: ctx.businessName, currency: ctx.currency, service: q.service, zip: q.zip, price: q.price, tripFee: q.tripFee,
        windows: q.windows.map((w) => ({ id: w.id, startIso: w.startIso, label: w.label })),
        hold: state.hold ? { code: state.hold.code, status: state.hold.status, windowStartIso: state.hold.windowStartIso, expiresAtIso: state.hold.expiresAtIso } : null,
      };
      const ok = state.summary.channel === "sms"
        ? await safe(() => p.sendSms((state.summary as SummaryChannel).destination, buildSummarySms(input)), false)
        : await safe(async () => { const e = buildSummaryEmail(input); return p.sendEmail((state.summary as SummaryChannel).destination, e.subject, e.text, e.html); }, false);
      sent = ok;
      await p.saveState({ ...state, summarySent: ok });
      await p.recordEvent(ok ? "summary_sent" : "summary_failed", { channel: state.summary.channel });
    }
    const d = state.detection;
    return { kind: d?.kind ?? null, confidence: d?.confidence ?? null, platformClaimed: d?.platformClaimed ?? null, summarySent: sent };
  } catch {
    return { kind: null, confidence: null, platformClaimed: null, summarySent: false };
  }
}
