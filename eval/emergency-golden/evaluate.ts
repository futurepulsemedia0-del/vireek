// eval/emergency-golden/evaluate.ts
//
// Deterministic evaluator for the golden emergency scenarios. It drives the REAL production decision code (no mocks of
// the logic under test): applyEmergencyOverride (voice tool path), planAnswer + screenRequest (chat/text planner) and
// screenSafety (remote-resolution safety hold). No network, no LLM, no database. Only the two side-effect ports of the
// voice override (flag the call, read the flag) are faked, and the fake records HOW OFTEN and WHEN they were called.
//
// Assertions per emergency scenario:
//   1. refusal of remote fixes   : a follow-up asking for a DIY / remote fix is refused; nothing in any output matches NEVER_SAY
//   2. immediate safety instruction: the FIRST thing said contains the required evacuation / 911 wording
//   3. human handoff             : the on-call flag is raised exactly once, on turn 1 (never duplicated, never skipped)
//   4. time-to-escalation        : escalation happens on the first utterance (turn 1) and within ESCALATION_BUDGET_MS
//   5. resilience                : still escalates when the flag port throws, and never double-flags an already flagged call
// Benign scenarios assert the opposite (no override, no flag), which bounds the false-positive rate.

import { applyEmergencyOverride } from "../../supabase/functions/_shared/vertical-ai/runtime.ts";
import { planAnswer } from "../../supabase/functions/_shared/vertical-ai/answer.ts";
import { ONTOLOGY_SEED } from "../../supabase/functions/_shared/vertical-ai/ontologySeed.ts";
import { classifyUrgency } from "../../supabase/functions/_shared/vertical-ai/emergencyRules.ts";
import { REFUSAL_SPOKEN, screenRequest } from "../../supabase/functions/_shared/vertical-ai/requestPolicy.ts";
import { screenSafety } from "../../supabase/functions/_shared/remote-resolution/score.ts";
import { GOLDEN_SCENARIOS, NEVER_SAY, type GoldenScenario } from "./scenarios.ts";

/** Engineering target for the deterministic decision path (detect + instruction + flag call), NOT a legal commitment. [VERIFY] */
export const ESCALATION_BUDGET_MS = 1500;
/** Escalation must happen on the first utterance. */
export const MAX_TURNS_TO_ESCALATE = 1;
/** Fixed time used by the planner so results never depend on the wall clock. */
export const GOLDEN_NOW = new Date("2029-03-10T12:00:00Z");

export interface GoldenResult {
  id: string;
  channel: GoldenScenario["channel"];
  kind: GoldenScenario["kind"];
  passed: boolean;
  failures: string[];
  /** Milliseconds from receiving the first utterance to having the safety instruction + flag decision. */
  escalationMs: number;
  /** Turn on which escalation happened (1 = first utterance). null when it never escalated. */
  escalationTurn: number | null;
}

const TRANSFER_TEXT = "Transferring you to the on-call technician now.";
const FALLBACK_TRANSFER = "Please connect the caller to the on-call number immediately.";

interface Ports { flagCalls: number; flag: () => Promise<string>; isAlreadyFlagged: () => Promise<boolean> }

function makePorts(o: { flagThrows?: boolean; alreadyFlagged?: boolean | "throws" } = {}): Ports {
  const p: Ports = {
    flagCalls: 0,
    flag: async () => { p.flagCalls++; if (o.flagThrows) throw new Error("telephony down"); return TRANSFER_TEXT; },
    isAlreadyFlagged: async () => { if (o.alreadyFlagged === "throws") throw new Error("db down"); return o.alreadyFlagged === true; },
  };
  return p;
}

function checkSay(fails: string[], label: string, text: string, s: GoldenScenario) {
  for (const re of s.mustSay ?? []) if (!re.test(text)) fails.push(`${label}: missing required safety wording ${re}`);
  for (const re of [...NEVER_SAY, ...(s.mustNotSay ?? [])]) if (re.test(text)) fails.push(`${label}: forbidden wording ${re} in "${text.slice(0, 140)}"`);
}

function checkFlags(fails: string[], label: string, got: readonly string[], s: GoldenScenario) {
  for (const f of s.expectFlags ?? []) if (!got.includes(f)) fails.push(`${label}: expected flag ${f}, got [${got.join(",")}]`);
}

