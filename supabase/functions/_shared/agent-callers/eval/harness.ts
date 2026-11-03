// Synthetic AI-caller harness. Drives the REAL engine (engine.ts) with scripted "agent" behaviour and checks
// global invariants on every reply, then per-scenario expectations.
//
// Global invariants (apply to every scenario, normal or adversarial):
//   I1  every currency amount spoken is one the fixture legitimately allows (no invented price / fee)
//   I2  every availability window spoken is one of the verified windows (no invented time)
//   I3  no caller-supplied payload text is echoed back to the assistant
//   I4  every reply <= MAX_REPLY_CHARS (short turns)
//   I5  deterministic: the same script yields byte-identical replies
//   I6  simulated port latency per tool call <= BUDGET.perToolMs, whole exchange <= BUDGET.totalMs
//   I7  a hold is only ever committed for an offered window id, never more than maxHoldsPerDay

import { identifyCaller, agentQuote, agentHold, agentSummaryChannel, finalizeAgentCall, type CallContext } from "../engine.ts";
import { moneyLabel } from "../../price-book/match.ts";
import { priceFromItem, type QuoteStatus } from "../protocol.ts";
import type { AgentCallerSettings } from "../settings.ts";
import { makePorts, type Recorder, type World } from "./memoryPorts.ts";
import { FIXTURE_ITEMS, WINDOWS, makeSettings, makeWorld } from "./world.ts";

export const MAX_REPLY_CHARS = 560;
export const BUDGET = { perToolMs: 800, totalMs: 3000 } as const;

export type Step =
  | { tool: "quote"; service: string; zip: string; statements?: string }
  | { tool: "hold"; window_id: string }
  | { tool: "summary"; channel: string; destination: string };

export interface Expect {
  mode: "agent" | "human";
  quoteStatus?: QuoteStatus[];
  /** Substrings that MUST appear somewhere in the quote reply. */
  includes?: string[];
  /** Substrings that must NOT appear in any reply. */
  excludes?: string[];
  commits?: number;
  summarySent?: boolean;
  events?: string[];
  platform?: string | null;
  emergency?: boolean;
}

export interface Scenario {
  id: string;
  trade: string;
  kind: "normal" | "adversarial";
  intro: string;
  steps: Step[];
  settings?: Record<string, unknown>;
  world?: Partial<World>;
  expect: Expect;
  /** Payload strings that must never be echoed (I3). */
  payloads?: string[];
}

export interface Reply { tool: string; text: string; ms: number }
export interface Outcome { replies: Reply[]; rec: Recorder; mode: "agent" | "human"; quoteStatuses: QuoteStatus[]; emergency: boolean; totalMs: number; summarySent: boolean; platform: string | null }

export function allowedAmounts(settings: AgentCallerSettings, world: World): Set<string> {
  const set = new Set<string>();
  for (const it of FIXTURE_ITEMS) {
    const p = priceFromItem(it, settings);
    set.add(moneyLabel(p.minCents));
    if (p.maxCents != null) set.add(moneyLabel(p.maxCents));
  }
  for (const c of Object.values(world.coverageByZip)) if (c.travelFeeCents != null) set.add(moneyLabel(c.travelFeeCents));
  return set;
}

export async function runOnce(s: Scenario): Promise<Outcome> {
  const settings = makeSettings(s.settings);
  const world = makeWorld(s.world);
  const { ports, rec } = makePorts(world);
  const ctx: CallContext = { settings, businessName: "Acme Home Services", currency: "USD" };
  const replies: Reply[] = [];
  const call = async (tool: string, fn: () => Promise<string>) => {
    rec.simulatedMs = 0;
    const text = await fn();
    replies.push({ tool, text, ms: rec.simulatedMs });
    return text;
  };

  const modeText = await call("identify", () => identifyCaller(ports, ctx, { caller_statements: s.intro }));
  const mode: "agent" | "human" = modeText.startsWith("AGENT CALLER MODE") ? "agent" : "human";
  const quoteStatuses: QuoteStatus[] = [];
  let emergency = false;

  for (const step of s.steps) {
    if (step.tool === "quote") {
      rec.simulatedMs = 0;
      const r = await agentQuote(ports, ctx, { service: step.service, zip: step.zip, caller_statements: step.statements });
      replies.push({ tool: "quote", text: r.text, ms: rec.simulatedMs });
      if (r.result) quoteStatuses.push(r.result.status);
      if (r.emergency) emergency = true;
    } else if (step.tool === "hold") {
      await call("hold", () => agentHold(ports, ctx, { window_id: step.window_id }));
    } else {
      await call("summary", () => agentSummaryChannel(ports, ctx, { channel: step.channel, destination: step.destination }));
    }
  }
  rec.simulatedMs = 0;
  const fin = await finalizeAgentCall(ports, ctx, [s.intro]);
  replies.push({ tool: "finalize", text: "", ms: rec.simulatedMs });
  const totalMs = replies.filter((r) => r.tool !== "finalize").reduce((a, r) => a + r.ms, 0);
  return { replies, rec, mode, quoteStatuses, emergency, totalMs, summarySent: fin.summarySent, platform: fin.platformClaimed };
}

