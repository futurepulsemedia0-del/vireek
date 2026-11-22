// supabase/functions/_shared/sanctions/gate.ts
//
// The screening gate. Call sites:
//   - auth-before-user-created   runScreening({ checkpoint: "signup", ownerId: null, requireSubject: false })
//   - stripe-connect-onboarding  runScreening({ checkpoint: "payout_setup", requireSubject: true, requireCountry: true })
//   - instantPayouts             checkAccountGate(ownerId)   (state only, no provider call)
//
// Fail-closed rules (enforce mode):
//   provider missing / timeout / invalid response / store failure / missing hash secret / broken settings  => DENY
//   a staff-confirmed block                                                                                 => DENY in EVERY mode
// shadow mode records what would have happened and allows (except a staff-confirmed block).

import { hashKey } from "../fraud/hooks.ts";
import { resolveConfig } from "./config.ts";
import { dobYear, nameTokens, normalizeCountry, normalizeDob } from "./normalize.ts";
import { loadProviderFromEnv } from "./providers.ts";
import {
  ProviderError,
  type AccountGateStatus,
  type Checkpoint,
  type GateCode,
  type GateDecision,
  type GateOutcome,
  type ProviderMatch,
  type SanctionsDeps,
  type SanctionsMode,
  type ScreeningSubject,
  type StoredDecision,
} from "./types.ts";

/** One message for hold / block / unavailable. It must not reveal which rule fired [COUNSEL: tipping-off / wording]. */
export const USER_MESSAGE = "We can't complete this step online right now. If we need anything from you, our team will contact you.";
export const SUBJECT_REQUIRED_MESSAGE = "We need your legal name and country to continue.";

export interface ScreeningRequest {
  checkpoint: Checkpoint;
  ownerId: string | null;
  subject: ScreeningSubject | null;
  /** If true, a missing / unusable subject is a failure; if false the check is skipped (best effort). */
  requireSubject: boolean;
  requireCountry?: boolean;
}

const outcome = (o: Partial<GateOutcome> & Pick<GateOutcome, "allowed" | "decision" | "mode">): GateOutcome => ({
  userMessage: o.allowed ? "" : USER_MESSAGE,
  retryable: false,
  shadowWouldDeny: false,
  ...o,
});

function deny(mode: SanctionsMode, decision: GateDecision, code: GateCode, extra: Partial<GateOutcome> = {}): GateOutcome {
  // In shadow mode everything except a staff-confirmed block is allowed but flagged.
  if (mode === "shadow" && code !== "SANCTIONS_BLOCKED") {
    return outcome({ allowed: true, decision, mode, shadowWouldDeny: true, ...extra });
  }
  return outcome({
    allowed: false, decision, mode, code,
    userMessage: code === "SANCTIONS_SUBJECT_REQUIRED" ? SUBJECT_REQUIRED_MESSAGE : USER_MESSAGE,
    retryable: code === "SANCTIONS_UNAVAILABLE" || code === "SANCTIONS_SUBJECT_REQUIRED",
    ...extra,
  });
}

function cleanSubject(s: ScreeningSubject | null, requireCountry: boolean) {
  if (!s || typeof s.name !== "string") return null;
  const name = s.name.trim().slice(0, 200);
  if (nameTokens(name).join("").length < 2) return null;
  const country = normalizeCountry(s.country ?? null);
  if (requireCountry && !country) return null;
  const aliases = (s.aliases ?? []).filter((a) => typeof a === "string").map((a) => a.trim().slice(0, 200)).filter((a) => nameTokens(a).join("").length >= 2).slice(0, 5);
  return { kind: s.kind === "entity" ? ("entity" as const) : ("person" as const), name, aliases, country, dateOfBirth: normalizeDob(s.dateOfBirth ?? null) };
}

