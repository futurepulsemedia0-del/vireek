// supabase/functions/_shared/vertical-ai/outcomeEvents.ts
//
// Write points + contracts for the Outcome Learning layer. This module builds and validates events and writes them
// through the service-role RPCs record_vertical_prediction / record_vertical_confirmation (see the 20281120000000
// migration). It does NOT learn anything: it only guarantees clean, idempotent, tenant-scoped data.
//
//   diagnosis: predicted { cause_keys, symptom_key }          confirmed { cause_key }
//   price:     predicted { quoted_cents }                      confirmed { final_cents }
//   parts:     predicted { parts }                             confirmed { parts }
//
// Telemetry/learning writes must never break a call or a job flow: every writer swallows errors and returns a
// result object instead of throwing.

export type OutcomeKind = "diagnosis" | "price" | "parts";
export type SubjectType = "job" | "call" | "quote" | "diagnosis_session";

export interface AdminRpc { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }

const KEY_RE = /^[a-z0-9_]{1,60}$/;
const isKey = (v: unknown): v is string => typeof v === "string" && KEY_RE.test(v);
const isCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000_000;
const partName = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 80;

export function validatePredicted(kind: OutcomeKind, p: Record<string, unknown>): string | null {
  if (kind === "diagnosis") {
    if (!Array.isArray(p.cause_keys) || p.cause_keys.length === 0 || p.cause_keys.length > 10 || !p.cause_keys.every(isKey)) return "cause_keys must be 1..10 snake_case keys";
    if (p.symptom_key !== undefined && !isKey(p.symptom_key)) return "symptom_key must be a snake_case key";
    return null;
  }
  if (kind === "price") return isCents(p.quoted_cents) ? null : "quoted_cents must be a non-negative integer";
  return Array.isArray(p.parts) && p.parts.length <= 40 && p.parts.every(partName) ? null : "parts must be <=40 non-empty strings";
}

export function validateConfirmed(kind: OutcomeKind, c: Record<string, unknown>): string | null {
  if (kind === "diagnosis") return isKey(c.cause_key) ? null : "cause_key must be a snake_case key";
  if (kind === "price") return isCents(c.final_cents) ? null : "final_cents must be a non-negative integer";
  return Array.isArray(c.parts) && c.parts.length <= 40 && c.parts.every(partName) ? null : "parts must be <=40 non-empty strings";
}

export interface WriteResult { ok: boolean; reason?: string; id?: string | null; confirmedNow?: boolean }

export async function recordPrediction(
  admin: AdminRpc,
  a: { userId: string; kind: OutcomeKind; subjectType: SubjectType; subjectId: string; predicted: Record<string, unknown>; evidenceIds?: string[] },
): Promise<WriteResult> {
  const bad = validatePredicted(a.kind, a.predicted);
  if (bad) return { ok: false, reason: bad };
  if (!a.userId || !a.subjectId || a.subjectId.length > 128) return { ok: false, reason: "invalid subject" };
  try {
    const { data, error } = await admin.rpc("record_vertical_prediction", {
      p_user_id: a.userId, p_kind: a.kind, p_subject_type: a.subjectType, p_subject_id: a.subjectId,
      p_predicted: a.predicted, p_evidence_ids: (a.evidenceIds ?? []).slice(0, 32),
    });
    if (error) return { ok: false, reason: error.message };
    return { ok: true, id: (data as string | null) ?? null };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "rpc_failed" };
  }
}

export async function recordConfirmation(
  admin: AdminRpc,
  a: { userId: string; kind: OutcomeKind; subjectType: SubjectType; subjectId: string; confirmed: Record<string, unknown> },
): Promise<WriteResult> {
  const bad = validateConfirmed(a.kind, a.confirmed);
  if (bad) return { ok: false, reason: bad };
  try {
    const { data, error } = await admin.rpc("record_vertical_confirmation", {
      p_user_id: a.userId, p_kind: a.kind, p_subject_type: a.subjectType, p_subject_id: a.subjectId, p_confirmed: a.confirmed,
    });
    if (error) return { ok: false, reason: error.message };
    return { ok: true, confirmedNow: data === true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "rpc_failed" };
  }
}
