// supabase/functions/_shared/governance/commitThresholds.ts
//
// AI commit controls: configurable thresholds above which the AI assistant may NOT commit a price or a
// visit time on its own. Above a threshold the commitment is held for a human (the existing Agent
// Governance approval queue), the customer is told plainly that an automated assistant cannot confirm it,
// and the evaluation — including the policy that applied — is written to the existing audit trail.
//
// Why a separate module: agentGovernance.ts gates *actions* (send an SMS, make a call, spend money). It has
// no concept of "this quoted amount is too large for the AI to state" or "this time is too far away". This
// file adds exactly that and nothing else; storage, audit and approval reuse agent_action_log.
//
// Two layers on purpose:
//   evaluateCommit()  PURE. Policy + proposal + clock in, verdict out. Unit-tested without a database.
//   gateAiCommit()    Loads the policy, calls evaluateCommit(), writes the audit row, and turns the verdict
//                     into a go / hold decision plus the exact words the assistant may say.
//
// Fail-closed rules (enforce mode): an amount or time that cannot be verified is treated as a breach, a
// failure to write the hold record still blocks the commitment, and a policy read error (other than "table
// not there yet") is treated as enforce-with-defaults. Shadow mode never blocks; it records what would have.
//
// Keep DEFAULT_POLICY equal to the column defaults in supabase/migrations/20290311000000_ai_commit_controls.sql
// (commitThresholds.test.mjs fails if they drift).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export type CommitMode = "off" | "shadow" | "enforce";
export type CommitKind = "price" | "schedule";

export interface CommitPolicy {
  mode: CommitMode;
  /** Above this many minor units (cents) the AI may not state a price. */
  priceThresholdCents: number;
  /** 0 = rule off. A visit sooner than this many minutes from now needs a human. */
  scheduleMinNoticeMinutes: number;
  /** A visit further out than this many days needs a human. */
  scheduleMaxDaysAhead: number;
  /** A visit expected to take longer than this many minutes needs a human. */
  scheduleMaxDurationMinutes: number;
  /** Tenant wording for the customer; null = DEFAULT_DISCLOSURE. */
  disclosureText: string | null;
}

/** Values here are product defaults to be confirmed by the owner [VERIFY]; they equal the SQL column defaults. */
export const DEFAULT_POLICY: Readonly<CommitPolicy> = Object.freeze({
  mode: "shadow",
  priceThresholdCents: 100000,
  scheduleMinNoticeMinutes: 0,
  scheduleMaxDaysAhead: 60,
  scheduleMaxDurationMinutes: 480,
  disclosureText: null,
});

/** Customer-facing wording. The text itself is a legal statement and needs counsel review [COUNSEL]. */
export const DEFAULT_DISCLOSURE =
  "You are speaking with an automated AI assistant. It is not able to confirm this on its own, so a member of the team will review it and confirm it with you.";

export interface PriceProposal { kind: "price"; amountCents: number }
export interface ScheduleProposal {
  kind: "schedule";
  /** The visit start the assistant is about to promise. */
  startsAt: string | number | Date | null | undefined;
  /** Expected duration if the capacity engine supplied one; unknown (null/undefined) is not a breach. */
  durationMinutes?: number | null;
}
export type CommitProposal = PriceProposal | ScheduleProposal;

export type BreachRule =
  | "price_above_threshold"
  | "unverifiable_amount"
  | "notice_too_short"
  | "too_far_ahead"
  | "duration_too_long"
  | "unverifiable_time";

export interface Breach { rule: BreachRule; limit: number | null; actual: number | null }

export interface CommitEvaluation {
  kind: CommitKind;
  breaches: Breach[];
  requiresApproval: boolean;
}

