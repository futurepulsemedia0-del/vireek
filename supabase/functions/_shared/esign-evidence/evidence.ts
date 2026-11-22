// E-signature evidence: canonical hashing, audit-chain verification, certificate building and sealing.
// Pure TypeScript on WebCrypto, so it runs in Deno (Edge Functions) and in Vitest unchanged.
// Server-side counterpart: supabase/migrations/20290308000000_esignature_evidence.sql (the preimage formats below
// are produced there; this file only VERIFIES them and never re-derives them from parsed rows).
// This module makes no legal claim. See docs/ESIGNATURE_EVIDENCE.md ([COUNSEL]).

export const CERTIFICATE_VERSION = "vireek-esign-cert-v1";
export const SEAL_ALGORITHM = "HMAC-SHA256";
export const ZERO_HASH = "0".repeat(64);
const DOC_TAG = "vireek-esign-doc-v1";
const EVT_TAG = "vireek-esign-evt-v1";

// ----------------------------------------------------------------------------- primitives

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** JSON with object keys sorted recursively and no whitespace. Stable across jsonb round trips. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Real client IP as far as the platform headers allow. [VERIFY] the proxy topology of the deployment. */
export function clientIpFromHeaders(get: (name: string) => string | null): string {
  const cf = get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const real = get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

// ----------------------------------------------------------------------------- shapes (from get_signature_evidence)

export interface EvidenceRequest {
  id: string; owner_id: string; business_name: string | null; document_type: string; document_id: string | null; title: string;
  document_summary: string | null; document_url: string | null; consent_text: string; consent_version: string; status: string;
  sent_at: string | null; completed_at: string | null; expires_at: string | null; evidence_version: number | null;
  document_snapshot: string | null; document_sha256: string | null; document_file_sha256: string | null; consent_text_sha256: string | null;
}
export interface EvidenceSigner {
  id: string; name: string; email: string | null; phone: string | null; role: string; signing_order: number; status: string;
  signature_type: string | null; signature_sha256: string; typed_signature: string | null; signed_name: string | null;
  consented_at: string | null; signed_at: string | null; ip_address: string | null; user_agent: string | null;
}
export interface EvidenceConsent {
  signer_id: string; consent_text_sha256: string; consent_version: string; method: string;
  ip_address: string | null; user_agent: string | null; consented_at: string;
}
export interface EvidenceEvent {
  id: string; seq: number | null; event_type: string; signer_id: string | null; ip_address: string | null; user_agent: string | null;
  metadata: Record<string, unknown>; created_at: string; prev_hash: string | null; event_hash: string | null;
  hash_preimage: string | null; chain_version: number | null;
}
export interface Evidence { request: EvidenceRequest; signers: EvidenceSigner[]; consents: EvidenceConsent[]; events: EvidenceEvent[] }

// ----------------------------------------------------------------------------- verification

export interface ChainCheck { ok: boolean; chained: number; legacy: number; head: string | null; problems: string[] }

/** Recomputes every link of the chain from the stored preimages. Legacy (unchained) events must come first. */
export async function verifyChain(events: EvidenceEvent[]): Promise<ChainCheck> {
  const problems: string[] = [];
  let prev = ZERO_HASH;
  let expectedSeq = 1;
  let chained = 0;
  let legacy = 0;
  let seenChained = false;

  for (const e of events) {
    if (e.chain_version === null || e.hash_preimage === null) {
      if (seenChained) problems.push(`legacy_event_after_chain:${e.id}`);
      legacy++;
      continue;
    }
    seenChained = true;
    chained++;
    if (e.seq !== expectedSeq) problems.push(`seq_gap:${e.id}`);
    if (e.prev_hash !== prev) problems.push(`prev_hash_mismatch:${e.id}`);
    if (e.event_hash === null || !safeEqual(await sha256Hex(e.hash_preimage), e.event_hash)) problems.push(`hash_mismatch:${e.id}`);

    let parsed: unknown[] = [];
    try { parsed = JSON.parse(e.hash_preimage) as unknown[]; } catch { problems.push(`preimage_unparseable:${e.id}`); }
    if (Array.isArray(parsed) && parsed.length === 11) {
      const [tag, id, , seq, type, signer, ip, ua, meta, ts, pre] = parsed;
      const same = tag === EVT_TAG && id === e.id && seq === e.seq && type === e.event_type && signer === e.signer_id
        && ip === e.ip_address && ua === e.user_agent && ts === e.created_at && pre === e.prev_hash
        && canonicalJson(meta) === canonicalJson(e.metadata);
      if (!same) problems.push(`fields_differ_from_preimage:${e.id}`);
    } else if (Array.isArray(parsed)) {
      problems.push(`preimage_shape:${e.id}`);
    }
    prev = e.event_hash ?? prev;
    expectedSeq = (e.seq ?? expectedSeq) + 1;
  }
  return { ok: problems.length === 0, chained, legacy, head: chained > 0 ? prev : null, problems };
}

export interface DocumentCheck { ok: boolean; sealed: boolean; problems: string[] }

/** Checks the stored document snapshot and consent text against their hashes and against the request fields. */
export async function verifyDocument(r: EvidenceRequest): Promise<DocumentCheck> {
  if (r.evidence_version === null || r.document_snapshot === null) return { ok: true, sealed: false, problems: [] };
  const problems: string[] = [];
  if (r.document_sha256 === null || !safeEqual(await sha256Hex(r.document_snapshot), r.document_sha256)) problems.push("document_hash_mismatch");
  if (r.consent_text_sha256 === null || !safeEqual(await sha256Hex(r.consent_text), r.consent_text_sha256)) problems.push("consent_hash_mismatch");
  try {
    const s = JSON.parse(r.document_snapshot) as unknown[];
    const same = Array.isArray(s) && s.length === 11 && s[0] === DOC_TAG && s[1] === r.id && s[2] === r.owner_id && s[3] === r.document_type
      && s[4] === r.document_id && s[5] === r.title && s[6] === r.document_summary && s[7] === r.document_url
      && s[8] === r.document_file_sha256 && s[9] === r.consent_text && s[10] === r.consent_version;
    if (!same) problems.push("snapshot_differs_from_request");
  } catch { problems.push("snapshot_unparseable"); }
  return { ok: problems.length === 0, sealed: true, problems };
}

export interface SignerCheck { signer_id: string; ok: boolean; consent_method: string | null; problems: string[] }

/** For each signed signer: a consent record for the same text, and a chained 'signed' event bound to this document. */
export function checkSigners(ev: Evidence): SignerCheck[] {
  return ev.signers.filter((s) => s.status === "signed").map((s) => {
    const problems: string[] = [];
    const consent = ev.consents.find((c) => c.signer_id === s.id) ?? null;
    if (ev.request.evidence_version !== null) {
      if (!consent) problems.push("no_consent_record");
      else if (consent.consent_text_sha256 !== ev.request.consent_text_sha256) problems.push("consent_text_differs");
      const signed = ev.events.find((e) => e.event_type === "signed" && e.signer_id === s.id);
      if (!signed) problems.push("no_signed_event");
      else {
        if (signed.metadata.document_sha256 !== ev.request.document_sha256) problems.push("signed_event_document_hash_differs");
        if (signed.metadata.signature_sha256 !== s.signature_sha256) problems.push("signed_event_signature_hash_differs");
      }
    }
    return { signer_id: s.id, ok: problems.length === 0, consent_method: consent?.method ?? null, problems };
  });
}

// ----------------------------------------------------------------------------- certificate

export type EvidenceLevel = "chained" | "partial" | "legacy";

export interface Certificate {
  certificate_version: string;
  issued_at: string;
  evidence_level: EvidenceLevel;
  request: EvidenceRequest;
  signers: EvidenceSigner[];
  consents: EvidenceConsent[];
  events: EvidenceEvent[];
  integrity: {
    document: DocumentCheck; chain: ChainCheck; signers: SignerCheck[]; all_ok: boolean;
  };
  limitations: string[];
}

export const LIMITATIONS = [
  "Signer identity is not independently verified. Each signer was identified only by access to a unique link sent to the e-mail address or phone number the sender entered.",
  "IP address and user agent are what the receiving server reported for each request. They are not proof of a person's location or device.",
  "The document fingerprint covers the title, summary, link, optional sender-supplied file hash and consent text recorded when the request was sent. It does not cover the bytes behind the document link unless a file hash was supplied.",
  "Legal effect, enforceability and admissibility of this record have not been assessed.",
];

export function evidenceLevel(chain: ChainCheck, doc: DocumentCheck): EvidenceLevel {
  if (!doc.sealed || chain.chained === 0) return "legacy";
  return chain.legacy > 0 ? "partial" : "chained";
}

export async function buildCertificate(ev: Evidence, issuedAt: string): Promise<Certificate> {
  const document = await verifyDocument(ev.request);
  const chain = await verifyChain(ev.events);
  const signers = checkSigners(ev);
  return {
    certificate_version: CERTIFICATE_VERSION,
    issued_at: issuedAt,
    evidence_level: evidenceLevel(chain, document),
    request: ev.request,
    signers: ev.signers,
    consents: ev.consents,
    events: ev.events,
    integrity: { document, chain, signers, all_ok: document.ok && chain.ok && signers.every((s) => s.ok) },
    limitations: LIMITATIONS,
  };
}

// ----------------------------------------------------------------------------- seal

export interface SealedCertificate {
  certificate: Certificate;
  certificate_sha256: string;
  seal: { algorithm: string; key_id: string; hmac: string };
}

const sealMessage = (keyId: string, sha: string) => `vireek-esign-seal-v1|${keyId}|${sha}`;

export function validateSealKey(key: string | undefined | null): key is string {
  return typeof key === "string" && key.length >= 32;
}

export async function sealCertificate(cert: Certificate, key: string, keyId: string): Promise<SealedCertificate> {
  if (!validateSealKey(key)) throw new Error("Seal key must be at least 32 characters.");
  const sha = await sha256Hex(canonicalJson(cert));
  return { certificate: cert, certificate_sha256: sha, seal: { algorithm: SEAL_ALGORITHM, key_id: keyId, hmac: await hmacSha256Hex(key, sealMessage(keyId, sha)) } };
}

export interface VerifyResult { valid: boolean; seal_ok: boolean; document_ok: boolean; chain_ok: boolean; signers_ok: boolean; reasons: string[] }

/** Full offline check of a sealed certificate. Needs the seal key, so only the issuer can run it. */
export async function verifySealed(env: SealedCertificate, key: string): Promise<VerifyResult> {
  const reasons: string[] = [];
  let sealOk = false;
  if (env?.seal?.algorithm !== SEAL_ALGORITHM || typeof env.certificate_sha256 !== "string" || typeof env.seal?.hmac !== "string") {
    reasons.push("malformed_envelope");
  } else {
    const sha = await sha256Hex(canonicalJson(env.certificate));
    if (!safeEqual(sha, env.certificate_sha256)) reasons.push("certificate_hash_mismatch");
    const mac = await hmacSha256Hex(key, sealMessage(env.seal.key_id, env.certificate_sha256));
    sealOk = safeEqual(mac, env.seal.hmac) && reasons.length === 0;
    if (!safeEqual(mac, env.seal.hmac)) reasons.push("seal_mismatch");
  }
  let documentOk = false, chainOk = false, signersOk = false;
  if (env?.certificate?.request && Array.isArray(env.certificate.events)) {
    const c = env.certificate;
    const doc = await verifyDocument(c.request);
    const chain = await verifyChain(c.events);
    const signers = checkSigners({ request: c.request, signers: c.signers, consents: c.consents, events: c.events });
    documentOk = doc.ok; chainOk = chain.ok; signersOk = signers.every((s) => s.ok);
    reasons.push(...doc.problems, ...chain.problems, ...signers.flatMap((s) => s.problems.map((p) => `${p}:${s.signer_id}`)));
  }
  return { valid: sealOk && documentOk && chainOk && signersOk, seal_ok: sealOk, document_ok: documentOk, chain_ok: chainOk, signers_ok: signersOk, reasons };
}
