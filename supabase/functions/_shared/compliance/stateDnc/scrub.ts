// supabase/functions/_shared/compliance/stateDnc/scrub.ts
//
// I/O half of the state-DNC scrub. Dependency-light on purpose (structural `admin`, injected internal-DNC check) so it
// runs under Deno AND under `node --experimental-strip-types` in scripts/compliance/state-dnc.test.mjs.
//
//   scrubBeforeDial(): resolve residency -> load ACTIVE lists + rules -> look the number up in the relevant lists ->
//   decide -> WRITE THE PROOF -> return. It never throws.
//
// Modes (env STATE_DNC_GATE_MODE, parsed by the caller):
//   shadow (default)  everything is computed and the proof is stored, but the call is NEVER held by this gate.
//   enforce           a non-"clear" decision, a lookup failure OR a proof-write failure holds the call (fail closed).
//
// No claim is made about any registry API: lists are files the account imported (see dnc-registry-import).

import { resolveCounterpartyState } from "../../compliance-rules/jurisdiction.ts";
import { toE164 } from "../callBlockEngine.ts";
import {
  decideScrub, normalizePurpose, relevantLists, STATE_DNC_RULES_VERSION,
  type Decision, type DncPurpose, type GateMode, type ListMeta, type Outcome, type Residency, type RuleRow,
} from "./decide.ts";

export { parseGateMode, STATE_DNC_RULES_VERSION } from "./decide.ts";
export type { Decision, GateMode } from "./decide.ts";

// deno-lint-ignore no-explicit-any
export interface AdminLike { from(table: string): any }

