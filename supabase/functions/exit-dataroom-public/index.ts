// supabase/functions/exit-dataroom-public/index.ts
//
// Public (no-auth) read endpoint behind the buyer link  <app>/data-room#<token>.
// Purpose: serve a FROZEN data-room package to a buyer. The token is unguessable (256-bit, only its
// SHA-256 is stored); every attempt is logged (hashed IP, user agent) and the link can expire, be
// revoked or run out of views. All checks happen atomically in the SQL function exit_dataroom_open.
//
// Auth model : none (--no-verify-jwt). The token is the credential. It travels in the POST body, never
//              in a URL the server sees (the page reads it from the URL fragment).
// Secrets    : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (already configured). No new secrets:
//              the service-role key doubles as the HMAC key that pseudonymises caller IPs.
// Deploy     : supabase functions deploy exit-dataroom-public --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_BODY_BYTES = 2048;

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function hmacHex(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "NOT_FOUND" }, 404);
  let token: unknown;
  try {
    token = (JSON.parse(raw) as { token?: unknown }).token;
  } catch {
    return json({ error: "NOT_FOUND" }, 404);
  }
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return json({ error: "NOT_FOUND" }, 404);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return json({ error: "SERVER_ERROR" }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  try {
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const { data, error } = await admin.rpc("exit_dataroom_open", {
      p_token_hash: await sha256Hex(token),
      p_ip_hash: await hmacHex(serviceKey, ip),
      p_user_agent: req.headers.get("user-agent") ?? "",
    });
    if (error) return json({ error: "SERVER_ERROR" }, 500);

    const result = data as { outcome?: string } & Record<string, unknown>;
    if (result.outcome === "rate_limited") return json({ error: "RATE_LIMITED" }, 429);
    // Do not tell the caller *why* a link is unusable.
    if (result.outcome !== "granted") return json({ error: "UNAVAILABLE" }, 404);
    return json({
      label: result.label,
      expiresAt: result.expiresAt,
      viewsRemaining: result.viewsRemaining,
      content: result.content,
    });
  } catch {
    return json({ error: "SERVER_ERROR" }, 500);
  }
});
