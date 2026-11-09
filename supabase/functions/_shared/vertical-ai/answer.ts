// supabase/functions/_shared/vertical-ai/answer.ts
//
// One pure pipeline that turns a caller's words into a grounded, deterministic plan:
//   request screen -> emergency rules -> ontology lookups -> price resolution -> grounding gate -> spoken text.
// The live webhook handlers (runtime.ts) and the eval runner call this SAME function, so what the eval measures is
// what runs in production (minus the LLM, which this layer deliberately does not depend on).

import { composeGroundedAnswer, HANDOFF_SPOKEN, type GroundedAnswer } from "./grounding.ts";
import { classifyUrgency, emergencyInstruction } from "./emergencyRules.ts";
import { inferTrade } from "./intake.ts";
import {
  lookupPermitTriggers, lookupSafetyRule, lookupSymptoms, normalizeText, toEvidence,
  type OntologyEntry, type PermitPayload, type SymptomPayload,
} from "./ontology.ts";
import { resolvePrice, type PriceContext, type PriceResolution } from "./pricing.ts";
import { REFUSAL_SPOKEN, screenRequest, type RequestVerdict } from "./requestPolicy.ts";
import type { PriceItemLite } from "../price-book/match.ts";
import type { Assertion, EvidenceRef, Trade, UrgencyVerdict } from "./types.ts";

export interface PlanInput {
  text: string;
  entries: readonly OntologyEntry[];
  outdoorTempF?: number | null;
  callerJurisdiction?: string | null;
  now?: Date;
  /** Tenant price book rows (already tenant-scoped by the caller). Absent = no price assertions are possible. */
  priceBook?: readonly PriceItemLite[] | null;
  priceCtx?: PriceContext;
}

export interface Plan {
  urgency: UrgencyVerdict;
  request: RequestVerdict;
  trade: Trade | null;
  price: PriceResolution | null;
  answer: GroundedAnswer;
  evidenceIds: string[];
}

const PRICE_INTENT = /\b(?:how much|price|prices|pricing|cost|costs|charge|charges|rate|rates|quote|quotes|fee|fees|estimate|estimates)\b/;
const CODE_INTENT = /\b(?:code|codes|legal|illegal|permit|permits|nec|ipc|imc|upc|violation|clearance|required by|inspection required|need an inspection|pass inspection)\b/;
const WARRANTY_INTENT = /\b(?:warranty|warranties|guarantee|guaranteed|covered under|home warranty)\b/;

const URGENCY_RANK = { routine: 0, urgent: 1, emergency: 2 } as const;

const ruleEvidence = (flag: string): EvidenceRef => ({
  id: `rule:emergency:${flag}`, kind: "rule", confidence: 1, reviewed: true, source: "vireek-deterministic-emergency-rules",
});

function joinCauses(p: SymptomPayload): string {
  const c = p.causes.filter((x) => x.likelihood !== "low").slice(0, 3).map((x) => x.cause.charAt(0).toLowerCase() + x.cause.slice(1));
  return c.length <= 1 ? c.join("") : `${c.slice(0, -1).join(", ")} or ${c[c.length - 1]}`;
}

