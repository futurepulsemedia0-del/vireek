// supabase/functions/_shared/compliance-rules/load.ts
//
// I/O wrapper around the pure engine: loads the approved catalog, the account's
// compliance profile, the customer's state/timezone and the consent ledger, then
// evaluates and writes a decision-log row. Any edge function can call
// evaluateForAccount() (service-role client) — e.g. before sending a quote.
//
// NOT LEGAL ADVICE. Only counsel-approved rule versions are ever loaded.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { evaluate } from "./engine.ts";
import { resolveCounterpartyState, normalizeState } from "./jurisdiction.ts";
import type { BusinessLicense, ConsentState, ConsentType, DocumentFacts, EvaluationResult, Purpose, RuleVersion, Surface } from "./types.ts";

export interface EvaluateRequest {
  surface: Surface;
  purpose?: Purpose;
  customerId?: string | null;
  /** Used when there is no customer row. */
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  /** Explicit override of the customer's state (e.g. the job-site state). */
  counterpartyState?: string | null;
  aiVoice?: boolean;
  aiGenerated?: boolean;
  disclosureGiven?: boolean;
  outbound?: boolean;
  document?: Omit<DocumentFacts, "signedAt"> & { signedAt?: string };
  subjectType?: string;
  subjectId?: string;
  source?: string;
  /** Persist a decision-log row (default true). */
  log?: boolean;
  now?: Date;
}

const CONSENT_TYPES = new Set(["call_recording", "marketing_sms", "marketing_email", "data_processing", "marketing_call", "ai_voice"]);

export async function evaluateForAccount(admin: SupabaseClient, userId: string, req: EvaluateRequest): Promise<EvaluationResult> {
  const [{ data: catalog, error: catErr }, { data: profile }, { data: bp }] = await Promise.all([
    admin.rpc("compliance_catalog"),
    admin.from("compliance_profiles").select("business_state, licenses").eq("user_id", userId).maybeSingle(),
    admin.from("business_profile").select("timezone").eq("user_id", userId).maybeSingle(),
  ]);
  if (catErr) throw new Error(`compliance_catalog failed: ${catErr.message}`);

  let phone = req.phone ?? null;
  let email = req.email ?? null;
  let address = req.address ?? null;
  let customerTz: string | null = null;
  if (req.customerId) {
    const { data: c } = await admin
      .from("customers").select("phone, email, address, timezone")
      .eq("id", req.customerId).eq("user_id", userId).maybeSingle();
    if (c) {
      phone = phone ?? c.phone; email = email ?? c.email; address = address ?? c.address; customerTz = c.timezone ?? null;
    }
  }

  const resolved = req.counterpartyState
    ? { state: normalizeState(req.counterpartyState), basis: "explicit" as const }
    : resolveCounterpartyState({ address, phone });

  const consent: Partial<Record<ConsentType, ConsentState>> = {};
  if (phone || email) {
    const { data: states } = await admin.rpc("compliance_consent_states", { p_user: userId, p_phone: phone, p_email: email });
    if (states && typeof states === "object") {
      for (const [k, v] of Object.entries(states as Record<string, string>)) {
        if (CONSENT_TYPES.has(k) && (v === "granted" || v === "revoked" || v === "none")) consent[k as ConsentType] = v;
      }
    }
  }

  const licenses = Array.isArray(profile?.licenses) ? (profile!.licenses as BusinessLicense[]) : [];
  const doc = req.document ? { ...req.document, signedAt: req.document.signedAt ? new Date(req.document.signedAt) : undefined } : undefined;
  if (doc?.signedAt && Number.isNaN(doc.signedAt.getTime())) doc.signedAt = undefined;

  const result = evaluate(
    {
      surface: req.surface, purpose: req.purpose, at: req.now, outbound: req.outbound,
      businessState: profile?.business_state ?? null, businessTimezone: bp?.timezone ?? null,
      counterpartyState: resolved.state, counterpartyStateBasis: resolved.basis, counterpartyTimezone: customerTz,
      aiVoice: req.aiVoice, aiGenerated: req.aiGenerated, disclosureGiven: req.disclosureGiven,
      consent, licenses, document: doc,
    },
    (catalog ?? []) as RuleVersion[],
  );

  if (req.log !== false) {
    try {
      await admin.from("compliance_evaluations").insert({
        user_id: userId, surface: req.surface, purpose: req.purpose ?? null, outcome: result.outcome,
        subject_type: req.subjectType ?? null, subject_id: req.subjectId ?? null,
        business_state: result.jurisdictions.business, counterparty_state: result.jurisdictions.counterparty,
        summary: result.findings.filter((f) => f.status !== "pass").slice(0, 20).map((f) => ({ rule: f.ruleKey, jurisdiction: f.jurisdiction, status: f.status, message: f.message })),
        version_ids: result.appliedVersionIds, source: req.source ?? null,
      });
    } catch (e) {
      console.error(JSON.stringify({ event: "compliance_eval_log_failed", user_id: userId, error: String(e) }));
    }
  }
  return result;
}