export async function runScreening(deps: SanctionsDeps, req: ScreeningRequest): Promise<GateOutcome> {
  // 1. Settings. Any failure => strictest config.
  let row = null;
  try { row = await deps.store.getSettings(); } catch { row = null; }
  const cfg = resolveConfig(row, deps.env);
  const mode = cfg.mode;

  // 2. Subject.
  const subject = cleanSubject(req.subject, req.requireCountry === true);
  if (!subject) {
    return req.requireSubject
      ? deny(mode, "subject_required", "SANCTIONS_SUBJECT_REQUIRED")
      : outcome({ allowed: true, decision: "skipped", mode });
  }

  // 3. Subject hash (order-insensitive name tokens + country + birth year).
  const pepper = deps.hashPepper?.trim();
  const base = { ownerId: req.ownerId, checkpoint: req.checkpoint, mode };
  const snapshot = { kind: subject.kind, name: subject.name, aliases: subject.aliases, country: subject.country, dateOfBirth: subject.dateOfBirth };
  if (!pepper) return deny(mode, "error", "SANCTIONS_UNAVAILABLE");
  const tokens = [...nameTokens(subject.name)].sort().join(" ");
  const subjectHash = await hashKey(pepper, "sanctions-subject", `${tokens}|${subject.country ?? ""}|${dobYear(subject.dateOfBirth) ?? ""}`);

  // 4. Reviewer verdicts short-circuit the provider.
  try {
    const verdict = await deps.store.getOverride(subjectHash);
    if (verdict === "blocked") return deny(mode, "blocked_override", "SANCTIONS_BLOCKED");
    if (verdict === "cleared") return outcome({ allowed: true, decision: "cleared_override", mode });
  } catch {
    return deny(mode, "error", "SANCTIONS_UNAVAILABLE");
  }

  // 5. Decide: jurisdiction list first (no provider needed), otherwise the provider.
  let decision: StoredDecision;
  let matches: ProviderMatch[] = [];
  let providerId: string | null = null;
  let listVersion: string | null = null;
  let reason: string | null = null;

  if (subject.country && cfg.restrictedCountries.has(subject.country)) {
    decision = "review";
    reason = "restricted_jurisdiction";
    matches = [{ listId: "jurisdiction", entryId: subject.country, name: subject.country, score: 1 }];
  } else {
    const loaded = deps.providerOverride ? { provider: deps.providerOverride } : loadProviderFromEnv(deps.env, cfg.providerTimeoutMs, deps.fetchImpl);
    if ("error" in loaded) {
      decision = "error";
      reason = `provider_${loaded.error.code}`;
    } else {
      providerId = loaded.provider.id;
      try {
        const result = await loaded.provider.screen(subject, { requestId: crypto.randomUUID() });
        listVersion = result.listVersion;
        matches = [...result.matches].sort((a, b) => b.score - a.score);
        decision = matches.some((m) => m.score >= cfg.reviewThreshold) ? "review" : "clear";
        if (decision === "review") reason = "list_match";
      } catch (e) {
        decision = "error";
        reason = e instanceof ProviderError ? `provider_${e.code}` : "provider_unexpected";
      }
    }
  }

  // 6. Persist (atomic RPC). If the audit trail cannot be written in enforce mode, do not let the request through.
  const topScore = matches.length ? Math.max(...matches.map((m) => m.score)) : null;
  let screeningId: string | undefined;
  let caseId: string | null | undefined;
  try {
    const saved = await deps.store.record({ ...base, subjectHash, subject: snapshot, decision, provider: providerId, listVersion, topScore, matches: matches.slice(0, 25), reason });
    screeningId = saved.screeningId;
    caseId = saved.caseId;
  } catch {
    return deny(mode, "error", "SANCTIONS_UNAVAILABLE");
  }

  if (decision === "clear") return outcome({ allowed: true, decision: "clear", mode, screeningId, caseId });
  if (decision === "review") return deny(mode, "review", "SANCTIONS_HOLD", { screeningId, caseId });
  return deny(mode, "error", "SANCTIONS_UNAVAILABLE", { screeningId, caseId });
}

/** State-only check (no provider call) for code paths that move money after setup. Unscreened legacy accounts pass. */
export async function checkAccountGate(deps: Pick<SanctionsDeps, "store" | "env">, ownerId: string): Promise<{ allowed: boolean; status: AccountGateStatus; outcome: GateOutcome }> {
  let row = null;
  try { row = await deps.store.getSettings(); } catch { row = null; }
  const mode = resolveConfig(row, deps.env).mode;
  let status: AccountGateStatus = "unscreened";
  try {
    const s = await deps.store.getAccountState(ownerId);
    if (s) status = s.status;
  } catch {
    const o = deny(mode, "error", "SANCTIONS_UNAVAILABLE");
    return { allowed: o.allowed, status, outcome: o };
  }
  if (status === "blocked") { const o = deny(mode, "blocked_override", "SANCTIONS_BLOCKED"); return { allowed: o.allowed, status, outcome: o }; }
  if (status === "held") { const o = deny(mode, "review", "SANCTIONS_HOLD"); return { allowed: o.allowed, status, outcome: o }; }
  return { allowed: true, status, outcome: outcome({ allowed: true, decision: "clear", mode }) };
}
