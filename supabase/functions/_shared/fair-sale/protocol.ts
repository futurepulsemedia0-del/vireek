// supabase/functions/_shared/fair-sale/protocol.ts
//
// The Fair Sale decision function. Pure and deterministic: same facts => same protections.
// There is deliberately NO customer id, name, demographic, phone, address or random input.
//
// Law lives elsewhere: statutory cancellation windows, deposit caps, written-contract thresholds
// and required notices come from the counsel-approved compliance engine
// (_shared/compliance-rules). This module decides which VOLUNTARY, choice-preserving protections
// Vireek applies on top of the law. NOT LEGAL ADVICE.

import { detectTransactionSignals } from "./signals.ts";
import {
  NON_OVERRIDABLE,
  type Activation, type ApprovalRequest, type ConversationSignalCode, type DecideInput, type OptInCode,
  type ProtectionId, type ProtectionOffer, type ProtocolDecision, type SignalCode, type StaffOverride, type TransactionSignalCode,
} from "./types.ts";

const HOUR_MS = 3_600_000;

const OPT_IN_EXPLANATIONS: Record<OptInCode, string> = {
  trusted_contact: "The customer asked to involve a trusted contact.",
  more_time: "The customer asked for more time.",
  second_opinion: "The customer said they want to compare or get a second opinion.",
  written_summary: "The customer asked for the details in writing.",
};

const CONVERSATION_EXPLANATIONS: Record<ConversationSignalCode, string> = {
  repeated_confusion: "The customer said more than once that they did not understand.",
  feels_rushed: "The customer said they feel rushed or pressured.",
  third_party_pressure: "The customer said another person is insisting they decide.",
  third_party_payment_demand: "The customer said another person is insisting on a payment.",
};

const TEXT = {
  plain_summary: "We'll send a plain-language written summary of the price, the scope of work and your rights, so you can read it at your own pace.",
  no_same_day_decision: "For this size of job you don't have to decide today. We'll hold your quote and check back after the waiting period — and you can still choose to go ahead sooner if you wish.",
  price_second_look: "We double-check this price against our own price book before you're asked to approve it.",
  trusted_contact_offer: "If you'd like, we can share a copy of the summary with someone you trust. Only if you say yes, and you can change your mind at any time.",
  manager_approval: "A manager reviews this arrangement before anything is collected or financed.",
  help_check_prompt: "Is anyone helping you with this decision? It's completely fine either way — we just want you to have the support you'd like.",
  human_callback: "You can ask for a call from a real person at any time, and we'll make sure one happens.",
  no_false_urgency: "We never rush you. We won't tell you a price or an offer disappears today unless that is literally true and written down.",
  payment_channel_guard: "We only take payment to the company, by the methods on your invoice. We will never ask you to pay cash to an individual, buy gift cards or wire money.",
} as const satisfies Record<ProtectionId, string>;

function offer(
  id: ProtectionId,
  mode: ProtectionOffer["mode"],
  because: SignalCode[],
  extra: Partial<ProtectionOffer> = {},
): ProtectionOffer {
  return {
    id, mode, blocking: false, customerText: TEXT[id], because, choice: "pending",
    declinable: !NON_OVERRIDABLE.includes(id), ...extra,
  };
}

