// supabase/functions/_shared/wallet/googleWallet.ts
//
// Google Wallet (Generic passes). Flow: ensure the class once -> insert/patch the object via the REST API ->
// hand the customer a "Save to Google Wallet" link that only REFERENCES the object id (short, SMS-friendly).
// Later changes are PATCHed; Google syncs them to the device automatically.

export interface GoogleCreds { issuerId: string; clientEmail: string; privateKeyPem: string }
export interface GoogleResult { ok: boolean; status: number; detail?: string }

const API = "https://walletobjects.googleapis.com/walletobjects/v1";
const SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
const enc = new TextEncoder();

export function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/\\n/g, "\n").replace(/-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey("pkcs8", der as Uint8Array<ArrayBuffer>, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export async function signJwt(claims: Record<string, unknown>, key: CryptoKey): Promise<string> {
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(input) as Uint8Array<ArrayBuffer>));
  return `${input}.${b64url(sig)}`;
}

/** "Add to Google Wallet" URL for an object that already exists on Google's side. */
export async function saveToWalletUrl(c: GoogleCreds, objectId: string, origins: string[], nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const jwt = await signJwt(
    { iss: c.clientEmail, aud: "google", typ: "savetowallet", iat: nowSec, origins, payload: { genericObjects: [{ id: objectId }] } },
    await importPrivateKey(c.privateKeyPem),
  );
  return `https://pay.google.com/gp/v/save/${jwt}`;
}

let token: { value: string; exp: number } | null = null;
const knownClasses = new Set<string>();

export async function getAccessToken(c: GoogleCreds, f: typeof fetch = fetch, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  if (token && token.exp - 60 > nowSec) return token.value;
  const assertion = await signJwt(
    { iss: c.clientEmail, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600 },
    await importPrivateKey(c.privateKeyPem),
  );
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !json.access_token) throw new Error(`Google OAuth failed (${res.status})`);
  token = { value: json.access_token, exp: nowSec + (json.expires_in ?? 3600) };
  return token.value;
}

async function call(c: GoogleCreds, method: string, path: string, body: unknown, f: typeof fetch): Promise<GoogleResult> {
  const res = await f(`${API}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${await getAccessToken(c, f)}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = res.ok ? "" : await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, detail: text.slice(0, 300) || undefined };
}

export async function ensureClass(c: GoogleCreds, classId: string, f: typeof fetch = fetch): Promise<GoogleResult> {
  if (knownClasses.has(classId)) return { ok: true, status: 200 };
  const r = await call(c, "POST", "genericClass", { id: classId }, f);
  if (r.ok || r.status === 409) { knownClasses.add(classId); return { ok: true, status: r.status }; }
  return r;
}

/** Insert the object, or PATCH it if it exists (409). */
export async function upsertObject(c: GoogleCreds, classId: string, obj: Record<string, unknown>, f: typeof fetch = fetch): Promise<GoogleResult> {
  const cls = await ensureClass(c, classId, f);
  if (!cls.ok) return cls;
  const ins = await call(c, "POST", "genericObject", obj, f);
  if (ins.status !== 409) return ins;
  return await call(c, "PATCH", `genericObject/${encodeURIComponent(String(obj.id))}`, obj, f);
}

export async function patchObject(c: GoogleCreds, obj: Record<string, unknown>, f: typeof fetch = fetch): Promise<GoogleResult> {
  return await call(c, "PATCH", `genericObject/${encodeURIComponent(String(obj.id))}`, obj, f);
}
