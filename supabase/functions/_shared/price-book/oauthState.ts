// Signs/verifies the `state` param for Jobber's OAuth redirect, since the
// callback has no Supabase session to identify the user with.
// Required secret: supabase secrets set JOBBER_STATE_SECRET=$(openssl rand -hex 32)

const STATE_TTL_MS = 10 * 60 * 1000;

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signState(userId: string, secret: string): Promise<string> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const payload = `${userId}.${Date.now()}.${nonce}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyState(state: string, secret: string): Promise<string | null> {
  if (!secret) return null;
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const [userId, tsRaw, nonce, sig] = parts;
  if (!/^[0-9a-f]{24}$/.test(nonce)) return null;
  if (!timingSafeEqual(await hmac(secret, `${userId}.${tsRaw}.${nonce}`), sig)) return null;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || ts > Date.now() + 60_000 || Date.now() - ts > STATE_TTL_MS) return null;
  return userId;
}
