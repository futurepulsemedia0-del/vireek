// Constant-time shared-secret comparison for header secrets (CRON_SECRET, webhook tokens).
// Both inputs are SHA-256 hashed first, so neither the content nor the LENGTH of the expected secret leaks
// through timing. Returns false when either side is empty/missing (fail closed).
export async function secretEquals(provided: string | null | undefined, expected: string | null | undefined): Promise<boolean> {
  if (!provided || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
