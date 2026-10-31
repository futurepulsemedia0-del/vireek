// supabase/functions/_shared/bi/access.ts
//
// Read-only BI access tokens (Power BI / Excel / Tableau via OData, Airbyte / scripts via JSON or CSV).
//
//   vbi_<43 url-safe chars>   = 256 bits of randomness. Shown ONCE when created.
//   Only SHA-256(token) is stored, so a database leak cannot be replayed as a credential.
//
// A token is bound to ONE account and can never exceed what it was created with:
// a list of datasets, a personal-data mode, a per-minute limit and an expiry date.
//
// Pure: WebCrypto only (Deno, browsers, Node 20+). Imported by the edge functions AND the React app.

import { b64url } from "../data-platform/secrets.ts";
import { PII_MODES, isDatasetKey, type DatasetKey, type PiiMode } from "../data-platform/catalog.ts";

export const TOKEN_PREFIX = "vbi_";
export const TOKEN_RE = /^vbi_[A-Za-z0-9_-]{43}$/;
export const MAX_ACTIVE_TOKENS = 20;
export const DEFAULT_RATE_LIMIT = 60;
export const DEFAULT_EXPIRY_DAYS = 180;

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

export function generateToken(): string {
  return TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const hashToken = (token: string): Promise<string> => sha256Hex(token);

/** Safe-to-display identifier: "vbi_AbCd…" (16 of 256 bits). */
export const tokenHint = (token: string): string => `${TOKEN_PREFIX}${token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 4)}…`;

/**
 * Reads the token from an Authorization header.
 *   Bearer vbi_…                         scripts, Airbyte, any HTTP client
 *   Basic base64(<anything>:vbi_…)       Power BI, Excel and Tableau "OData feed" (password = token)
 * Tokens in query strings are deliberately NOT accepted: URLs end up in logs, history and referrers.
 */
export function extractToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const m = /^(Bearer|Basic)\s+(\S+)$/i.exec(authorization.trim());
  if (!m) return null;
  let candidate = m[2];
  if (m[1].toLowerCase() === "basic") {
    try {
      const decoded = atob(candidate);
      const i = decoded.indexOf(":");
      const user = i < 0 ? decoded : decoded.slice(0, i);
      const pass = i < 0 ? "" : decoded.slice(i + 1);
      candidate = TOKEN_RE.test(pass) ? pass : user;
    } catch {
      return null;
    }
  }
  return TOKEN_RE.test(candidate) ? candidate : null;
}

export function isExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return !Number.isFinite(t) || t <= now;
}

export interface TokenInput {
  name: string;
  datasets: DatasetKey[];
  pii_mode: PiiMode;
  rate_limit_per_minute: number;
  /** null = never expires. */
  expires_in_days: number | null;
}

export function validateTokenInput(raw: unknown, opts: { isOwner: boolean }): Validation<TokenInput> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};

  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) errors.name = "Give the token a name, e.g. the report or tool that will use it.";
  else if (name.length > 80) errors.name = "Use 80 characters or fewer.";

  const list = Array.isArray(r.datasets) ? r.datasets : [];
  const datasets = [...new Set(list.filter(isDatasetKey))] as DatasetKey[];
  if (!list.length) errors.datasets = "Choose at least one dataset.";
  else if (datasets.length !== new Set(list).size) errors.datasets = "One of the selected datasets is not available.";

  const pii = (PII_MODES as readonly unknown[]).includes(r.pii_mode) ? (r.pii_mode as PiiMode) : "hashed";
  if (pii === "full" && !opts.isOwner) errors.pii_mode = "Only the account owner can issue a token with full personal data.";

  const rateRaw = r.rate_limit_per_minute === undefined ? DEFAULT_RATE_LIMIT : Number(r.rate_limit_per_minute);
  if (!Number.isInteger(rateRaw) || rateRaw < 1 || rateRaw > 600) errors.rate_limit_per_minute = "Use a whole number between 1 and 600.";

  let expires: number | null;
  if (r.expires_in_days === null) expires = null;
  else {
    expires = r.expires_in_days === undefined ? DEFAULT_EXPIRY_DAYS : Number(r.expires_in_days);
    if (!Number.isInteger(expires) || expires < 1 || expires > 730) errors.expires_in_days = "Use between 1 and 730 days, or choose “never”.";
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, datasets, pii_mode: pii, rate_limit_per_minute: rateRaw, expires_in_days: expires } };
}
