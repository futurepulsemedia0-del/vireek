// supabase/functions/_shared/data-platform/googleAuth.ts
//
// Google service-account authentication for BigQuery and Google Sheets, with no SDK:
// parse the key file the customer pasted, sign an RS256 JWT with WebCrypto, exchange it for a
// short-lived access token. The customer's own service account is used on purpose: the sheet or
// dataset is shared with THEIR service account, so Vireek needs no Google OAuth verification and
// can never touch anything the customer did not explicitly share.
//
// Pure except `fetchAccessToken` (one POST to Google's token endpoint).

import { b64url } from "./secrets.ts";

export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
export const SCOPE_BIGQUERY = "https://www.googleapis.com/auth/bigquery";
export const SCOPE_SHEETS = "https://www.googleapis.com/auth/spreadsheets";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export type ParsedKey = { ok: true; key: ServiceAccountKey } | { ok: false; error: string };

export function parseServiceAccountJson(raw: unknown): ParsedKey {
  let obj: Record<string, unknown>;
  try {
    obj = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
  } catch {
    return { ok: false, error: "The service account key is not valid JSON." };
  }
  if (!obj || typeof obj !== "object") return { ok: false, error: "The service account key is not valid JSON." };
  const email = obj.client_email;
  const pem = obj.private_key;
  if (obj.type !== undefined && obj.type !== "service_account") return { ok: false, error: "This key is not a service account key." };
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(email)) {
    return { ok: false, error: "The key has no valid client_email (expected ...@...iam.gserviceaccount.com)." };
  }
  if (typeof pem !== "string" || !/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(pem)) {
    return { ok: false, error: "The key has no PKCS#8 private_key. Download a fresh JSON key from Google Cloud." };
  }
  return { ok: true, key: { client_email: email, private_key: pem, project_id: typeof obj.project_id === "string" ? obj.project_id : undefined } };
}

export function pemToPkcs8(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END)[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
}

const enc = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

/** Signs the RS256 JWT bearer assertion Google expects. */
export async function signServiceAccountJwt(key: ServiceAccountKey, scopes: readonly string[], nowSec: number): Promise<string> {
  const header = enc({ alg: "RS256", typ: "JWT" });
  const claims = enc({ iss: key.client_email, scope: scopes.join(" "), aud: GOOGLE_TOKEN_URI, iat: nowSec, exp: nowSec + 3600 });
  const signingInput = `${header}.${claims}`;
  const cryptoKey = await crypto.subtle.importKey("pkcs8", pemToPkcs8(key.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

export async function fetchAccessToken(key: ServiceAccountKey, scopes: readonly string[]): Promise<string> {
  const assertion = await signServiceAccountJwt(key, scopes, Math.floor(Date.now() / 1000));
  const res = await fetch(GOOGLE_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Google rejected the service account: ${body.error_description ?? body.error ?? res.status}`);
  }
  return body.access_token;
}
