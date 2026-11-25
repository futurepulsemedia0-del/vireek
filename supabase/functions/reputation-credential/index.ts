// supabase/functions/reputation-credential/index.ts
//
// AUTHENTICATED issuing endpoint for portable reputation credentials.
//   POST { action: "issue", technician_id: uuid|null, scopes: string[], valid_days: number, label?: string }
//        -> { id, link, badge_html, expires_at }
//
// Flow (authorisation stays in the database, only the signature happens here):
//   1. caller's JWT -> rpc reputation_prepare_credential  (authorises, checks consent, builds claims, stores a PENDING row)
//   2. this function canonicalises + privacy-checks the envelope and signs it with the Ed25519 private key
//   3. service role -> rpc reputation_attach_signature     (DB verifies the signed payload equals the prepared envelope)
//
// Secrets : REPUTATION_SIGNING_KEY_JWK (private Ed25519 JWK as JSON, REQUIRED - fails closed), REPUTATION_SIGNING_KID (must exist
//           and be 'active' in reputation_signing_keys), PUBLIC_APP_URL (default https://vireek.com).
// Deploy  : supabase functions deploy reputation-credential     (JWT verification stays ON)
// Key gen : node scripts/reputation-generate-key.mjs <kid>

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  buildEmbedSnippets, signEnvelope, validateEnvelope, validateIssueInput, type CredentialEnvelope, type Ed25519PrivateJwk,
} from "../../../src/lib/reputationCredentials/core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const APP_URL = (Deno.env.get("PUBLIC_APP_URL") ?? "https://vireek.com").replace(/\/+$/, "");
const KID = Deno.env.get("REPUTATION_SIGNING_KID") ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function loadPrivateKey(): Ed25519PrivateJwk | null {
  try {
    const k = JSON.parse(Deno.env.get("REPUTATION_SIGNING_KEY_JWK") ?? "") as Ed25519PrivateJwk;
    return k?.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string" && typeof k.d === "string" ? k : null;
  } catch { return null; }
}

// The Postgres error code -> a safe, user-facing message. Anything else is logged and returned as a generic failure.
function dbError(e: { code?: string; message?: string }): { status: number; error: string; message: string } {
  const safe: Record<string, [number, string]> = { "42501": [403, "forbidden"], "22023": [400, "invalid_request"], "P0002": [404, "not_found"], "54000": [409, "limit_reached"], "P0001": [409, "not_available"] };
  const hit = e.code ? safe[e.code] : undefined;
  if (hit) return { status: hit[0], error: hit[1], message: e.message ?? hit[1] };
  console.error("reputation-credential db error", e.code, e.message);
  return { status: 500, error: "server_error", message: "Something went wrong. Please try again." };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader) return json({ error: "unauthorized" }, 401);
  let body: { action?: string; technician_id?: unknown; scopes?: unknown; valid_days?: unknown; label?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  if (body.action !== "issue") return json({ error: "invalid_request" }, 400);

  const input = validateIssueInput({ scopes: body.scopes, validDays: body.valid_days });
  if (!input.ok) return json({ error: "invalid_request", message: input.error }, 400);
  const techId = body.technician_id === null || body.technician_id === undefined ? null : String(body.technician_id);
  if (techId !== null && !UUID.test(techId)) return json({ error: "invalid_request", message: "Invalid technician." }, 400);
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : null;

  const privateKey = loadPrivateKey();
  if (!privateKey || !KID) return json({ error: "not_configured", message: "Credential signing is not configured." }, 503); // fail closed

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData?.user) return json({ error: "unauthorized" }, 401);

  // 1) authorise + build claims + store pending (all inside the database, under the caller's identity)
  const prep = await userClient.rpc("reputation_prepare_credential", {
    p_technician_id: techId, p_scopes: input.scopes, p_valid_days: input.validDays, p_label: label || null, p_kid: KID,
  });
  if (prep.error) { const e = dbError(prep.error); return json({ error: e.error, message: e.message }, e.status); }
  const { id, envelope } = prep.data as { id: string; envelope: CredentialEnvelope };
  if (!validateEnvelope(envelope) || envelope.id !== id) return json({ error: "server_error", message: "Prepared credential was invalid." }, 500);

  // 2) sign (throws if claims contain forbidden fields)
  let signed: { payload: string; signature: string };
  try { signed = await signEnvelope(privateKey, envelope); }
  catch (e) { console.error("reputation-credential sign failed", (e as Error).message); return json({ error: "server_error", message: "Could not sign the credential." }, 500); }

  // 3) attach (service role; the DB re-checks payload == prepared envelope)
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false, autoRefreshToken: false } });
  const att = await admin.rpc("reputation_attach_signature", { p_id: id, p_payload: signed.payload, p_signature: signed.signature });
  if (att.error) { const e = dbError(att.error); return json({ error: e.error, message: e.message }, e.status); }

  const snippets = buildEmbedSnippets({ appUrl: APP_URL, functionsUrl: `${url}/functions/v1`, id });
  return json({ id, link: snippets.link, badge_html: snippets.html, expires_at: (att.data as { expires_at: string }).expires_at });
});
