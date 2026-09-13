// Signs/verifies the `state` param for Jobber's OAuth redirect, since the
// callback has no Supabase session to identify the user with.
// Required secret: supabase secrets set JOBBER_STATE_SECRET=$(openssl rand -hex 32)

const STATE_TTL_MS = 10 * 60 * 1000;

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signState(userId: string, secret: string): Promise<string> {
  const payload = `${userId}.${Date.now()}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyState(state: string, secret: string): Promise<string | null> {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [userId, tsRaw, sig] = parts;
  if ((await hmac(secret, `${userId}.${tsRaw}`)) !== sig) return null;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Date.now() - ts > STATE_TTL_MS) return null;
  return userId;
}
