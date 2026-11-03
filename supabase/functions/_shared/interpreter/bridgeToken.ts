// supabase/functions/_shared/interpreter/bridgeToken.ts
//
// Short-lived signed claims that let the bridge worker (a separate service)
// act for ONE interpreter session without holding any database credential.
// HMAC-SHA256 over a base64url JSON payload, compared in constant time.
// Uses only WebCrypto (Deno, Node >= 20, browsers).

export interface BridgeClaims {
  /** interpreter_sessions.id */
  sid: string;
  /** account owner id */
  uid: string;
  role: "caller" | "staff" | "worker";
  /** expiry, epoch seconds */
  exp: number;
  /** staff destination (E.164) — only on the caller-leg token, resolved server-side. */
  dest?: string;
}

const enc = new TextEncoder();
const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function mac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function signClaims(claims: BridgeClaims, secret: string): Promise<string> {
  if (!secret || secret.length < 32) throw new Error("bridge secret must be at least 32 characters");
  const body = b64u(enc.encode(JSON.stringify(claims)));
  return `${body}.${b64u(await mac(secret, body))}`;
}

/** Returns the claims, or null for ANY problem (bad shape, bad signature, expired). Never throws. */
export async function verifyClaims(token: string | null | undefined, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<BridgeClaims | null> {
  try {
    if (!token || !secret || token.length > 4000) return null;
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const expected = await mac(secret, body);
    const given = fromB64u(sig);
    if (given.length !== expected.length) return null;
    let d = 0;
    for (let i = 0; i < expected.length; i++) d |= expected[i] ^ given[i];
    if (d !== 0) return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64u(body))) as BridgeClaims;
    if (typeof c.sid !== "string" || typeof c.uid !== "string" || typeof c.exp !== "number") return null;
    if (!["caller", "staff", "worker"].includes(c.role)) return null;
    if (c.exp < nowSec) return null;
    return c;
  } catch {
    return null;
  }
}
