// supabase/functions/_shared/price-book/jobberWebhookSignature.ts
//
// Jobber webhook authentication. Per Jobber's developer docs (Setting up webhooks), every request carries
// `X-Jobber-Hmac-SHA256` = base64( HMAC-SHA256( <app OAuth client secret>, <raw request body> ) ).
// Jobber delivers AT LEAST ONCE, so callers MUST be idempotent. Always verify against the RAW body text
// (before JSON.parse) and compare in constant time.

const enc = new TextEncoder();

async function hmacBase64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Constant-time string comparison. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyJobberWebhook(rawBody: string, headerValue: string | null, clientSecret: string): Promise<boolean> {
  if (!headerValue || !clientSecret) return false;
  return timingSafeEqualStr(await hmacBase64(clientSecret, rawBody), headerValue.trim());
}
