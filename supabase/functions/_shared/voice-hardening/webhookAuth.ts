// Pure helpers for the Vapi webhook entry point (no Deno / npm imports so vitest can run them).

/** Constant-time string comparison (length difference still short-circuits; lengths are not secret). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True only when a non-empty expected secret is configured AND the header matches it exactly. */
export function verifyVapiSecret(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  return timingSafeEqualStr(provided, expected);
}

export const MAX_WEBHOOK_BODY_CHARS = 2_000_000;

export type ParsedBody =
  | { ok: true; message: Record<string, unknown> & { type: string } }
  | { ok: false; status: 400 | 413; error: string };

/** Parses the raw request text. Never throws. */
export function parseVapiBody(raw: string): ParsedBody {
  if (raw.length > MAX_WEBHOOK_BODY_CHARS) return { ok: false, status: 413, error: "Payload too large" };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }
  const message = (body as { message?: unknown } | null)?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, status: 400, error: "Missing message.type" };
  }
  const type = (message as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0 || type.length > 100) {
    return { ok: false, status: 400, error: "Missing message.type" };
  }
  return { ok: true, message: message as Record<string, unknown> & { type: string } };
}