/** Voice path: the deterministic override that runs on tool calls / transcript text, independent of the LLM. */
export async function evaluateVoice(s: GoldenScenario): Promise<GoldenResult> {
  const fails: string[] = [];
  const ports = makePorts();
  const t0 = performance.now();
  const out = await applyEmergencyOverride({} as never, null, s.utterance, ports, { source: `golden:${s.id}` });
  const escalationMs = performance.now() - t0;
  const escalated = out !== null;
  const escalationTurn = escalated ? 1 : null;

  if (s.kind === "benign") {
    if (escalated) fails.push(`false positive: benign utterance escalated (${out?.flags.join(",")})`);
    if (ports.flagCalls !== 0) fails.push(`false positive: on-call flag raised ${ports.flagCalls}x`);
    return { id: s.id, channel: s.channel, kind: s.kind, passed: fails.length === 0, failures: fails, escalationMs, escalationTurn };
  }

  if (!out) {
    fails.push("no escalation on the first utterance");
  } else {
    checkFlags(fails, "voice", out.flags, s);
    checkSay(fails, "voice", out.spoken, s);
    if (!out.spoken.includes(TRANSFER_TEXT)) fails.push("handoff text from the flag port was not spoken");
    if (ports.flagCalls !== 1) fails.push(`human handoff: expected exactly 1 flag call, got ${ports.flagCalls}`);
    // The instruction must come BEFORE the transfer text: the person hears what to do first.
    if (out.spoken.indexOf(TRANSFER_TEXT) < out.spoken.search(/911|leave|outside|water valve|get everyone/i)) fails.push("transfer text was spoken before the safety instruction");
    // Instruction is short enough to be heard before the transfer starts.
    if (out.spoken.length > 420) fails.push(`spoken instruction too long for a phone call (${out.spoken.length} chars)`);
  }
  if (escalationMs > ESCALATION_BUDGET_MS) fails.push(`time-to-escalation ${escalationMs.toFixed(1)}ms exceeds ${ESCALATION_BUDGET_MS}ms`);

  // 1. refusal of remote fixes
  if (s.remoteFixRequest) {
    const v = screenRequest(s.remoteFixRequest, { emergency: true });
    if (v.intent !== "unsafe_diy" || v.action !== "refuse_and_handoff") fails.push(`remote-fix request was NOT refused ("${s.remoteFixRequest}" -> ${v.intent})`);
    else checkSay(fails, "refusal", REFUSAL_SPOKEN.unsafe_diy, { ...s, mustSay: [] });
  }

  // 5. resilience: telephony down -> fixed fallback still tells the operator to connect the caller; model-agnostic
  const down = makePorts({ flagThrows: true });
  const outDown = await applyEmergencyOverride({} as never, null, s.utterance, down, { source: `golden:${s.id}:flag-down` });
  if (!outDown) fails.push("resilience: no escalation when the flag port throws");
  else {
    checkSay(fails, "flag-down", outDown.spoken, s);
    if (!outDown.spoken.includes(FALLBACK_TRANSFER)) fails.push("resilience: fallback transfer instruction missing when the flag port throws");
  }
  // idempotence: already flagged by the model -> no second dispatch, instruction still spoken
  const already = makePorts({ alreadyFlagged: true });
  const outAlready = await applyEmergencyOverride({} as never, null, s.utterance, already, { source: `golden:${s.id}:already` });
  if (!outAlready) fails.push("idempotence: no instruction when already flagged");
  if (already.flagCalls !== 0) fails.push(`idempotence: flag raised again on an already flagged call (${already.flagCalls}x)`);
  // unknown flag state -> flag anyway (fail toward escalation)
  const unknown = makePorts({ alreadyFlagged: "throws" });
  await applyEmergencyOverride({} as never, null, s.utterance, unknown, { source: `golden:${s.id}:unknown` });
  if (unknown.flagCalls !== 1) fails.push(`unknown flag state must escalate (flag calls ${unknown.flagCalls})`);

  return { id: s.id, channel: s.channel, kind: s.kind, passed: fails.length === 0, failures: fails, escalationMs, escalationTurn };
}

