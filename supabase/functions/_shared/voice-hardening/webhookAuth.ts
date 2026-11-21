// Pure helpers for the Vapi webhook entry point (no Deno / npm imports so vitest can run them).

/**
 * Constant-time string comparison. It always walks max(a.length, b.length) code units and folds the length
 * difference into the result, so neither content nor length of a near-miss changes the work done.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/** True only when a non-empty expected secret is configured AND the provided value matches it exactly. */
export function verifyVapiSecret(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  return timingSafeEqualStr(provided, expected);
}

// ---------------------------------------------------------------------------------------------
// Which header carries the Server URL secret (verified against docs.vapi.ai/server-url/server-authentication)
//
//   * Current / recommended: a Bearer Token custom credential -> `Authorization: Bearer <token>`
//     (the dashboard also lets the owner turn the "Bearer" prefix off, which sends the raw token).
//   * Legacy: `X-Vapi-Secret: <token>` (the old inline `server.secret`; still supported by Vapi, and still
//     what `_shared/audit/script.ts` configures through `server.headers`).
//
// During the transition BOTH are accepted against the same VAPI_SERVER_SECRET. A request is authentic if
// EITHER header carries the secret; an unrelated value in the other header is ignored. That matters:
// `voice-reconcile` replays events with `x-vapi-secret: <secret>` AND `Authorization: Bearer <service-role key>`.
// Set VAPI_ACCEPT_LEGACY_SECRET_HEADER=0 to stop honouring `x-vapi-secret` once the logs show it is unused.
// ---------------------------------------------------------------------------------------------

export type VapiSecretSource = "authorization" | "x-vapi-secret";
export type VapiAuthResult = { ok: true; via: VapiSecretSource } | { ok: false; via: null };

/** Fetch `Headers`, or a plain (Node-style) record whose values may be arrays. */
export type HeaderBag = { get(name: string): string | null } | Record<string, string | string[] | null | undefined>;

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | string[] | null | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== name) continue;
    const value = record[key];
    return (Array.isArray(value) ? value[0] : value) ?? undefined;
  }
  return undefined;
}

/** `Authorization: Bearer abc` -> `abc`; a raw `Authorization: abc` (prefix toggled off in Vapi) -> `abc`. */
function readAuthorizationToken(headers: HeaderBag): string | undefined {
  const raw = readHeader(headers, "authorization")?.trim();
  if (!raw) return undefined;
  return raw.replace(/^bearer\s+/i, "");
}

/** Reads the legacy-header switch. Anything other than an explicit off value keeps it ON (the safe default for a migration). */
export function isLegacySecretHeaderAccepted(envValue: string | null | undefined): boolean {
  return !/^(0|false|off|no)$/i.test((envValue ?? "").trim());
}

/**
 * Authenticates a Vapi Server URL request. Both candidate headers are always compared (no early exit),
 * so timing does not reveal which one carried a valid secret. Fails closed when no secret is configured.
 */
export function verifyVapiRequestSecret(
  headers: HeaderBag,
  expected: string | null | undefined,
  opts: { acceptLegacyHeader?: boolean } = {},
): VapiAuthResult {
  if (!expected) return { ok: false, via: null };
  const acceptLegacy = opts.acceptLegacyHeader ?? true;
  const okBearer = verifyVapiSecret(readAuthorizationToken(headers), expected);
  const okLegacy = acceptLegacy && verifyVapiSecret(readHeader(headers, "x-vapi-secret"), expected);
  if (okBearer) return { ok: true, via: "authorization" };
  if (okLegacy) return { ok: true, via: "x-vapi-secret" };
  return { ok: false, via: null };
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
