// supabase/functions/_shared/compliance/erasureCertificateIssuer.ts
//
// Issues erasure certificates for completed full-account deletion requests. Service-role only (the table
// has no client write policy). Idempotent: one certificate per deletion request (unique constraint), so a
// retry, a double sweep or a crash between "completed" and "issued" can never produce a second certificate.
//
// Failure policy: a certificate failure NEVER reverts the erasure. The erasure already happened; the
// certificate is evidence about it. Missing certificates are picked up by issueMissingCertificates() on
// the next sweep, from the evidence persisted on the deletion request.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  buildCertificatePayload,
  signCertificatePayload,
  type ErasureBaseline,
  type ErasureEvidence,
} from "./erasureCertificate.ts";

export interface IssuerOptions {
  baseline: ErasureBaseline;
  signingKey: { id: string; secret: string } | null;
  backupRetentionDays: number | null;
  now: Date;
}

export interface DeletionRequestRow {
  id: string;
  user_id: string;
  request_type: string;
  status: string;
  scheduled_for: string;
  created_at: string;
  completed_at: string | null;
}

export type IssueOutcome =
  | { status: "issued"; certificateNumber: string }
  | { status: "exists" }
  | { status: "skipped"; reason: "not_eligible" | "no_evidence" | "not_configured" }
  | { status: "error"; reason: string };

/** Persists what the job did, so a certificate missed by a crash or missing key can still be issued later. */
export async function recordErasureEvidence(
  admin: SupabaseClient,
  request: { id: string; user_id: string },
  evidence: ErasureEvidence,
): Promise<string | null> {
  const { error } = await admin
    .from("erasure_job_evidence")
    .upsert({ deletion_request_id: request.id, account_id: request.user_id, evidence }, { onConflict: "deletion_request_id" });
  return error ? error.message : null;
}

export async function issueErasureCertificate(
  admin: SupabaseClient,
  request: DeletionRequestRow,
  evidence: ErasureEvidence | null,
  opts: IssuerOptions,
): Promise<IssueOutcome> {
  if (request.request_type !== "full_account" || request.status !== "completed" || !request.completed_at) {
    return { status: "skipped", reason: "not_eligible" };
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return { status: "skipped", reason: "no_evidence" };
  if (!opts.signingKey) return { status: "skipped", reason: "not_configured" };

  try {
    const payload = await buildCertificatePayload({
      deletionRequestId: request.id,
      accountId: request.user_id,
      requestedAt: request.created_at,
      scheduledFor: request.scheduled_for,
      completedAt: request.completed_at,
      evidence,
      baseline: opts.baseline,
      backupRetentionDays: opts.backupRetentionDays,
      now: opts.now,
    });
    const signed = await signCertificatePayload(payload, opts.signingKey);

    const { error } = await admin.from("erasure_certificates").insert({
      deletion_request_id: request.id,
      account_id: request.user_id,
      certificate_number: payload.certificateNumber,
      document_json: signed.documentJson,
      sha256: signed.sha256,
      signature: signed.signature,
      key_id: opts.signingKey.id,
      status: payload.status,
      backup_expires_at: payload.backup.expiresAt,
      issued_at: payload.issuedAt,
    });
    if (error) {
      if ((error as { code?: string }).code === "23505") return { status: "exists" };
      return { status: "error", reason: error.message };
    }
    return { status: "issued", certificateNumber: payload.certificateNumber };
  } catch (e) {
    return { status: "error", reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface BackfillSummary {
  issued: number;
  exists: number;
  skipped: number;
  errors: string[];
}

const BACKFILL_LIMIT = 50;

/** Finds recent evidence rows that have no certificate yet, and issues them (completed full-account requests only). */
export async function issueMissingCertificates(admin: SupabaseClient, opts: IssuerOptions): Promise<BackfillSummary> {
  const out: BackfillSummary = { issued: 0, exists: 0, skipped: 0, errors: [] };
  if (!opts.signingKey) return out;

  const { data: ev, error: evErr } = await admin
    .from("erasure_job_evidence")
    .select("deletion_request_id, evidence")
    .order("created_at", { ascending: false })
    .limit(BACKFILL_LIMIT);
  if (evErr) {
    out.errors.push(`load evidence: ${evErr.message}`);
    return out;
  }
  const evidenceRows = (ev ?? []) as { deletion_request_id: string; evidence: ErasureEvidence }[];
  if (!evidenceRows.length) return out;
  const ids = evidenceRows.map((r) => r.deletion_request_id);

  const { data: have, error: haveErr } = await admin.from("erasure_certificates").select("deletion_request_id").in("deletion_request_id", ids);
  if (haveErr) {
    out.errors.push(`load certificates: ${haveErr.message}`);
    return out;
  }
  const issuedFor = new Set((have ?? []).map((r: { deletion_request_id: string }) => r.deletion_request_id));
  const missing = evidenceRows.filter((r) => !issuedFor.has(r.deletion_request_id));
  if (!missing.length) return out;

  const { data: reqs, error: reqErr } = await admin
    .from("deletion_requests")
    .select("id, user_id, request_type, status, scheduled_for, created_at, completed_at")
    .in("id", missing.map((r) => r.deletion_request_id))
    .eq("request_type", "full_account")
    .eq("status", "completed");
  if (reqErr) {
    out.errors.push(`load completed requests: ${reqErr.message}`);
    return out;
  }
  const byId = new Map(((reqs ?? []) as DeletionRequestRow[]).map((r) => [r.id, r]));

  for (const m of missing) {
    const request = byId.get(m.deletion_request_id);
    if (!request) {
      out.skipped++;
      continue;
    }
    const res = await issueErasureCertificate(admin, request, m.evidence, opts);
    if (res.status === "issued") out.issued++;
    else if (res.status === "exists") out.exists++;
    else if (res.status === "skipped") out.skipped++;
    else out.errors.push(`certificate ${request.id}: ${res.reason}`);
  }
  return out;
}