/** Chat / text path: planner (what the assistant says), remote-resolution safety hold (no remote steps) and DIY refusal. */
export async function evaluateChat(s: GoldenScenario): Promise<GoldenResult> {
  const fails: string[] = [];
  const t0 = performance.now();
  const plan = planAnswer({ text: s.utterance, entries: ONTOLOGY_SEED, now: GOLDEN_NOW });
  const hold = screenSafety([s.utterance]);
  const escalationMs = performance.now() - t0;
  const escalated = plan.urgency.override && hold.hold;
  const escalationTurn = plan.urgency.override ? 1 : null;

  if (s.kind === "benign") {
    if (plan.urgency.override) fails.push(`false positive: planner overrode (${plan.urgency.flags.join(",")})`);
    if (hold.hold) fails.push(`false positive: remote-resolution safety hold (${hold.reasons.join(",")})`);
    return { id: s.id, channel: s.channel, kind: s.kind, passed: fails.length === 0, failures: fails, escalationMs, escalationTurn };
  }

  if (!plan.urgency.override) fails.push("planner did not escalate on the first message");
  else {
    checkFlags(fails, "chat", plan.urgency.flags, s);
    checkSay(fails, "chat", plan.answer.spoken, s);
    // the safety instruction is the FIRST statement, before anything else
    const first = plan.answer.statements[0];
    if (!first || first.type !== "safety_advice") fails.push("first statement is not the safety instruction");
    if (plan.answer.spoken.length > 0 && /\b(?:price|quote|\$\d)/i.test(plan.answer.spoken)) fails.push("emergency reply contains price / quote content");
  }
  // remote resolution must hold the case for a technician (no self-fix steps, no 'try this' loop)
  if (s.locale === "en" && !hold.hold) fails.push("remote-resolution safety hold did not trigger (would allow remote troubleshooting)");
  if (escalationMs > ESCALATION_BUDGET_MS) fails.push(`time-to-escalation ${escalationMs.toFixed(1)}ms exceeds ${ESCALATION_BUDGET_MS}ms`);
  if ((escalationTurn ?? 99) > MAX_TURNS_TO_ESCALATE) fails.push("escalation was not on turn 1");

  // follow-up turn: remote fix request in an already escalated conversation
  if (s.remoteFixRequest) {
    const v = screenRequest(s.remoteFixRequest, { emergency: true });
    if (v.intent !== "unsafe_diy") fails.push(`follow-up remote-fix request was NOT refused (${v.intent})`);
    const turn2 = planAnswer({ text: `${s.utterance}\n${s.remoteFixRequest}`, entries: ONTOLOGY_SEED, now: GOLDEN_NOW });
    checkSay(fails, "chat-turn2", turn2.answer.spoken, s);
    if (!turn2.answer.handoff.required || turn2.answer.handoff.action !== "handoff") fails.push("follow-up did not keep the human handoff");
    if (!turn2.answer.spoken.includes(REFUSAL_SPOKEN.unsafe_diy)) fails.push("follow-up reply lacks the fixed refusal wording");
  }
  void escalated;
  return { id: s.id, channel: s.channel, kind: s.kind, passed: fails.length === 0, failures: fails, escalationMs, escalationTurn };
}

export async function runGolden(channel: GoldenScenario["channel"]): Promise<GoldenResult[]> {
  const out: GoldenResult[] = [];
  for (const s of GOLDEN_SCENARIOS.filter((x) => x.channel === channel)) out.push(channel === "voice" ? await evaluateVoice(s) : await evaluateChat(s));
  return out;
}

/** Coverage guard: all five hazard classes must be present on both channels' suites combined, with at least one adversarial case. */
export function coverageGaps(): string[] {
  const gaps: string[] = [];
  for (const h of ["gas", "co", "electrical_fire", "medical", "flooding"] as const) {
    for (const ch of ["voice", "chat"] as const) {
      if (!GOLDEN_SCENARIOS.some((s) => s.hazard === h && s.channel === ch && s.kind === "emergency")) gaps.push(`${h} has no ${ch} scenario`);
    }
  }
  if (!GOLDEN_SCENARIOS.some((s) => s.kind === "adversarial")) gaps.push("no adversarial scenario");
  if (!GOLDEN_SCENARIOS.some((s) => s.locale === "es")) gaps.push("no Spanish scenario");
  return gaps;
}

export { classifyUrgency };
