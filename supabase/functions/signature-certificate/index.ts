// signature-certificate — delivers the sealed evidence certificate (JSON or PDF) for a COMPLETED signature request.
//   action "get"           authenticated account owner (Authorization: Bearer <user JWT>)
//   action "get_by_token"  a signer of that request (signer_token), no login
//   action "verify"        anyone holding a certificate: checks seal + chain + stored copy; returns booleans only
// Deploy: supabase functions deploy signature-certificate --no-verify-jwt   (the function authenticates "get" itself)
// Secrets: ESIGN_EVIDENCE_HMAC_KEY (>= 32 chars, never in the database), ESIGN_EVIDENCE_KEY_ID (optional, default "k1").
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { IssueError, issueCertificate, loadStored, type IssueErrorCode } from "../_shared/esign-evidence/issue.ts";
import { verifySealed, validateSealKey, type SealedCertificate } from "../_shared/esign-evidence/evidence.ts";
import { buildCertificatePdf } from "../_shared/esign-evidence/certificatePdf.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 2_000_000;

const STATUS: Record<IssueErrorCode, number> = {
  not_found: 404, not_completed: 409, integrity_failed: 500, seal_not_configured: 503, stored_certificate_corrupt: 500, db_error: 500,
};
const MESSAGE: Record<IssueErrorCode, string> = {
  not_found: "Signature request not found.",
  not_completed: "The certificate is available once every signer has signed.",
  integrity_failed: "The evidence record failed its own integrity checks, so no certificate was issued.",
  seal_not_configured: "Evidence sealing is not configured on this deployment.",
  stored_certificate_corrupt: "The stored certificate no longer matches its fingerprint.",
  db_error: "Could not read the evidence record.",
};

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function respond(env: SealedCertificate, format: string, requestId: string): Response {
  if (format === "pdf") {
    return json({ format: "pdf", filename: `signature-certificate-${requestId}.pdf`, pdf_base64: toBase64(buildCertificatePdf(env)) });
  }
  return json({ format: "json", filename: `signature-certificate-${requestId}.json`, envelope: env });
}

// deno-lint-ignore no-explicit-any
async function ownerIdFor(admin: any, caller: { id: string; email?: string | null }): Promise<string> {
  const { data: profile } = await admin.from("profiles").select("id").eq("id", caller.id).maybeSingle();
  if (profile) return profile.id;
  const { data: member } = await admin.from("team_members").select("account_owner_id").eq("member_email", caller.email ?? "").maybeSingle();
  return member?.account_owner_id ?? caller.id;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ error: "Request too large." }, 413);
    const body = (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; } })();
    const action = body.action as string;
    const format = body.format === "pdf" ? "pdf" : "json";

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const sealKey = Deno.env.get("ESIGN_EVIDENCE_HMAC_KEY");
    const keyId = Deno.env.get("ESIGN_EVIDENCE_KEY_ID") || "k1";

    if (action === "get") {
      const requestId = String(body.request_id ?? "");
      if (!UUID.test(requestId)) return json({ error: "request_id is required." }, 400);
      const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!jwt) return json({ error: "Missing Authorization header." }, 401);
      const { data: userData, error: userError } = await admin.auth.getUser(jwt);
      if (userError || !userData?.user) return json({ error: "Invalid or expired session." }, 401);
      const ownerId = await ownerIdFor(admin, userData.user);
      const { data: reqRow } = await admin.from("signature_requests").select("id, user_id").eq("id", requestId).maybeSingle();
      // Same answer for "not yours" and "does not exist": no enumeration.
      if (!reqRow || reqRow.user_id !== ownerId) return json({ error: MESSAGE.not_found }, 404);
      return respond(await issueCertificate(admin, requestId, sealKey, keyId), format, requestId);
    }

    if (action === "get_by_token") {
      const token = String(body.signer_token ?? "");
      if (!UUID.test(token)) return json({ error: "signer_token is required." }, 400);
      const { data: signer } = await admin.from("signature_signers").select("request_id").eq("signer_token", token).maybeSingle();
      if (!signer) return json({ error: MESSAGE.not_found }, 404);
      return respond(await issueCertificate(admin, signer.request_id, sealKey, keyId), format, signer.request_id);
    }

    if (action === "verify") {
      if (!validateSealKey(sealKey)) return json({ error: MESSAGE.seal_not_configured }, 503);
      const env = body.envelope as SealedCertificate | undefined;
      if (!env || typeof env !== "object") return json({ error: "envelope is required." }, 400);
      const result = await verifySealed(env, sealKey);
      let storedMatch: boolean | null = null;
      const rid = env.certificate?.request?.id;
      if (typeof rid === "string" && UUID.test(rid)) {
        const stored = await loadStored(admin, rid).catch(() => null);
        storedMatch = stored ? stored.certificate_sha256 === env.certificate_sha256 : null;
      }
      return json({ ...result, valid: result.valid && storedMatch !== false, stored_match: storedMatch });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    if (err instanceof IssueError) return json({ error: MESSAGE[err.code], code: err.code }, STATUS[err.code]);
    console.error("signature-certificate error:", err);
    return json({ error: "Unexpected error." }, 500);
  }
});