export function planAnswer(inp: PlanInput): Plan {
  const now = inp.now ?? new Date();
  const text = normalizeText(inp.text);
  let urgency = classifyUrgency({ text: inp.text, outdoorTempF: inp.outdoorTempF ?? null });
  const request = screenRequest(inp.text);
  const trade = inferTrade(inp.text, inp.entries, now);
  const assertions: Assertion[] = [];
  const evidenceIds = new Set<string>();

  // 1. Emergency: the safety instruction is ALWAYS emitted first, grounded in the safety_rule ontology row.
  if (urgency.override) {
    const instr = emergencyInstruction(urgency.flags);
    if (instr) {
      const rule = lookupSafetyRule(inp.entries, instr.flag, now);
      const ev: EvidenceRef[] = [ruleEvidence(instr.flag)];
      if (rule) ev.push(toEvidence(rule));
      assertions.push({ type: "safety_advice", text: instr.text, evidence: ev });
    }
  }

  // 2. Refused requests never produce technical/price content.
  if (request.action === "refuse_and_handoff" && request.intent !== "none") {
    const base = composeGroundedAnswer(assertions, { now, callerJurisdiction: inp.callerJurisdiction });
    const refusal = REFUSAL_SPOKEN[request.intent];
    return {
      urgency, request, trade, price: null,
      answer: {
        statements: base.statements, misses: base.misses,
        handoff: { required: true, reason: "ungrounded_assertion", action: "handoff" },
        spoken: [...base.statements.map((s) => s.text), refusal].join(" "),
      },
      evidenceIds: base.statements.flatMap((s) => s.evidenceIds),
    };
  }

  // 3. Technical content (skipped when an emergency instruction already owns the turn).
  let price: PriceResolution | null = null;
  let askInstead: string | null = null;
  if (!urgency.override) {
    const sym = lookupSymptoms(inp.entries, { text: inp.text, trade, jurisdiction: inp.callerJurisdiction, now })[0];
    if (sym) {
      const p = sym.entry.payload as SymptomPayload;
      // The ontology's urgency hint can only RAISE the rule verdict (e.g. "no cooling" is same-day work).
      if (URGENCY_RANK[p.urgency] > URGENCY_RANK[urgency.urgency]) urgency = { ...urgency, urgency: p.urgency, rules: [...urgency.rules, `ontology:${sym.entry.key}`] };
      assertions.push({ type: "diagnosis_hint", text: `Common causes include ${joinCauses(p)}. A technician would confirm on site.`, evidence: [toEvidence(sym.entry)] });
    }
    const permits = lookupPermitTriggers(inp.entries, { text: inp.text, trade, jurisdiction: inp.callerJurisdiction, now });
    for (const e of permits) assertions.push({ type: "code_permit", text: (e.payload as PermitPayload).note, evidence: [toEvidence(e)] });
    // "error code" / "fault code" is a thermostat or board readout, not a building-code question.
    const codeText = text.replace(/\b(?:error|fault|trouble|diagnostic|status|blink|blinking|flash|flashing) codes?\b/g, " ").replace(/\bcodes? (?:[a-z]?\d+)\b/g, " ");
    if (CODE_INTENT.test(codeText) && permits.length === 0) assertions.push({ type: "code_permit", text: "code requirement", evidence: [] });
    if (WARRANTY_INTENT.test(text)) assertions.push({ type: "price", text: "warranty coverage", evidence: [] });

    if (PRICE_INTENT.test(text) && inp.priceBook) {
      price = resolvePrice(inp.priceBook, inp.text, inp.priceCtx ?? { afterHours: false, emergency: false });
      if (price.status === "resolved") {
        const c = price.candidates[0];
        assertions.push({ type: "price", text: c.spoken, evidence: [{ id: `price_book:${c.itemId ?? "unknown"}`, kind: "price_book", confidence: 1, reviewed: true, source: "tenant price book" }] });
      } else if (price.status === "ambiguous") {
        askInstead = `Which one do you mean: ${price.candidates.map((c) => c.serviceName).join(", or ")}?`;
      } else {
        assertions.push({ type: "price", text: "price", evidence: [] });
      }
    }
    if (!trade && assertions.length === 0) askInstead = "Is this for heating and cooling, plumbing, or electrical?";
  }

  let answer = composeGroundedAnswer(assertions, { now, callerJurisdiction: inp.callerJurisdiction }, { askInstead });
  if (askInstead && assertions.length === 0) {
    // Nothing to assert yet and a required field is missing: ask instead of guessing.
    answer = { statements: [], misses: [], handoff: { required: true, reason: "nothing_grounded", action: "ask" }, spoken: askInstead };
  }
  if (urgency.override && answer.statements.length > 0) {
    // An emergency with a grounded safety instruction is handled (flag + transfer happen outside this text).
    answer = { ...answer, handoff: { required: false, reason: null, action: null } };
  } else if (urgency.override) {
    answer = { ...answer, spoken: `${HANDOFF_SPOKEN}` };
  }
  const evidence = answer.statements.flatMap((s) => s.evidenceIds);
  for (const id of evidence) evidenceIds.add(id);
  return { urgency, request, trade, price, answer, evidenceIds: [...evidenceIds] };
}