export function decide(input: DecideInput): ProtocolDecision {
  const { config, optIns, conversationSignals, transaction, emergency, now } = input;
  const tx = detectTransactionSignals(transaction, config);

  const activations: Activation[] = [
    ...optIns.map((code) => ({ source: "customer_opt_in" as const, code, ruleId: `optin-${code}`, explanation: OPT_IN_EXPLANATIONS[code] })),
    ...conversationSignals.map((code) => ({ source: "conversation" as const, code, ruleId: `conv-${code}`, explanation: CONVERSATION_EXPLANATIONS[code] })),
    ...tx.activations,
  ];
  const codes = (pred: (c: SignalCode) => boolean): SignalCode[] => [...new Set(activations.map((a) => a.code).filter(pred))];
  const has = (c: SignalCode) => activations.some((a) => a.code === c);
  const active = activations.length > 0;
  const emergencyPath = emergency !== null;

  const conv = conversationSignals as readonly SignalCode[];
  const txCodes = tx.signals as readonly TransactionSignalCode[];
  const protections: ProtectionOffer[] = [];
  const approvals: ApprovalRequest[] = [];

  // ---- Always on: Vireek's own conduct, independent of any signal -------------------------------
  protections.push(offer("no_false_urgency", "always", []));
  protections.push(offer("human_callback", "always", []));
  protections.push(offer("payment_channel_guard", "always", []));

  if (active) {
    // Plain-language summary: on whenever protection is active (and always when the customer asked).
    protections.push(offer("plain_summary", has("written_summary") ? "required" : "automatic", codes(() => true)));

    // Pause (non-emergency only): high value OR the customer asked for time OR the customer reported pressure.
    const total = transaction.totalCents;
    const highValue = total !== undefined && total >= config.pauseThresholdCents;
    const pauseBecause = codes((c) => c === "more_time" || c === "feels_rushed" || c === "third_party_pressure" || c === "large_job");
    if (!emergencyPath && (highValue || has("more_time") || has("feels_rushed") || has("third_party_pressure"))) {
      const thirdParty = has("third_party_pressure") || has("third_party_payment_demand");
      protections.push(offer("no_same_day_decision", "offered", pauseBecause.length ? pauseBecause : codes(() => true), {
        holdUntil: new Date(now.getTime() + config.pauseHours * HOUR_MS).toISOString(),
        // The customer keeps the right to proceed. If they reported third-party pressure, a staff
        // member confirms by phone first so the "yes, proceed" is really theirs.
        declineRequires: thirdParty ? "staff_callback" : "customer_statement",
        blocking: false,
      }));
    }

    // Second look at the price: any time the job is large, escalated or financed at first contact, or on request.
    if (txCodes.includes("large_job") || txCodes.includes("scope_escalation") || txCodes.includes("financing_at_first_contact") || has("second_opinion") || has("third_party_pressure")) {
      const verdict = input.priceVerdict;
      const needsReview = verdict === "above_range";
      protections.push(offer("price_second_look", needsReview ? "required" : "automatic", codes(() => true), { blocking: needsReview && !emergencyPath, declinable: false }));
      if (needsReview) approvals.push({ kind: "price", reason: "The quoted price is above the range in the price book.", blocking: !emergencyPath });
    }

    // Trusted contact: offered when the customer asked, or when the conversation shows confusion/pressure.
    if (has("trusted_contact") || conv.includes("repeated_confusion") || conv.includes("third_party_pressure") || conv.includes("feels_rushed") || conv.includes("third_party_payment_demand")) {
      protections.push(offer("trusted_contact_offer", "offered", codes((c) => c === "trusted_contact" || c === "repeated_confusion" || c === "third_party_pressure" || c === "feels_rushed" || c === "third_party_payment_demand")));
    }

    // Gentle helper prompt: offered, never repeated once declined, never framed around the person.
    if (!input.helpPromptDeclined && (conv.includes("repeated_confusion") || conv.includes("feels_rushed") || conv.includes("third_party_pressure") || has("trusted_contact"))) {
      protections.push(offer("help_check_prompt", "offered", codes((c) => c === "repeated_confusion" || c === "feels_rushed" || c === "third_party_pressure" || c === "trusted_contact")));
    }

    // Manager approval for large deposits / financing at first contact / unusual payment channel / scope escalation.
    const dep = transaction.depositCents ?? 0;
    const blockingApproval = !emergencyPath;
    if (dep > 0 && dep >= config.managerApprovalDepositCents) {
      approvals.push({ kind: "deposit", reason: "The upfront payment is above the manager-approval threshold.", blocking: blockingApproval });
    }
    if (config.managerApprovalFinancing && transaction.financingOfferedAtFirstContact === true) {
      approvals.push({ kind: "financing", reason: "Financing was offered at the customer's first contact.", blocking: blockingApproval });
    }
    if (transaction.thirdPartyOrCashPaymentRequested === true || has("third_party_payment_demand")) {
      // Never blocks life-safety work, but nothing is collected through the unusual channel.
      approvals.push({ kind: "payment_channel", reason: "Payment to a third party or by withdrawn cash was mentioned. Vireek will not facilitate it.", blocking: blockingApproval });
    }
    if (txCodes.includes("scope_escalation")) {
      approvals.push({ kind: "scope_escalation", reason: "The scope grew well beyond the original estimate.", blocking: blockingApproval });
    }
    if (approvals.some((a) => a.kind !== "price")) {
      protections.push(offer("manager_approval", "required", codes(() => true), { blocking: approvals.some((a) => a.blocking), declinable: false }));
    }
  }

  const explain = activations.map((a) => a.explanation);
  if (emergencyPath) explain.push("This is an emergency, so urgent safety work is never delayed; reviews happen alongside or afterwards.");

  const tc = input.trustedContact;
  return {
    active, activations, protections, approvals, emergencyPath, explain: [...new Set(explain)],
    trustedContactNotifiable: !!tc && tc.consented && !tc.revoked,
  };
}

