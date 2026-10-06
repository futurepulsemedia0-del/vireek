// Shared plumbing for the Demand OS edge functions.
// Required secrets (supabase secrets set ...):
//   ADS_TOKEN_ENCRYPTION_KEY   base64 of 32 random bytes:  openssl rand -base64 32
//   ADS_STATE_SECRET           openssl rand -hex 32
//   ADS_CRON_SECRET            openssl rand -hex 32   (cron callers send it as X-Cron-Secret)
//   SITE_URL                   https://vireek.com

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

export function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
}

/** Constant-time string compare. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Fails CLOSED: with no ADS_CRON_SECRET configured, cron access is denied. */
export function isCron(req: Request): boolean {
  const secret = Deno.env.get("ADS_CRON_SECRET");
  const given = req.headers.get("X-Cron-Secret");
  return !!secret && !!given && safeEqual(secret, given);
}

/** Resolves the logged-in caller to the ACCOUNT OWNER id (team members act for their owner). */
export async function authenticate(req: Request): Promise<{ ownerId: string; userId: string } | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error } = await asUser.auth.getUser(jwt);
  if (error || !userData?.user) return null;
  const { data: ownerId } = await asUser.rpc("get_account_owner_id");
  if (!ownerId) return null;
  return { ownerId: ownerId as string, userId: userData.user.id };
}

// ---------- token encryption (AES-256-GCM) ----------
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("ADS_TOKEN_ENCRYPTION_KEY");
  if (!raw) throw new Error("ADS_TOKEN_ENCRYPTION_KEY is not set");
  const bytes = unb64(raw);
  if (bytes.length !== 32) throw new Error("ADS_TOKEN_ENCRYPTION_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), new TextEncoder().encode(plain)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function decryptToken(blob: string): Promise<string> {
  const [v, iv, ct] = blob.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unsupported token format");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(), unb64(ct));
  return new TextDecoder().decode(plain);
}

// ---------- HTTP with timeout + retry ----------
export async function fetchJson<T = any>(url: string, init: RequestInit = {}, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(25_000) });
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (res.ok) return body as T;
      const err = new HttpError(res.status, body?.error?.message ?? body?.error_description ?? body?.error ?? `HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) throw err; // 4xx is not retryable
      lastErr = err;
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** i));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(typeof message === "string" ? message : JSON.stringify(message));
  }
}

// ---------- misc ----------
export const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
export const digits10 = (p?: string | null): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};
export async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AdAccountRow {
  id: string;
  user_id: string;
  platform: "google_ads" | "meta_ads" | "google_lsa";
  external_account_id: string;
  login_customer_id: string | null;
  currency: string;
}

/** Returns a valid access token, refreshing (Google) or flagging re-auth (Meta) as needed. */
export async function getAccessToken(
  admin: SupabaseClient,
  account: AdAccountRow,
  refresh: (refreshToken: string) => Promise<{ access_token: string; expires_in: number }>,
): Promise<string> {
  const { data: cred } = await admin.from("ad_account_credentials").select("*").eq("account_id", account.id).maybeSingle();
  if (!cred) throw new Error("No credentials stored for this account.");
  const expiresAt = cred.access_expires_at ? new Date(cred.access_expires_at).getTime() : 0;
  if (cred.encrypted_access_token && expiresAt - Date.now() > 120_000) return decryptToken(cred.encrypted_access_token);
  if (!cred.encrypted_refresh_token) throw new Error("Token expired; reconnect required.");
  const fresh = await refresh(await decryptToken(cred.encrypted_refresh_token));
  await admin.from("ad_account_credentials").update({
    encrypted_access_token: await encryptToken(fresh.access_token),
    access_expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("account_id", account.id);
  return fresh.access_token;
}
