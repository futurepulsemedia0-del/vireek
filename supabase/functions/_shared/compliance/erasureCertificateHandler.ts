// supabase/functions/_shared/compliance/erasureCertificateHandler.ts
//
// Request handler behind supabase/functions/erasure-certificate. Kept free of Deno globals so it can be
// unit-tested with fakes.
//
//   GET ?deletionRequestId=<uuid>             -> the certificate, as the exact stored JSON (attachment)
//   GET ?deletionRequestId=<uuid>&verify=1    -> {valid, checks} recomputed from the stored document
//   GET (no id)                               -> metadata of the caller's own certificates (max 50)
//
// Authorization model
//   * The caller's own access token is validated, and every read goes through a client that carries that
//     token, so Postgres RLS (account_id = auth.uid()) is the authority. No service-role key is used here.
//   * "Not yours" and "does not exist" are indistinguishable (both 404), so ids cannot be probed.
//   * Responses are never cached and never sniffed.

import { isUuid, verifyCertificateJson } from "./erasureCertificate.ts";

export interface CertClient {
  auth: { getUser(token: string): Promise<{ data: { user: { id: string } | null }; error: unknown }> };
  from(table: "erasure_certificates"): {
    select(cols: string): {
      eq(col: string, val: string): { maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }> };
      order(col: string, o: { ascending: boolean }): { limit(n: number): Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }> };
    };
  };
}

export interface HandlerDeps {
  createUserClient(accessToken: string): CertClient | null;
  /** key id -> secret (current + retired). Empty => verification is not configured. */
  verifyKeys: Record<string, string>;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
  "Access-Control-Expose-Headers": "Content-Disposition, X-Certificate-SHA256",
};
const BASE: Record<string, string> = { ...CORS, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...BASE, "Content-Type": "application/json; charset=utf-8", ...extra } });
const fail = (code: string, message: string, status: number, extra: Record<string, string> = {}) => json({ ok: false, code, message }, status, extra);

export async function handleErasureCertificateRequest(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: BASE });
  if (req.method !== "GET") return fail("method_not_allowed", "Method not allowed.", 405, { Allow: "GET, OPTIONS" });

  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return fail("unauthenticated", "Sign in to download a deletion certificate.", 401, { "WWW-Authenticate": "Bearer" });
  const token = m[1];

  const client = deps.createUserClient(token);
  if (!client) return fail("not_configured", "This service isn't configured yet.", 503);

  const { data: u, error: uErr } = await client.auth.getUser(token);
  if (uErr || !u?.user) return fail("unauthenticated", "Your session is invalid or has expired.", 401, { "WWW-Authenticate": "Bearer" });

  const url = new URL(req.url);
  const id = url.searchParams.get("deletionRequestId");
  const verify = url.searchParams.get("verify");

  // ---- list own certificates (metadata only) ----
  if (id === null) {
    const { data, error } = await client
      .from("erasure_certificates")
      .select("deletion_request_id, certificate_number, status, issued_at, backup_expires_at, sha256")
      .order("issued_at", { ascending: false })
      .limit(50);
    if (error) return fail("server_error", "We couldn't load your certificates. Please try again.", 500);
    return json({ ok: true, certificates: data ?? [] });
  }

  if (!isUuid(id)) return fail("validation", "deletionRequestId must be a valid id.", 400);
  if (verify !== null && verify !== "1") return fail("validation", "verify must be 1 when present.", 400);

  const { data: row, error } = await client
    .from("erasure_certificates")
    .select("certificate_number, document_json, sha256, status, issued_at")
    .eq("deletion_request_id", id)
    .maybeSingle();
  if (error) return fail("server_error", "We couldn't load the certificate. Please try again.", 500);
  if (!row || typeof row.document_json !== "string" || typeof row.sha256 !== "string") {
    return fail("not_found", "No certificate was found for that request.", 404);
  }

  if (verify === "1") {
    if (!Object.keys(deps.verifyKeys).length) return fail("not_configured", "Verification isn't configured yet.", 503);
    const result = await verifyCertificateJson(row.document_json, deps.verifyKeys, row.sha256);
    return json({ ok: true, certificateNumber: row.certificate_number, sha256: row.sha256, ...result });
  }

  const number = typeof row.certificate_number === "string" && /^VRK-ERC-[0-9A-F]{12}$/.test(row.certificate_number) ? row.certificate_number : "certificate";
  return new Response(row.document_json, {
    status: 200,
    headers: {
      ...BASE,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${number}.json"`,
      "X-Certificate-SHA256": row.sha256,
    },
  });
}