/** PURE. No I/O, no clock besides `now`. */
export function evaluateCommit(policy: CommitPolicy, proposal: CommitProposal, now: Date): CommitEvaluation {
  const breaches: Breach[] = [];

  if (proposal.kind === "price") {
    const a = proposal.amountCents;
    if (typeof a !== "number" || !Number.isFinite(a) || a < 0) {
      breaches.push({ rule: "unverifiable_amount", limit: policy.priceThresholdCents, actual: null });
    } else if (a > policy.priceThresholdCents) {
      breaches.push({ rule: "price_above_threshold", limit: policy.priceThresholdCents, actual: a });
    }
  } else {
    const ms = proposal.startsAt instanceof Date ? proposal.startsAt.getTime()
      : typeof proposal.startsAt === "number" ? proposal.startsAt
      : typeof proposal.startsAt === "string" ? Date.parse(proposal.startsAt)
      : NaN;
    if (!Number.isFinite(ms)) {
      breaches.push({ rule: "unverifiable_time", limit: null, actual: null });
    } else {
      const minutesAhead = (ms - now.getTime()) / 60000;
      if (policy.scheduleMinNoticeMinutes > 0 && minutesAhead < policy.scheduleMinNoticeMinutes) {
        breaches.push({ rule: "notice_too_short", limit: policy.scheduleMinNoticeMinutes, actual: Math.round(minutesAhead) });
      }
      if (minutesAhead / 1440 > policy.scheduleMaxDaysAhead) {
        breaches.push({ rule: "too_far_ahead", limit: policy.scheduleMaxDaysAhead, actual: Math.round((minutesAhead / 1440) * 10) / 10 });
      }
      const d = proposal.durationMinutes;
      if (typeof d === "number" && Number.isFinite(d) && d > policy.scheduleMaxDurationMinutes) {
        breaches.push({ rule: "duration_too_long", limit: policy.scheduleMaxDurationMinutes, actual: d });
      }
    }
  }
  return { kind: proposal.kind, breaches, requiresApproval: breaches.length > 0 };
}

// ---------------------------------------------------------------------------------------------------------
// Policy loading
// ---------------------------------------------------------------------------------------------------------

export interface LoadedPolicy {
  policy: CommitPolicy;
  /** "stored" = tenant row; "default" = no row (or table not deployed yet); "load_failed" = fail-closed fallback. */
  source: "stored" | "default" | "load_failed";
}

const MODES: readonly string[] = ["off", "shadow", "enforce"];
const TABLE_MISSING_CODES = new Set(["42P01", "PGRST205"]);

function num(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function policyFromRow(row: Record<string, unknown>): CommitPolicy | null {
  const price = num(row.price_threshold_cents);
  const minNotice = num(row.schedule_min_notice_minutes);
  const maxDays = num(row.schedule_max_days_ahead);
  const maxDur = num(row.schedule_max_duration_minutes);
  if (typeof row.mode !== "string" || !MODES.includes(row.mode)) return null;
  if (price === null || minNotice === null || maxDays === null || maxDur === null) return null;
  if (price < 0 || minNotice < 0 || maxDays < 0 || maxDur <= 0) return null;
  const text = typeof row.disclosure_text === "string" && row.disclosure_text.trim() ? row.disclosure_text.trim().slice(0, 500) : null;
  return {
    mode: row.mode as CommitMode,
    priceThresholdCents: price,
    scheduleMinNoticeMinutes: minNotice,
    scheduleMaxDaysAhead: maxDays,
    scheduleMaxDurationMinutes: maxDur,
    disclosureText: text,
  };
}

export async function loadCommitPolicy(admin: SupabaseClient, userId: string): Promise<LoadedPolicy> {
  const failClosed: LoadedPolicy = { policy: { ...DEFAULT_POLICY, mode: "enforce" }, source: "load_failed" };
  try {
    const { data, error } = await admin
      .from("ai_commit_policies")
      .select("mode, price_threshold_cents, schedule_min_notice_minutes, schedule_max_days_ahead, schedule_max_duration_minutes, disclosure_text")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      // Function deployed before the migration: behave as today (shadow defaults) instead of blocking every call.
      if (TABLE_MISSING_CODES.has(String((error as { code?: string }).code ?? ""))) return { policy: { ...DEFAULT_POLICY }, source: "default" };
      console.error(JSON.stringify({ event: "ai_commit_policy_load_failed", user_id: userId, error: error.message }));
      return failClosed;
    }
    if (!data) return { policy: { ...DEFAULT_POLICY }, source: "default" };
    const policy = policyFromRow(data as Record<string, unknown>);
    if (!policy) {
      console.error(JSON.stringify({ event: "ai_commit_policy_invalid", user_id: userId }));
      return failClosed;
    }
    return { policy, source: "stored" };
  } catch (e) {
    console.error(JSON.stringify({ event: "ai_commit_policy_load_threw", user_id: userId, error: e instanceof Error ? e.message : String(e) }));
    return failClosed;
  }
}

