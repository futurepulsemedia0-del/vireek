// supabase/functions/_shared/http/cors.ts
// Single source of truth for CORS in edge functions.
//
//  - Browser-facing functions:   Deno.serve(withCors(async (req) => { ... }))
//  - Server-to-server functions (webhooks, cron, API-key): send NO CORS headers at all.
//                                 Use rejectPreflight(req) so a browser preflight gets a plain 405.
//
// Allowlist (env, comma-separated, exact origins only):
//   CORS_ALLOWED_ORIGINS          e.g. https://vireek.com,https://app.vireek.com
//   CORS_PREVIEW_ORIGIN_PATTERNS  e.g. https://vireek-*.vercel.app   (one "*" = ONE DNS label, https only)
//   CORS_ALLOW_LOCALHOST=true     adds http://localhost:* / http://127.0.0.1:* (dev only; never set in production)
// SITE_URL's origin is always allowed. Nothing configured => only SITE_URL (fail closed, never "*").

const BASE_ALLOW_HEADERS = "Content-Type, Authorization, X-Client-Info, Apikey";

export interface CorsOptions {
  methods?: string;
  allowHeaders?: string;
  maxAgeSeconds?: number;
}

function envGet(name: string): string {
  return (Deno.env.get(name) ?? "").trim();
}
// Native-app WebView origins (Capacitor iOS / Ionic). `new URL(...).origin` is "null" for these, so they are matched
// literally and only when listed in CORS_ALLOWED_ORIGINS. (Capacitor Android uses https://localhost: list it as-is.)
const NATIVE_ORIGINS = new Set(["capacitor://localhost", "ionic://localhost"]);

function normalizeOrigin(raw: string): string | null {
  const lit = raw.trim().toLowerCase();
  if (NATIVE_ORIGINS.has(lit)) return lit;
  try {
function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin; // strips path, lowercases host, drops default port
  } catch {
    return null;
  }
}

function splitList(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function allowedOrigins(): Set<string> {
  const out = new Set<string>();
  const site = normalizeOrigin(envGet("SITE_URL"));
  if (site) out.add(site);
  for (const o of splitList(envGet("CORS_ALLOWED_ORIGINS"))) {
    if (o === "*" || o.includes("*")) continue; // wildcards are never accepted here
    const n = normalizeOrigin(o);
    if (n) out.add(n);
  }
  return out;
}

/** "https://vireek-*.vercel.app" -> matches exactly one DNS label in place of "*", https only. */
export function patternToRegExp(pattern: string): RegExp | null {
  const p = pattern.trim().toLowerCase();
  if (!p.startsWith("https://") || (p.match(/\*/g) ?? []).length !== 1) return null;
  const host = p.slice("https://".length);
  if (host.includes("/") || host.includes(":")) return null;
  const escaped = host.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^https://${escaped[0]}[a-z0-9]([a-z0-9-]*[a-z0-9])?${escaped[1]}$`);
}

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin || origin === "null") return false;
  const n = normalizeOrigin(origin);
  if (!n || n !== origin.toLowerCase().replace(/\/$/, "")) return false; // reject origins with paths/odd forms
  if (allowedOrigins().has(n)) return true;
  for (const p of splitList(envGet("CORS_PREVIEW_ORIGIN_PATTERNS"))) {
    const re = patternToRegExp(p);
    if (re && re.test(n)) return true;
  }
  if (envGet("CORS_ALLOW_LOCALHOST") === "true" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(n)) return true;
  return false;
}

/** CORS response headers for a browser-facing function. Disallowed/missing Origin => no Allow-Origin header. */
export function corsFor(req: Request, opts: CorsOptions = {}): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" };
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) return headers;
  headers["Access-Control-Allow-Origin"] = origin as string;
  headers["Access-Control-Allow-Methods"] = opts.methods ?? "POST, OPTIONS";
  headers["Access-Control-Allow-Headers"] = opts.allowHeaders ?? BASE_ALLOW_HEADERS;
  headers["Access-Control-Max-Age"] = String(opts.maxAgeSeconds ?? 600);
  return headers;
}

/** Answers OPTIONS. 204 for an allowed origin, 403 for a denied one. Returns null for non-OPTIONS requests. */
export function preflight(req: Request, opts: CorsOptions = {}): Response | null {
  if (req.method !== "OPTIONS") return null;
  const headers = corsFor(req, opts);
  const ok = "Access-Control-Allow-Origin" in headers;
  return new Response(null, { status: ok ? 204 : 403, headers });
}

/** Server-to-server endpoints: no CORS headers, ever. A browser preflight gets a bare 405. */
export function rejectPreflight(req: Request): Response | null {
  return req.method === "OPTIONS" ? new Response(null, { status: 405 }) : null;
}

/**
 * Wraps a browser-facing handler: answers preflight and adds the allowlisted CORS headers to EVERY response
 * (including errors). The handler itself must not set Access-Control-* headers.
 */
export function withCors(handler: (req: Request) => Response | Promise<Response>, opts: CorsOptions = {}) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req, opts);
    if (pre) return pre;
    const res = await handler(req);
    const extra = corsFor(req, opts);
    try {
      for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
      return res;
    } catch {
      // Responses produced by fetch() (proxied upstream bodies) have immutable headers: rebuild instead of failing.
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(extra)) headers.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
  };
}

/** Drop-in for `Deno.serve(handler)` in browser-facing functions (used by scripts/security/cors-codemod.mjs). */
export function serveWithCors(opts: CorsOptions, handler: (req: Request) => Response | Promise<Response>) {
  return Deno.serve(withCors(handler, opts));
}
