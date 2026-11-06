// Fail-CLOSED cron authentication: a missing/empty server secret rejects every request
// (unlike patterns that skip the check when the secret is unset).

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function isCronAuthorized(serverSecret: string | undefined | null, headerValue: string | null): boolean {
  if (!serverSecret || serverSecret.length < 16) return false;
  if (!headerValue) return false;
  return timingSafeEqual(serverSecret, headerValue);
}
