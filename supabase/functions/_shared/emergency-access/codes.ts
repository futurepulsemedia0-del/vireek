// supabase/functions/_shared/emergency-access/codes.ts
// One-time verification codes for emergency-access requests. The plain code exists only in the e-mail
// and in the contact's hands; the database stores an HMAC bound to the request id, never the code.

/** 8 decimal digits via rejection sampling (no modulo bias). */
export function generateCode(): string {
  const limit = 4_294_967_296 - (4_294_967_296 % 100_000_000);
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 100_000_000).padStart(8, "0");
  }
}

/** Accepts "1234 5678" / "1234-5678"; returns the 8 digits or null. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const d = input.replace(/[\s-]/g, "");
  return /^\d{8}$/.test(d) ? d : null;
}

export const MIN_PEPPER_LENGTH = 32;

/** hex(HMAC-SHA256(pepper, `${requestId}:${code}`)). The pepper is a server secret (EMERGENCY_CODE_PEPPER). */
export async function hashCode(pepper: string, requestId: string, code: string): Promise<string> {
  if (pepper.length < MIN_PEPPER_LENGTH) throw new Error("pepper too short");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${requestId}:${code}`)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}
