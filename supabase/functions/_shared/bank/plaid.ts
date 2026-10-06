// supabase/functions/_shared/bank/plaid.ts
// Thin Plaid REST client + typed helpers + webhook verification.
// Secrets: supabase secrets set PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox|production

export class PlaidError extends Error {
  constructor(public code: string, public type: string, message: string, public status: number) {
    super(message);
    this.name = "PlaidError";
  }
}

export interface Plaid {
  // deno-lint-ignore no-explicit-any
  post<T = any>(path: string, body: Record<string, unknown>): Promise<T>;
}

const HOSTS: Record<string, string> = { sandbox: "https://sandbox.plaid.com", production: "https://production.plaid.com" };

export function plaidConfigured(): boolean {
  return Boolean(Deno.env.get("PLAID_CLIENT_ID") && Deno.env.get("PLAID_SECRET"));
}

export function getPlaid(): Plaid {
  const clientId = Deno.env.get("PLAID_CLIENT_ID");
  const secret = Deno.env.get("PLAID_SECRET");
  if (!clientId || !secret) throw new PlaidError("NOT_CONFIGURED", "CONFIG", "Bank connections aren't configured on this server yet.", 500);
  const host = HOSTS[(Deno.env.get("PLAID_ENV") ?? "sandbox").toLowerCase()] ?? HOSTS.sandbox;
  return {
    async post(path, body) {
      let res: Response;
      try {
        res = await fetch(`${host}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "PLAID-CLIENT-ID": clientId, "PLAID-SECRET": secret },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(25_000),
        });
      } catch (e) {
        throw new PlaidError("NETWORK", "NETWORK", e instanceof Error ? e.message : "Network error", 0);
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new PlaidError(json.error_code ?? "UNKNOWN", json.error_type ?? "UNKNOWN", json.error_message ?? `Plaid request failed (${res.status})`, res.status);
      return json;
    },
  };
}

// ---------- typed payloads ----------
export interface PlaidAccount {
  account_id: string; name: string; official_name: string | null; mask: string | null;
  type: string; subtype: string | null;
  balances: { current: number | null; available: number | null; iso_currency_code: string | null };
}
export interface PlaidTxn {
  transaction_id: string; account_id: string; amount: number; date: string; authorized_date: string | null;
  name: string; merchant_name: string | null; pending: boolean; pending_transaction_id: string | null;
  payment_channel: string | null; iso_currency_code: string | null;
  personal_finance_category?: { primary: string; detailed: string } | null;
}
export interface PlaidSyncPage {
  added: PlaidTxn[]; modified: PlaidTxn[]; removed: { transaction_id: string }[];
  next_cursor: string; has_more: boolean; accounts: PlaidAccount[];
}

// ---------- API helpers used by bank-connect / engine ----------
export const createLinkToken = (userId: string, webhookUrl: string, accessToken?: string) =>
  getPlaid().post<{ link_token: string }>("/link/token/create", {
    user: { client_user_id: userId },
    client_name: "Vireek",
    language: "en",
    country_codes: ["US", "CA"],
    webhook: webhookUrl,
    ...(accessToken ? { access_token: accessToken } : { products: ["transactions"], transactions: { days_requested: 730 } }),
  });

export const exchangePublicToken = (publicToken: string) =>
  getPlaid().post<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });

export async function getItemInstitution(accessToken: string): Promise<{ id: string | null; name: string }> {
  const plaid = getPlaid();
  const item = await plaid.post<{ item: { institution_id: string | null } }>("/item/get", { access_token: accessToken });
  const id = item.item.institution_id;
  if (!id) return { id: null, name: "Bank" };
  try {
    const inst = await plaid.post<{ institution: { name: string } }>("/institutions/get_by_id", { institution_id: id, country_codes: ["US", "CA"] });
    return { id, name: inst.institution.name };
  } catch {
    return { id, name: "Bank" };
  }
}

export const transactionsSync = (accessToken: string, cursor: string | null) =>
  getPlaid().post<PlaidSyncPage>("/transactions/sync", { access_token: accessToken, ...(cursor ? { cursor } : {}), count: 500 });

export const removeItem = (accessToken: string) => getPlaid().post("/item/remove", { access_token: accessToken });

/** Plaid: positive = money OUT of the account. We invert to business-perspective signed cents (in = +, out = −). */
export const toSignedCents = (plaidAmount: number): number => -Math.round(plaidAmount * 100);

// ---------- webhook verification (Plaid-Verification JWT, ES256) ----------
const b64uToBytes = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const keyCache = new Map<string, CryptoKey>();

export async function verifyPlaidWebhook(plaid: Plaid, rawBody: string, jwt: string | null): Promise<boolean> {
  try {
    if (!jwt) return false;
    const [h, p, sig] = jwt.split(".");
    if (!h || !p || !sig) return false;
    const header = JSON.parse(new TextDecoder().decode(b64uToBytes(h)));
    if (header.alg !== "ES256" || !header.kid) return false;
    let key = keyCache.get(header.kid);
    if (!key) {
      const { key: jwk } = await plaid.post("/webhook_verification_key/get", { key_id: header.kid });
      if (!jwk || jwk.expired_at) return false;
      key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      keyCache.set(header.kid, key);
    }
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64uToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64uToBytes(p)));
    if (Math.floor(Date.now() / 1000) - Number(payload.iat) > 300) return false;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody));
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const expected = String(payload.request_body_sha256 ?? "");
    if (hex.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
