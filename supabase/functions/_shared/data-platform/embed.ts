// supabase/functions/_shared/data-platform/embed.ts
//
// Signed embedded analytics for partners (the Metabase / Looker "signed embedding" model).
//
// The partner's SERVER holds an embed signing secret and mints a short-lived token per viewer:
//     token = v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, "v1." + payload))>
// The browser only ever sees that token (max 24 h), so no long-lived secret reaches a page, a
// token can be narrowed per viewer (filters), expires on its own, and revoking the embed kills all
// of its tokens at once. Everything a viewer can see is capped by the embed's configuration:
// allowed metrics, maximum date range, allowed breakdowns and locked filters.
//
// Pure: WebCrypto only.

import { b64url, b64urlDecode, safeEqual } from "./secrets.ts";
import {
  DIMENSIONS,
  isDimension,
  isMetricId,
  METRICS,
  parseMetricQuery,
  type Dimension,
  type Granularity,
  type MetricId,
  type MetricQuery,
} from "./metrics.ts";

export const EMBED_TOKEN_MAX_TTL_SEC = 24 * 3600;
const CLOCK_SKEW_SEC = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EmbedFilters = Partial<Record<Dimension, string[]>>;

export interface EmbedConfig {
  title: string;
  metrics: MetricId[];
  default_range_days: number;
  max_range_days: number;
  granularity: Granularity;
  allowed_group_by: Dimension[];
  locked_filters: EmbedFilters;
  tz: string;
  theme: { mode: "light" | "dark" | "auto"; accent: string };
}

export interface EmbedTokenPayload {
  eid: string;
  iat: number;
  exp: number;
  /** Partner-side viewer label, kept for audit logs only. */
  sub?: string;
  /** Extra restrictions chosen by the partner for this viewer (can only narrow the embed). */
  filters?: EmbedFilters;
}

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function signEmbedToken(secret: string, payload: EmbedTokenPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(secret, `v1.${body}`));
  return `v1.${body}.${sig}`;
}

function decodePayload(body: string): EmbedTokenPayload | null {
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!p || typeof p !== "object" || typeof p.eid !== "string" || !UUID_RE.test(p.eid)) return null;
    if (!Number.isFinite(p.iat) || !Number.isFinite(p.exp)) return null;
    return p as EmbedTokenPayload;
  } catch {
    return null;
  }
}

/** Reads the embed id WITHOUT trusting it, only to look up which secret to verify with. */
export function peekEmbedId(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  return decodePayload(parts[1])?.eid ?? null;
}

export type TokenCheck =
  | { ok: true; payload: EmbedTokenPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "not_yet_valid" | "ttl_too_long" };

export async function verifyEmbedToken(secret: string, token: string, nowSec: number): Promise<TokenCheck> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || token.length > 4096) return { ok: false, reason: "malformed" };
  const payload = decodePayload(parts[1]);
  if (!payload) return { ok: false, reason: "malformed" };
  const expected = b64url(await hmac(secret, `v1.${parts[1]}`));
  if (!safeEqual(expected, parts[2])) return { ok: false, reason: "bad_signature" };
  if (payload.exp <= nowSec - CLOCK_SKEW_SEC) return { ok: false, reason: "expired" };
  if (payload.iat > nowSec + CLOCK_SKEW_SEC) return { ok: false, reason: "not_yet_valid" };
  if (payload.exp - payload.iat > EMBED_TOKEN_MAX_TTL_SEC) return { ok: false, reason: "ttl_too_long" };
  return { ok: true, payload };
}

function cleanFilters(raw: unknown): EmbedFilters {
  const out: EmbedFilters = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDimension(k) || !Array.isArray(v)) continue;
    const vals = [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 120))].slice(0, 50);
    if (vals.length) out[k] = vals;
  }
  return out;
}

