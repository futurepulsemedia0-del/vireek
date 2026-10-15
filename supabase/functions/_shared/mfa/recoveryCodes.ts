// supabase/functions/_shared/mfa/recoveryCodes.ts
//
// Pure recovery-code helpers (no Deno / network) so they are unit-tested in
// Vitest. src/lib/mfaChallenge.ts mirrors ALPHABET / CODE_LENGTH / normalize
// for the browser; the test file fails if the two ever drift.

// 30 characters, no 0/O/1/I/L/U — nothing that is easy to misread on paper.
export const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const CODE_LENGTH = 10;
export const CODE_COUNT = 10;

/** Uppercases and strips everything that is not a letter or digit ("abcde-fghjk " → "ABCDEFGHJK"). */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isWellFormed(normalized: string): boolean {
  if (normalized.length !== CODE_LENGTH) return false;
  for (const ch of normalized) if (!ALPHABET.includes(ch)) return false;
  return true;
}

export function formatCode(normalized: string): string {
  return `${normalized.slice(0, CODE_LENGTH / 2)}-${normalized.slice(CODE_LENGTH / 2)}`;
}

/** Cryptographically random code. Rejection sampling keeps every character equally likely (no modulo bias). */
export function generateCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const byte of random(CODE_LENGTH * 2)) {
      if (byte < limit && out.length < CODE_LENGTH) out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}

export function generateCodes(count = CODE_COUNT, random?: (n: number) => Uint8Array): string[] {
  const set = new Set<string>();
  while (set.size < count) set.add(generateCode(random));
  return [...set];
}

/** HMAC-SHA256(pepper, "<userId>:<code>") as hex. Binding to the user stops a hash from being replayed across accounts. */
export async function hashCode(pepper: string, userId: string, normalized: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${userId}:${normalized}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads a claim from a JWT payload WITHOUT verifying it — only call after auth.getUser(token) has validated the token. */
export function jwtClaim(token: string, claim: string): unknown {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "="));
    return (JSON.parse(json) as Record<string, unknown>)[claim];
  } catch {
    return undefined;
  }
}
