// Thin Plaid REST client + webhook verification.
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

// ---------- webhook verification (Plaid-Verification JWT, ES256) ----------
const b64uToBytes = (s: string): Uint8Array => {
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
