// supabase/functions/reputation-verify/index.ts
//
// PUBLIC verification endpoint (anonymous callers - validate everything, reveal nothing extra).
//   GET ?id=<uuid>                -> JSON { status, credential?, signature?, payload?, kid, alg }  (credential only when status is valid/expired/revoked)
//   GET ?id=<uuid>&format=svg     -> static 240x40 SVG badge (60 s cache so revocation shows up within a minute)
//   GET ?jwks=1                   -> { keys: [...] } public Ed25519 keys (revoked keys omitted) for OFFLINE verification
//
// Verification = Ed25519 signature check + live revocation + signed expiry (src/lib/reputationCredentials/core.ts, unit-tested).
// The revocation REASON is never exposed publicly. Claims of a credential with a bad signature are never returned.
//
// Deploy: supabase functions deploy reputation-verify --no-verify-jwt     (also verify_jwt = false in supabase/config.toml)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  buildBadgeSvg, buildJwks, isCredentialId, verifyCredential, type CredentialStatus, type Ed25519PublicJwk,
} from "../../../src/lib/reputationCredentials/core.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});
const BASE: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
};
const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), { status, headers: { ...BASE, "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache } });
const svg = (markup: string, status = 200) =>
  new Response(markup, { status, headers: { ...BASE, "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=60, s-maxage=60", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });

async function bucketFor(req: Request): Promise<string> {
  const ip = req.headers.get("cf-connecting-ip") ?? (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ?? "";
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`rep|${ip}`)); // raw IPs are never stored
  return `rep:${[...new Uint8Array(h)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: BASE });
  if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
  const q = new URL(req.url).searchParams;
  const wantsSvg = q.get("format") === "svg";

  const { data: allowed } = await admin.rpc("trust_badge_hit", { p_bucket: await bucketFor(req), p_limit: 120 });
  if (allowed === false) return wantsSvg ? svg(buildBadgeSvg("not_found", null), 429) : json({ error: "rate_limited" }, 429);

  if (q.get("jwks") === "1") {
    const { data, error } = await admin.rpc("reputation_active_keys");
    if (error) return json({ error: "unavailable" }, 503);
    return json(buildJwks(data as { kid: string; publicJwk: Ed25519PublicJwk; status: string }[]), 200, "public, max-age=300");
  }

  const id = q.get("id") ?? "";
  if (!isCredentialId(id)) return wantsSvg ? svg(buildBadgeSvg("not_found", null), 404) : json({ status: "not_found" }, 404);

  const { data, error } = await admin.rpc("reputation_public_lookup", { p_id: id });
  if (error) return wantsSvg ? svg(buildBadgeSvg("not_found", null), 503) : json({ error: "unavailable" }, 503);
  const row = data as { found: boolean; payload?: string; signature?: string; kid?: string; revoked_at?: string | null; public_jwk?: Ed25519PublicJwk; key_status?: "active" | "retired" | "revoked" };
  if (!row?.found || !row.payload || !row.signature) return wantsSvg ? svg(buildBadgeSvg("not_found", null), 404) : json({ status: "not_found" }, 404);

  const result = await verifyCredential({
    payload: row.payload, signature: row.signature, publicJwk: row.public_jwk ?? null, keyStatus: row.key_status ?? null,
    revokedAt: row.revoked_at ?? null, now: new Date(),
  });
  const status: CredentialStatus = result.status;
  if (wantsSvg) return svg(buildBadgeSvg(status, status === "valid" ? result.envelope?.sub.name ?? null : null));

  const e = result.envelope; // null for forged / unknown-key credentials
  return json({
    status, alg: "Ed25519", kid: row.kid ?? null,
    credential: e ? { id: e.id, subject: e.sub, scopes: e.scopes, claims: e.claims, issuedAt: new Date(e.iat * 1000).toISOString(), expiresAt: new Date(e.exp * 1000).toISOString(), revokedAt: row.revoked_at ?? null } : null,
    payload: e ? row.payload : null, signature: e ? row.signature : null, // so a third party can re-verify offline against ?jwks=1
  }, 200, status === "valid" ? "public, max-age=30" : "public, max-age=60");
});
