// supabase/functions/_shared/portal/redact.ts
// Nothing that looks like a credential may reach logs, API responses, events or evidence metadata.

const SECRET_KEY_RE = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|otp|mfa|2fa|ciphertext|credential/i;
export const REDACTED = "[REDACTED]";

/** Replace every known secret VALUE (exact substring) and common secret-looking patterns in free text. */
export function redactText(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const s of knownSecrets) {
    if (s && s.length >= 3) out = out.split(s).join(REDACTED);
  }
  return out
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(/((?:pass(?:word)?|pwd|secret|token|api[_-]?key|otp)\s*[=:]\s*)[^\s&"']+/gi, `$1${REDACTED}`)
    .replace(/\bv2\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED);
}

/** Deep-redacts an object by key name AND by known secret values. Returns a new object. */
export function redactDeep<T>(value: T, knownSecrets: readonly string[] = [], depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (typeof value === "string") return redactText(value, knownSecrets) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, knownSecrets, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactDeep(v, knownSecrets, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Error text that is safe to persist: drops stack, redacts secrets, caps length. */
export function safeError(err: unknown, knownSecrets: readonly string[] = []): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactText(msg, knownSecrets).slice(0, 500);
}
