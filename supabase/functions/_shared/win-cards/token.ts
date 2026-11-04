// supabase/functions/_shared/win-cards/token.ts
// Pure (uses only the Web Crypto global available in Deno, Node >= 19 and browsers).

const B64URL = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isValidToken = (t: unknown): t is string => typeof t === "string" && TOKEN_RE.test(t);

/** 256 bits of CSPRNG output → 43 chars base64url. Unguessable; safe to put in a URL path. */
export function generateToken(): string {
  return B64URL(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Opaque, non-reversible attribution id for ?ref=… (NOT the access token, so referral links can't open the card). */
export async function attributionRef(cardId: string, salt: string): Promise<string> {
  return B64URL(await sha256(`wc-ref:${salt}:${cardId}`)).slice(0, 12);
}

/** Salted hash used to de-duplicate abuse reporters without storing IPs. */
export async function reporterHash(ip: string, userAgent: string, salt: string): Promise<string> {
  return B64URL(await sha256(`wc-rep:${salt}:${ip}:${userAgent.slice(0, 120)}`));
}

/** Deterministic PRNG (mulberry32) so the decorative waveform is stable for a given card. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