export interface ScrubDeps {
  admin: AdminLike;
  gateMode: GateMode;
  /** The account's own opt-out list (dnc_suppressions + optional external layer). */
  isInternallySuppressed: (ownerId: string, phone: string) => Promise<boolean>;
  now?: () => Date;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface ScrubRequest {
  ownerId: string;
  phone: string;
  purpose?: string | null;
  /** Calling function, e.g. "outbound-dialer". */
  source: string;
  /** Row the call belongs to (outbound_calls.id, speed_to_lead_requests.id, ...). */
  correlationId?: string | null;
  explicitState?: string | null;
  address?: string | null;
}

export interface ScrubResult {
  /** false only in enforce mode when the call must not be placed now. */
  allow: boolean;
  /** true whenever enforce mode WOULD hold the call (also in shadow, where nothing is held). */
  wouldBlock: boolean;
  decision: Decision;
  reasonCode: string;
  retryable: boolean;
  /** ISO time to try again when retryable, else null. */
  retryAt: string | null;
  proofId: string | null;
  mode: GateMode;
}

const RETRY_MINUTES = 15;

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function asListMeta(r: Record<string, unknown>): ListMeta {
  return {
    id: String(r.id), jurisdiction: String(r.jurisdiction), name: String(r.name ?? ""),
    versionLabel: (r.version_label as string | null) ?? null, effectiveDate: (r.effective_date as string | null) ?? null,
    expiresAt: (r.expires_at as string | null) ?? null, activatedAt: (r.activated_at as string | null) ?? null,
    rowCount: Number(r.row_count ?? 0), contentSha256: (r.content_sha256 as string | null) ?? null,
  };
}
function asRule(r: Record<string, unknown>): RuleRow {
  return {
    jurisdiction: String(r.jurisdiction),
    appliesToPurposes: Array.isArray(r.applies_to_purposes) ? (r.applies_to_purposes as string[]) : [],
    maxAgeDays: r.max_age_days == null ? null : Number(r.max_age_days),
    requireActiveList: r.require_active_list === true,
  };
}

async function loadActiveLists(admin: AdminLike, owner: string): Promise<ListMeta[]> {
  const { data, error } = await admin.from("dnc_registry_lists")
    .select("id, jurisdiction, name, version_label, effective_date, expires_at, activated_at, row_count, content_sha256")
    .eq("account_owner_id", owner).eq("status", "active");
  if (error) throw new Error(`lists_lookup_failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(asListMeta);
}

async function loadRules(admin: AdminLike, owner: string): Promise<RuleRow[]> {
  const { data, error } = await admin.from("dnc_state_rules")
    .select("jurisdiction, applies_to_purposes, max_age_days, require_active_list").eq("account_owner_id", owner);
  if (error) throw new Error(`rules_lookup_failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(asRule);
}

async function matchLists(admin: AdminLike, owner: string, phone: string, listIds: string[]): Promise<Set<string>> {
  if (listIds.length === 0) return new Set();
  const { data, error } = await admin.from("dnc_registry_entries").select("list_id")
    .eq("account_owner_id", owner).eq("phone_e164", phone).in("list_id", listIds);
  if (error) throw new Error(`entries_lookup_failed: ${error.message}`);
  return new Set(((data ?? []) as { list_id: string }[]).map((r) => r.list_id));
}

function blockedOutcome(decision: Decision, reasonCode: string, retryable: boolean): Outcome {
  return { decision, reasonCode, retryable, relevantListIds: [], matchedListIds: [], evidence: [] };
}

export async function scrubBeforeDial(deps: ScrubDeps, req: ScrubRequest): Promise<ScrubResult> {
  const now = (deps.now ?? (() => new Date()))();
  const purpose: DncPurpose = normalizePurpose(req.purpose);
  const log = deps.log ?? ((event, data) => console.error(JSON.stringify({ event, ...data })));
  const e164 = toE164(req.phone ?? "");
  const residency: Residency = resolveCounterpartyState({ explicitState: req.explicitState, address: req.address, phone: e164 ?? req.phone });

  let outcome: Outcome;
  let internalHit = false;
  if (!e164) {
    outcome = blockedOutcome("blocked_invalid_number", "INVALID_NUMBER", false);
  } else {
    try {
      const [lists, rules, internal] = await Promise.all([
        loadActiveLists(deps.admin, req.ownerId),
        loadRules(deps.admin, req.ownerId),
        deps.isInternallySuppressed(req.ownerId, e164),
      ]);
      internalHit = internal === true;
      const ids = relevantLists(lists, residency).map((l) => l.id);
      const matched = await matchLists(deps.admin, req.ownerId, e164, ids);
      outcome = decideScrub({ purpose, residency, lists, rules, matchedListIds: matched, internalHit, now });
    } catch (err) {
      log("state_dnc_lookup_failed", { source: req.source, error: err instanceof Error ? err.message : String(err) });
      outcome = blockedOutcome("blocked_unavailable", "LOOKUP_FAILED", true);
    }
  }

  const wouldBlock = outcome.decision !== "clear";
  let proofId: string | null = null;
  let proofFailed = false;
  try {
    const phoneForHash = e164 ?? String(req.phone ?? "");
    const row = {
      account_owner_id: req.ownerId,
      phone_sha256: await sha256Hex(`${req.ownerId}|${phoneForHash}`),
      phone_last4: phoneForHash.replace(/\D/g, "").slice(-4) || "0",
      source: req.source.slice(0, 60),
      purpose,
      correlation_id: req.correlationId ? String(req.correlationId).slice(0, 120) : null,
      resolved_state: residency.state,
      residency_basis: residency.basis,
      gate_mode: deps.gateMode,
      decision: outcome.decision,
      reason_code: outcome.reasonCode,
      would_block: wouldBlock,
      internal_dnc_hit: internalHit,
      matched_list_ids: outcome.matchedListIds,
      lists: outcome.evidence,
      rules_version: STATE_DNC_RULES_VERSION,
      checked_at: now.toISOString(),
    };
    const { data, error } = await deps.admin.from("dnc_scrub_proofs").insert(row).select("id").single();
    if (error || !data) throw new Error(error?.message ?? "no_row_returned");
    proofId = String((data as { id: string }).id);
  } catch (err) {
    proofFailed = true;
    log("state_dnc_proof_write_failed", { source: req.source, error: err instanceof Error ? err.message : String(err) });
  }

  // Enforce mode: no proof => no call. The proof is the evidence that the scrub happened.
  let decision = outcome.decision;
  let reasonCode = outcome.reasonCode;
  let retryable = outcome.retryable;
  if (deps.gateMode === "enforce" && proofFailed && decision === "clear") {
    decision = "blocked_unavailable"; reasonCode = "PROOF_WRITE_FAILED"; retryable = true;
  }
  const blocked = decision !== "clear";
  const allow = deps.gateMode === "enforce" ? !blocked : true;
  return {
    allow, wouldBlock: blocked, decision, reasonCode, retryable, mode: deps.gateMode, proofId,
    retryAt: retryable && blocked ? new Date(now.getTime() + RETRY_MINUTES * 60_000).toISOString() : null,
  };
}
