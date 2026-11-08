// Shared caller check for growth edge functions: cron secret OR a staff user's JWT.

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** True when the provided header value equals a non-empty configured secret (constant time). */
export function cronSecretMatches(provided: string | null, configured: string): boolean {
  return configured.length >= 16 && provided !== null && timingSafeEqual(provided, configured);
}