// ---------------------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------------------

export interface GateAiCommitParams {
  userId: string;
  agentSource: string;
  proposal: CommitProposal;
  /** Stable per tool call (e.g. `${vapiCallId}:${toolCallId}`) so a retried call never makes a second approval row. */
  correlationId: string;
  /** One plain-language line for the human reviewer. */
  reasoning?: string;
  /** What the reviewer needs to act (service, address, requested time, customer name…). Truncated; tenant-scoped. */
  context?: Record<string, unknown>;
  now?: Date;
}

export interface GateAiCommitResult {
  /** true = the assistant may go ahead and commit. false = it must NOT. */
  allow: boolean;
  mode: CommitMode;
  evaluation: CommitEvaluation;
  /** true when enforce mode held it, or when shadow mode saw a breach it did not hold. */
  breachedPolicy: boolean;
  logId: string | null;
  policySource: LoadedPolicy["source"];
  /** The exact customer-facing disclosure that applies to this tenant. */
  disclosure: string;
  /** Instruction for the assistant when allow is false; null when it may proceed. */
  assistantInstruction: string | null;
}

export interface GateDeps {
  loadPolicy?: (admin: SupabaseClient, userId: string) => Promise<LoadedPolicy>;
  record?: (admin: SupabaseClient, args: RecordArgs) => Promise<{ logId: string | null; ok: boolean }>;
}

export interface RecordArgs {
  userId: string;
  kind: CommitKind;
  agentSource: string;
  decision: "auto_approved" | "pending_approval";
  correlationId: string;
  reasoning: string;
  payload: Record<string, unknown>;
}