/**
 * Staff may remove a voluntary protection (for example the pause for a customer who clearly and
 * independently wants to proceed) but never the honesty/payment/callback rules, and never a
 * protection the customer asked for. The override is returned alongside the new decision so the
 * caller can append it to the immutable log.
 */
export function applyOverride(decision: ProtocolDecision, override: StaffOverride, optIns: readonly OptInCode[]): { decision: ProtocolDecision; accepted: boolean; rejectedReason?: string } {
  if (override.reason.trim().length < 10) return { decision, accepted: false, rejectedReason: "A written reason of at least 10 characters is required." };
  if (NON_OVERRIDABLE.includes(override.protection)) return { decision, accepted: false, rejectedReason: "This protection can never be turned off." };
  const asked: Partial<Record<ProtectionId, OptInCode>> = { no_same_day_decision: "more_time", trusted_contact_offer: "trusted_contact", plain_summary: "written_summary", price_second_look: "second_opinion" };
  const requestedBy = asked[override.protection];
  if (requestedBy && optIns.includes(requestedBy)) return { decision, accepted: false, rejectedReason: "The customer asked for this protection, so it stays on." };
  const target = decision.protections.find((p) => p.id === override.protection);
  if (!target) return { decision, accepted: false, rejectedReason: "That protection is not active." };
  if (target.mode === "required") return { decision, accepted: false, rejectedReason: "Required protections cannot be overridden; resolve the underlying approval instead." };
  return { decision: { ...decision, protections: decision.protections.filter((p) => p.id !== override.protection) }, accepted: true };
}

/** A customer's answer to an offered protection. Returns a new decision; never mutates. */
export function recordChoice(decision: ProtocolDecision, id: ProtectionId, choice: "accepted" | "declined" | "deferred"): ProtocolDecision {
  return {
    ...decision,
    protections: decision.protections.map((p) => {
      if (p.id !== id) return p;
      if (choice === "declined" && !p.declinable) return p; // cannot decline honesty / payment / callback / approval rules
      return { ...p, choice };
    }),
  };
}

/**
 * Approvals that still block the sale from advancing. `resolved` holds `approval:<kind>` keys a
 * manager has approved. The customer's pause is never in this list: the customer can always
 * choose to proceed sooner (after the staff callback when third-party pressure was reported).
 */
export function blockingItems(decision: ProtocolDecision, resolved: readonly string[] = []): string[] {
  const items = decision.approvals.filter((a) => a.blocking).map((a) => `approval:${a.kind}`);
  return [...new Set(items)].filter((k) => !resolved.includes(k));
}
