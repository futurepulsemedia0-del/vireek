// supabase/functions/_shared/fair-sale/load.ts
//
// I/O wrapper around the pure protocol. Loads the account's settings, the session's prior log
// (cumulative opt-ins/signals live in the log), the customer's trusted-contact state and the
// compliance evaluation; decides; then appends ONLY new events (idempotent) to the immutable log.
// Service-role client only. Never persists transcript text: customer turns are scanned in memory.
//
// NOT LEGAL ADVICE.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { evaluateForAccount } from "../compliance-rules/load.ts";
import type { EvaluationResult } from "../compliance-rules/types.ts";
import { DEFAULT_CONFIG, resolveConfig } from "./config.ts";
import { blockingItems, decide, recordChoice } from "./protocol.ts";
import { scanCustomerTurns } from "./signals.ts";
import { mapTruthVerdict } from "./secondLook.ts";
import {
  CONVERSATION_SIGNAL_CODES, OPT_IN_CODES, PROTECTION_IDS,
  type ConversationSignalCode, type EmergencyKind, type FairSaleConfig, type OptInCode, type ProtectionId, type ProtocolDecision,
} from "./types.ts";

export type SubjectType = "call" | "chat" | "quote" | "contract";
export type ActorType = "system" | "customer" | "staff" | "ai_agent";

export interface FairSaleRequest {
  subjectType: SubjectType;
  subjectId: string;
  customerId?: string | null;
  totalCents?: number;
  depositCents?: number;
  financingOfferedAtFirstContact?: boolean;
  scopeEscalationPercent?: number;
  thirdPartyOrCashPaymentRequested?: boolean;
  /** New opt-ins / signals the caller already classified (e.g. the voice assistant's tool call). */
  optIns?: OptInCode[];
  conversationSignals?: ConversationSignalCode[];
  /** Customer-side turns to scan in memory (chat / SMS). Never stored. */
  customerTurns?: string[];
  emergency?: EmergencyKind | null;
  customerEligibility?: string[];
  /** Quote Truth Engine verdict, when a quote exists. */
  truthVerdict?: string | null;
  counterpartyState?: string | null;
  address?: string | null;
  phone?: string | null;
  actor: { type: ActorType; id?: string | null };
}