function clip(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.slice(0, 300);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (depth > 2 || v === undefined || typeof v !== "object") return undefined;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clip(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 30)) {
    const c = clip(x, depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

export async function recordCommitDecision(admin: SupabaseClient, a: RecordArgs): Promise<{ logId: string | null; ok: boolean }> {
  try {
    const { data, error } = await admin.rpc("record_ai_commit_decision", {
      p_user_id: a.userId,
      p_kind: a.kind,
      p_agent_source: a.agentSource,
      p_decision: a.decision,
      p_correlation_id: a.correlationId,
      p_reasoning: a.reasoning,
      p_payload: a.payload,
    });
    if (error) {
      console.error(JSON.stringify({ event: "ai_commit_record_failed", user_id: a.userId, kind: a.kind, error: error.message }));
      return { logId: null, ok: false };
    }
    const row = data as { log_id?: string } | null;
    return { logId: row?.log_id ?? null, ok: true };
  } catch (e) {
    console.error(JSON.stringify({ event: "ai_commit_record_threw", user_id: a.userId, kind: a.kind, error: e instanceof Error ? e.message : String(e) }));
    return { logId: null, ok: false };
  }
}

export function heldInstruction(kind: CommitKind, disclosure: string): string {
  const what = kind === "price" ? "a price" : "an appointment time";
  const never = kind === "price"
    ? "Do NOT state, hint at, round or estimate any dollar amount for this."
    : "Do NOT say the appointment is booked, confirmed or reserved, and do not promise any arrival time.";
  return [
    `You cannot commit ${what} to this caller yourself.`,
    never,
    `Tell the caller, in your own natural words and in their language, the substance of this: "${disclosure}"`,
    "Offer to take their name, number and what they need so the team can come back to them. Never mention limits, thresholds or approval rules.",
  ].join(" ");
}

export async function gateAiCommit(admin: SupabaseClient, p: GateAiCommitParams, deps: GateDeps = {}): Promise<GateAiCommitResult> {
  const now = p.now ?? new Date();
  const loaded = await (deps.loadPolicy ?? loadCommitPolicy)(admin, p.userId);
  const { policy } = loaded;
  const disclosure = policy.disclosureText ?? DEFAULT_DISCLOSURE;
  const evaluation = evaluateCommit(policy, p.proposal, now);
  const base = { mode: policy.mode, evaluation, policySource: loaded.source, disclosure };

  if (policy.mode === "off") {
    return { ...base, allow: true, breachedPolicy: evaluation.requiresApproval, logId: null, assistantInstruction: null };
  }

  const hold = policy.mode === "enforce" && evaluation.requiresApproval;
  const proposalPayload = p.proposal.kind === "price"
    ? { amount_cents: p.proposal.amountCents }
    : { starts_at: p.proposal.startsAt instanceof Date ? p.proposal.startsAt.toISOString() : p.proposal.startsAt ?? null, duration_minutes: p.proposal.durationMinutes ?? null };
  const payload = {
    proposal: proposalPayload,
    breaches: evaluation.breaches,
    policy_applied: { ...policy, source: loaded.source },
    shadow_would_hold: policy.mode === "shadow" && evaluation.requiresApproval,
    disclosure_text: disclosure,
    context: clip(p.context ?? {}),
    evaluated_at: now.toISOString(),
  };
  const rec = await (deps.record ?? recordCommitDecision)(admin, {
    userId: p.userId,
    kind: p.proposal.kind,
    agentSource: p.agentSource,
    decision: hold ? "pending_approval" : "auto_approved",
    correlationId: p.correlationId,
    reasoning: (p.reasoning ?? `AI assistant proposed to commit a ${p.proposal.kind}.`).slice(0, 500),
    payload,
  });

  // Fail closed: when a hold is required, a failure to record it still blocks the commitment.
  if (hold) {
    return { ...base, allow: false, breachedPolicy: true, logId: rec.logId, assistantInstruction: heldInstruction(p.proposal.kind, disclosure) };
  }
  return { ...base, allow: true, breachedPolicy: evaluation.requiresApproval, logId: rec.logId, assistantInstruction: null };
}

// ---------------------------------------------------------------------------------------------------------
// Thin adapters for the two voice commit points
// ---------------------------------------------------------------------------------------------------------

/** For lookup_price: returns the instruction to use INSTEAD of the quote when held, or null to let the quote through. */
export async function holdPriceQuoteIfNeeded(
  admin: SupabaseClient,
  p: { userId: string; amountCents: number; correlationId: string; context?: Record<string, unknown> },
  deps?: GateDeps,
): Promise<string | null> {
  const r = await gateAiCommit(admin, {
    userId: p.userId,
    agentSource: "vapi-webhook:lookup_price",
    proposal: { kind: "price", amountCents: p.amountCents },
    correlationId: p.correlationId,
    reasoning: "The AI assistant was about to quote a price to a caller.",
    context: p.context,
  }, deps);
  return r.allow ? null : r.assistantInstruction;
}

/** For book_appointment: returns the instruction to use INSTEAD of booking when held, or null to book as normal. */
export async function holdBookingIfNeeded(
  admin: SupabaseClient,
  p: { userId: string; startsAt: string | null; durationMinutes?: number | null; correlationId: string; context?: Record<string, unknown> },
  deps?: GateDeps,
): Promise<string | null> {
  if (!p.startsAt) return null; // no time promised, nothing to hold
  const r = await gateAiCommit(admin, {
    userId: p.userId,
    agentSource: "vapi-webhook:book_appointment",
    proposal: { kind: "schedule", startsAt: p.startsAt, durationMinutes: p.durationMinutes ?? null },
    correlationId: p.correlationId,
    reasoning: "The AI assistant was about to book a visit time for a caller.",
    context: p.context,
  }, deps);
  return r.allow ? null : r.assistantInstruction;
}
