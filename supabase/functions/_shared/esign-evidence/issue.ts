// Issues (once) and loads the sealed evidence certificate for a completed signature request.
// The certificate row is write-once (trigger). Sealing needs ESIGN_EVIDENCE_HMAC_KEY; without it nothing is issued
// and no unsealed certificate is ever presented as sealed.
import { buildCertificate, canonicalJson, sealCertificate, sha256Hex, type Evidence, type SealedCertificate } from "./evidence.ts";

export type IssueErrorCode = "not_found" | "not_completed" | "integrity_failed" | "seal_not_configured" | "stored_certificate_corrupt" | "db_error";
export class IssueError extends Error {
  constructor(readonly code: IssueErrorCode, message?: string) { super(message ?? code); this.name = "IssueError"; }
}

// deno-lint-ignore no-explicit-any
type Admin = any;

export async function loadStored(admin: Admin, requestId: string): Promise<SealedCertificate | null> {
  const { data, error } = await admin.from("signature_certificates").select("certificate_json, certificate_sha256, seal_hmac, seal_key_id").eq("request_id", requestId).maybeSingle();
  if (error) throw new IssueError("db_error", error.message);
  if (!data) return null;
  // Tamper check on read: the stored JSON must still hash to the stored fingerprint.
  if ((await sha256Hex(canonicalJson(data.certificate_json))) !== data.certificate_sha256) throw new IssueError("stored_certificate_corrupt");
  return { certificate: data.certificate_json, certificate_sha256: data.certificate_sha256, seal: { algorithm: "HMAC-SHA256", key_id: data.seal_key_id, hmac: data.seal_hmac } };
}

export async function issueCertificate(admin: Admin, requestId: string, sealKey: string | undefined, keyId: string): Promise<SealedCertificate> {
  const existing = await loadStored(admin, requestId);
  if (existing) return existing;

  if (!sealKey || sealKey.length < 32) throw new IssueError("seal_not_configured");

  const { data, error } = await admin.rpc("get_signature_evidence", { p_request_id: requestId });
  if (error) throw new IssueError("db_error", error.message);
  if (!data) throw new IssueError("not_found");
  const evidence = data as Evidence;
  if (evidence.request.status !== "completed") throw new IssueError("not_completed");

  const cert = await buildCertificate(evidence, new Date().toISOString());
  // Never seal a record whose own hashes do not check out.
  if (!cert.integrity.all_ok) throw new IssueError("integrity_failed", [...cert.integrity.document.problems, ...cert.integrity.chain.problems].join(","));

  const sealed = await sealCertificate(cert, sealKey, keyId);
  const { error: insErr } = await admin.from("signature_certificates").insert({
    request_id: requestId,
    certificate_json: sealed.certificate,
    certificate_sha256: sealed.certificate_sha256,
    seal_hmac: sealed.seal.hmac,
    seal_key_id: keyId,
    chain_head_hash: cert.integrity.chain.head,
    event_count: cert.events.length,
    issued_at: cert.issued_at,
  });
  if (insErr) {
    if (insErr.code === "23505") { // another request issued it first
      const again = await loadStored(admin, requestId);
      if (again) return again;
    }
    throw new IssueError("db_error", insErr.message);
  }
  // Return what the database now holds (jsonb may normalise formatting; the fingerprint is over canonical JSON).
  return (await loadStored(admin, requestId)) ?? sealed;
}