export interface FairSaleResult {
  sessionId: string;
  decision: ProtocolDecision;
  /** Approvals that still block the sale (empty = nothing blocks). */
  blocking: string[];
  compliance: Pick<EvaluationResult, "outcome" | "actions" | "rescissionDeadline" | "eligibilityPrompts" | "assumptions"> | null;
  /** True only when notifying the customer's trusted contact is currently allowed. */
  trustedContactNotifiable: boolean;
  config: FairSaleConfig;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPT_SET = new Set<string>(OPT_IN_CODES);
const CONV_SET = new Set<string>(CONVERSATION_SIGNAL_CODES);
const PROT_SET = new Set<string>(PROTECTION_IDS);

function toConfig(row: Record<string, unknown> | null): FairSaleConfig {
  if (!row) return DEFAULT_CONFIG;
  try {
    return resolveConfig({
      largeJobCents: Number(row.large_job_cents), largeDepositCents: Number(row.large_deposit_cents),
      largeDepositPercent: Number(row.large_deposit_percent), scopeEscalationPercent: Number(row.scope_escalation_percent),
      pauseThresholdCents: Number(row.pause_threshold_cents), pauseHours: Number(row.pause_hours),
      managerApprovalDepositCents: Number(row.manager_approval_deposit_cents), managerApprovalFinancing: row.manager_approval_financing !== false,
      confusionRepeatThreshold: Number(row.confusion_repeat_threshold),
    });
  } catch {
    return DEFAULT_CONFIG; // never fail open into "no protection": fall back to platform defaults
  }
}

function jobBand(total: number | undefined, cfg: FairSaleConfig): "small" | "medium" | "large" | "unknown" {
  if (total === undefined) return "unknown";
  if (total >= cfg.largeJobCents) return "large";
  if (total >= 100_000) return "medium";
  return "small";
}

interface EventRow { event_type: string; protection: string | null; choice: string | null; signal_codes: string[] | null; details: Record<string, unknown> | null }

export async function runFairSale(admin: SupabaseClient, userId: string, req: FairSaleRequest, now: Date = new Date()): Promise<FairSaleResult> {
  if (!req.subjectId || req.subjectId.length > 120) throw new Error("subjectId is required (max 120 characters)");
  const customerId = req.customerId && UUID.test(req.customerId) ? req.customerId : null;

  const { data: settingsRow } = await admin.from("fair_sale_settings").select("*").eq("user_id", userId).maybeSingle();
  const config = toConfig(settingsRow as Record<string, unknown> | null);

  // Session (idempotent per subject).
  const scan = req.customerTurns?.length ? scanCustomerTurns(req.customerTurns, config) : { optIns: [], signals: [], activations: [] };
  const newOptIns = [...new Set([...(req.optIns ?? []), ...scan.optIns])].filter((c) => OPT_SET.has(c));
  const newSignals = [...new Set([...(req.conversationSignals ?? []), ...scan.signals])].filter((c) => CONV_SET.has(c));

  // Only fields this call actually knows: a later partial call must never blank out earlier facts.
  const sessionPatch: Record<string, unknown> = { user_id: userId, subject_type: req.subjectType, subject_id: req.subjectId, updated_at: now.toISOString() };
  if (customerId) sessionPatch.customer_id = customerId;
  if (req.emergency) sessionPatch.emergency = req.emergency;
  if (req.totalCents !== undefined) { sessionPatch.total_cents = req.totalCents; sessionPatch.job_band = jobBand(req.totalCents, config); }
  if (req.depositCents !== undefined) sessionPatch.deposit_cents = req.depositCents;
  if (/^[A-Za-z]{2}$/.test(req.counterpartyState ?? "")) sessionPatch.counterparty_state = req.counterpartyState!.toUpperCase();
  if (req.actor.id) sessionPatch.created_by = req.actor.id;
  const { data: session, error: sErr } = await admin.from("fair_sale_sessions")
    .upsert(sessionPatch, { onConflict: "user_id,subject_type,subject_id" }).select("id").single();
  if (sErr || !session) throw new Error(`fair_sale session failed: ${sErr?.message ?? "no row"}`);
  const sessionId = (session as { id: string }).id;

  // Cumulative state comes from the immutable log.
  const { data: prior } = await admin.from("fair_sale_events")
    .select("event_type, protection, choice, signal_codes, details").eq("session_id", sessionId).order("id", { ascending: true }).limit(2000);
  const events = (prior ?? []) as EventRow[];
  const seenSignals = new Set(events.filter((e) => e.event_type === "signal_detected").flatMap((e) => e.signal_codes ?? []));
  const allOptIns = [...new Set([...seenSignals].filter((c) => OPT_SET.has(c)).concat(newOptIns))] as OptInCode[];
  const allSignals = [...new Set([...seenSignals].filter((c) => CONV_SET.has(c)).concat(newSignals))] as ConversationSignalCode[];

  // Trusted-contact state for this customer (revocation always wins).
  let trustedContact = null as { consented: boolean; revoked: boolean } | null;
  if (customerId) {
    const { data: tcs } = await admin.from("fair_sale_trusted_contacts").select("status").eq("user_id", userId).eq("customer_id", customerId);
    const rows = (tcs ?? []) as Array<{ status: string }>;
    if (rows.length) trustedContact = { consented: rows.some((r) => r.status === "granted"), revoked: !rows.some((r) => r.status === "granted") };
  }

  // Law first: counsel-approved rules (cancellation windows, deposit caps, written-contract thresholds).
  let compliance: FairSaleResult["compliance"] = null;
  let ruleVersionIds: string[] = [];
  if (req.totalCents !== undefined || req.depositCents !== undefined) {
    try {
      const ev = await evaluateForAccount(admin, userId, {
        surface: req.subjectType === "contract" ? "contract" : "quote", customerId, phone: req.phone ?? null, address: req.address ?? null,
        counterpartyState: req.counterpartyState ?? null, subjectType: req.subjectType, subjectId: req.subjectId, source: "fair-sale", now,
        document: {
          totalCents: req.totalCents, depositCents: req.depositCents, isEmergencyRepair: !!req.emergency,
          customerEligibility: (req.customerEligibility ?? []).filter((c) => /^[a-z0-9_]{2,40}$/.test(c)),
        },
      });
      compliance = { outcome: ev.outcome, actions: ev.actions, rescissionDeadline: ev.rescissionDeadline, eligibilityPrompts: ev.eligibilityPrompts, assumptions: ev.assumptions };
      ruleVersionIds = ev.appliedVersionIds;
    } catch (e) {
      console.error(JSON.stringify({ event: "fair_sale_compliance_failed", error: String(e) }));
    }
  }

  const helpPromptDeclined = events.some((e) => e.event_type === "customer_choice" && e.protection === "help_check_prompt" && e.choice === "declined");
  let decision = decide({
    config, optIns: allOptIns, conversationSignals: allSignals, emergency: req.emergency ?? null, now, helpPromptDeclined, trustedContact,
    transaction: {
      totalCents: req.totalCents, depositCents: req.depositCents, financingOfferedAtFirstContact: req.financingOfferedAtFirstContact,
      scopeEscalationPercent: req.scopeEscalationPercent, thirdPartyOrCashPaymentRequested: req.thirdPartyOrCashPaymentRequested,
    },
    priceVerdict: req.truthVerdict === undefined ? undefined : mapTruthVerdict(req.truthVerdict),
  });
  // Re-apply the customer's recorded choices.
  for (const e of events) {
    if (e.event_type === "customer_choice" && e.protection && PROT_SET.has(e.protection) && (e.choice === "accepted" || e.choice === "declined" || e.choice === "deferred")) {
      decision = recordChoice(decision, e.protection as ProtectionId, e.choice);
    }
  }

  // Append only what the log does not already hold.
  const offered = new Set(events.filter((e) => e.event_type === "protection_offered").map((e) => e.protection));
  const approvalsSeen = new Set(events.filter((e) => e.event_type === "approval_requested").map((e) => String(e.details?.kind ?? "")));
  const append = (type: string, protection: string | null, signals: string[], actor: ActorType, details: Record<string, unknown> = {}, versions: string[] = []) =>
    admin.rpc("fair_sale_append_event", {
      p_session: sessionId, p_type: type, p_protection: protection, p_choice: null, p_signals: signals, p_versions: versions,
      p_actor_type: actor, p_actor: req.actor.id ?? null, p_details: details,
    });

  const inputActor: ActorType = req.actor.type;
  for (const c of [...newOptIns, ...newSignals]) {
    if (!seenSignals.has(c)) await append("signal_detected", null, [c], OPT_SET.has(c) ? "customer" : inputActor);
  }
  for (const a of decision.activations.filter((x) => x.source === "transaction")) {
    if (!seenSignals.has(a.code)) { await append("signal_detected", null, [a.code], "system", { ruleId: a.ruleId }); }
  }
  for (const p of decision.protections) {
    if (!offered.has(p.id)) {
      await append("protection_offered", p.id, p.because as string[], "system", p.holdUntil ? { holdUntil: p.holdUntil } : {});
      if (p.id === "no_same_day_decision" && p.holdUntil) {
        await append("pause_started", p.id, [], "system", { holdUntil: p.holdUntil });
        await admin.from("fair_sale_sessions").update({ hold_until: p.holdUntil }).eq("id", sessionId);
      }
    }
  }
  for (const a of decision.approvals) {
    if (approvalsSeen.has(a.kind)) continue;
    const { error } = await admin.from("fair_sale_reviews").upsert(
      { user_id: userId, session_id: sessionId, kind: a.kind, reason: a.reason, blocking: a.blocking, requested_by: req.actor.id ?? null },
      { onConflict: "session_id,kind", ignoreDuplicates: true });
    if (error) console.error(JSON.stringify({ event: "fair_sale_review_insert_failed", error: error.message }));
    await append("approval_requested", "manager_approval", [], "system", { kind: a.kind, blocking: a.blocking });
  }
  if (ruleVersionIds.length && !events.some((e) => e.event_type === "compliance_evaluated")) {
    await append("compliance_evaluated", null, [], "system", { outcome: compliance?.outcome ?? null }, ruleVersionIds);
  }
  await admin.from("fair_sale_sessions").update({ active: decision.active, updated_at: now.toISOString() }).eq("id", sessionId);

  // Resolved approvals.
  const { data: reviews } = await admin.from("fair_sale_reviews").select("kind, status").eq("session_id", sessionId);
  const resolved = ((reviews ?? []) as Array<{ kind: string; status: string }>).filter((r) => r.status === "approved").map((r) => `approval:${r.kind}`);

  return { sessionId, decision, blocking: blockingItems(decision, resolved), compliance, trustedContactNotifiable: decision.trustedContactNotifiable, config };
}

/** Records a customer's answer (voice/chat). Declines of non-declinable protections are rejected. */
export async function recordCustomerChoice(
  admin: SupabaseClient, userId: string, sessionId: string, protection: ProtectionId, choice: "accepted" | "declined" | "deferred", actor: ActorType, actorId?: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  if (!PROT_SET.has(protection)) return { ok: false, reason: "unknown protection" };
  if (choice === "declined" && ["human_callback", "no_false_urgency", "payment_channel_guard", "manager_approval", "price_second_look"].includes(protection)) {
    return { ok: false, reason: "This protection cannot be declined." };
  }
  const { data: s } = await admin.from("fair_sale_sessions").select("id").eq("id", sessionId).eq("user_id", userId).maybeSingle();
  if (!s) return { ok: false, reason: "session not found" };
  const { error } = await admin.rpc("fair_sale_append_event", {
    p_session: sessionId, p_type: "customer_choice", p_protection: protection, p_choice: choice, p_signals: [], p_versions: [],
    p_actor_type: actor, p_actor: actorId ?? null, p_details: {},
  });
  return error ? { ok: false, reason: error.message } : { ok: true };
}