/** Returns a list of failure messages (empty = PASS). */
export async function evaluate(s: Scenario): Promise<string[]> {
  const fails: string[] = [];
  const a = await runOnce(s);
  const b = await runOnce(s);
  const settings = makeSettings(s.settings);
  const world = makeWorld(s.world);
  const allowedMoney = allowedAmounts(settings, world);
  const allowedWindows = new Set(WINDOWS.map((w) => w.label));
  const all = a.replies.map((r) => r.text).join("\n");

  // I1
  for (const m of all.matchAll(/\$\d[\d,]*(?:\.\d{2})?/g)) if (!allowedMoney.has(m[0])) fails.push(`I1 invented amount ${m[0]}`);
  // I2
  for (const m of all.matchAll(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) [A-Z][a-z]+ \d{1,2} at \d{1,2}:\d{2} [AP]M/g)) if (!allowedWindows.has(m[0])) fails.push(`I2 invented window ${m[0]}`);
  // I3
  for (const p of s.payloads ?? []) if (all.toLowerCase().includes(p.toLowerCase())) fails.push(`I3 echoed payload "${p}"`);
  // I4
  // identify returns an INSTRUCTION for the model (never spoken); every other tool reply is read to the caller.
  for (const r of a.replies) if (r.tool !== "identify" && r.text.length > MAX_REPLY_CHARS) fails.push(`I4 ${r.tool} reply ${r.text.length} chars`);
  // I5
  if (JSON.stringify(a.replies.map((r) => r.text)) !== JSON.stringify(b.replies.map((r) => r.text))) fails.push("I5 non-deterministic replies");
  // I6
  for (const r of a.replies) if (r.ms > BUDGET.perToolMs) fails.push(`I6 ${r.tool} ${r.ms}ms > ${BUDGET.perToolMs}`);
  if (a.totalMs > BUDGET.totalMs) fails.push(`I6 total ${a.totalMs}ms > ${BUDGET.totalMs}`);
  // I7
  const offered = new Set(WINDOWS.map((w) => w.id as string));
  for (const c of a.rec.commits) if (!offered.has(c.windowId)) fails.push(`I7 committed unoffered window ${c.windowId}`);
  if (a.rec.commits.length + world.holdsToday > Math.max(settings.maxHoldsPerDay, world.holdsToday)) fails.push("I7 exceeded maxHoldsPerDay");

  const e = s.expect;
  if (a.mode !== e.mode) fails.push(`mode ${a.mode} != ${e.mode}`);
  if (e.quoteStatus && JSON.stringify(a.quoteStatuses) !== JSON.stringify(e.quoteStatus)) fails.push(`quoteStatus ${a.quoteStatuses} != ${e.quoteStatus}`);
  for (const t of e.includes ?? []) if (!all.includes(t)) fails.push(`missing "${t}"`);
  for (const t of e.excludes ?? []) if (all.includes(t)) fails.push(`unexpected "${t}"`);
  if (e.commits != null && a.rec.commits.length !== e.commits) fails.push(`commits ${a.rec.commits.length} != ${e.commits}`);
  if (e.summarySent != null && a.summarySent !== e.summarySent) fails.push(`summarySent ${a.summarySent} != ${e.summarySent}`);
  for (const ev of e.events ?? []) if (!a.rec.events.some((x) => x.type === ev)) fails.push(`missing event ${ev}`);
  if (e.platform !== undefined && a.platform !== e.platform) fails.push(`platform ${a.platform} != ${e.platform}`);
  if (e.emergency != null && a.emergency !== e.emergency) fails.push(`emergency ${a.emergency} != ${e.emergency}`);
  return fails;
}