/** Intersects the embed's locked filters with a viewer's extra filters: a token can only narrow. */
export function mergeFilters(locked: EmbedFilters, extra: EmbedFilters | undefined): EmbedFilters {
  const out: EmbedFilters = { ...cleanFilters(locked) };
  for (const [dim, vals] of Object.entries(cleanFilters(extra)) as [Dimension, string[]][]) {
    const base = out[dim];
    out[dim] = base ? base.filter((v) => vals.includes(v)) : vals;
    // An empty intersection must match nothing, not everything.
    if (!out[dim]!.length) out[dim] = ["\u0000none"];
  }
  return out;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Normalises untrusted embed configuration. Never throws. */
export function sanitizeEmbedConfig(raw: unknown): { ok: true; config: EmbedConfig } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const metrics = [...new Set(Array.isArray(r.metrics) ? r.metrics.filter(isMetricId) : [])];
  if (!metrics.length) return { ok: false, error: "Choose at least one metric to share." };
  const title = typeof r.title === "string" ? r.title.trim().slice(0, 80) : "";
  const maxDays = Math.min(400, Math.max(7, Math.floor(Number(r.max_range_days) || 90)));
  const defDays = Math.min(maxDays, Math.max(1, Math.floor(Number(r.default_range_days) || 30)));
  const granularity: Granularity = ["day", "week", "month", "none"].includes(r.granularity as string) ? (r.granularity as Granularity) : "day";
  const allowed = (Array.isArray(r.allowed_group_by) ? r.allowed_group_by : []).filter(isDimension).filter((d, i, a) => a.indexOf(d) === i);
  const locked = cleanFilters(r.locked_filters);
  if (Object.keys(locked).length) {
    const bad = metrics.find((m) => !METRICS[m].dimensions.length);
    if (bad) return { ok: false, error: `"${METRICS[bad].label}" cannot be shared together with locked filters. Remove it or the filter.` };
  }
  const theme = (r.theme ?? {}) as Record<string, unknown>;
  const tzIn = typeof r.tz === "string" ? r.tz : "UTC";
  return {
    ok: true,
    config: {
      title,
      metrics,
      default_range_days: defDays,
      max_range_days: maxDays,
      granularity,
      allowed_group_by: allowed.filter((d) => DIMENSIONS.includes(d)),
      locked_filters: locked,
      tz: tzIn,
      theme: {
        mode: theme.mode === "dark" || theme.mode === "light" ? theme.mode : "auto",
        accent: typeof theme.accent === "string" && HEX_RE.test(theme.accent) ? theme.accent : "#2563eb",
      },
    },
  };
}

/** Turns a viewer request into a query that can never exceed what the embed allows. */
export function resolveEmbedQuery(
  config: EmbedConfig,
  payload: EmbedTokenPayload,
  request: Record<string, unknown>,
  now: Date,
): { ok: true; query: MetricQuery } | { ok: false; error: string } {
  const toMs = Date.parse(typeof request.to === "string" ? request.to : "");
  const to = Number.isFinite(toMs) ? Math.min(toMs, now.getTime() + 86_400_000) : now.getTime();
  const reqFrom = Date.parse(typeof request.from === "string" ? request.from : "");
  const from = Number.isFinite(reqFrom) ? reqFrom : to - config.default_range_days * 86_400_000;
  const requested = Array.isArray(request.metrics) ? request.metrics.filter(isMetricId) : config.metrics;
  const groupBy = isDimension(request.groupBy) ? request.groupBy : null;
  if (groupBy && !config.allowed_group_by.includes(groupBy)) return { ok: false, error: "That breakdown is not available in this embed." };
  const gran = ["day", "week", "month", "none"].includes(request.granularity as string) ? (request.granularity as Granularity) : config.granularity;
  const filters = mergeFilters(config.locked_filters, payload.filters);
  const parsed = parseMetricQuery(
    {
      metrics: requested.length ? requested : config.metrics,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      tz: config.tz,
      granularity: gran,
      groupBy,
      compare: request.compare === true,
      filters,
    },
    { allowedMetrics: config.metrics, maxDays: config.max_range_days },
  );
  return parsed.ok ? { ok: true, query: parsed.query } : { ok: false, error: parsed.error };
}
