// supabase/functions/_shared/fraud/hooks.ts
//
// Small helpers shared by the Supabase Auth hook functions and fraud-sweep.
// WebCrypto only, so it runs in Deno and in Node/Vitest unchanged.

/** sha-256 hex of `pepper|scope|value`. Raw phone numbers and IPs are never stored. */
export async function hashKey(pepper: string, scope: string, value: string): Promise<string> {
  const data = new TextEncoder().encode(`${pepper}|${scope}|${value.trim().toLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** First client IP from x-forwarded-for style values (hooks pass the IP in the payload instead). */
export function firstIp(value: string | null | undefined): string {
  return (value ?? "").split(",")[0].trim().slice(0, 64) || "unknown";
}

/** Supabase hook secrets look like "v1,whsec_<base64>"; standardwebhooks wants the base64 part. */
export function hookSecretBase64(secret: string): string {
  return secret.replace(/^v1,whsec_/, "");
}

/** Auth hooks report failures as {"error":{"http_code":..,"message":..}} (Supabase Auth hook contract). */
export function hookError(httpCode: number, message: string): Response {
  return new Response(JSON.stringify({ error: { http_code: httpCode, message } }), { status: httpCode, headers: { "Content-Type": "application/json" } });
}

/** Auth stores/passes phones without the leading "+"; normalize to a "+<digits>" string before policy checks. */
export function normalizeHookPhone(raw: string): string {
  const t = String(raw ?? "").trim();
  return t.startsWith("+") ? t : /^[0-9]{8,15}$/.test(t) ? `+${t}` : t;
}

/** Best client IP from the platform's forwarding headers (Cloudflare first, then the left-most X-Forwarded-For). */
export function clientIp(headers: Headers): string {
  return firstIp(headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for"));
}
