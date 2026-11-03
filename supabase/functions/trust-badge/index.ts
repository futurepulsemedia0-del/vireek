// supabase/functions/trust-badge/index.ts
//
// PUBLIC endpoint behind the "Answered by Vireek" trust badge. Anonymous callers, so everything here is
// defensive: the service role is used only after strict input validation, and every claim comes from
// trust_badge_public_context() + the pure rules in src/lib/trustBadge/core.ts (unit-tested).
//
//   GET /render?k=<slug>&v=&t=&s=&c=&l=&h=<host>&dnt=   -> JSON view for public/embed/badge.v1.js (or {"s":"hidden"})
//   GET /verify?slug=<slug>&t=<signed token>             -> JSON for the public /verify/:orgSlug page (approved facts only)
//
// Secrets: TRUST_BADGE_SIGNING_SECRET (>= 32 chars, REQUIRED - fails closed without it), PUBLIC_APP_URL (default https://vireek.com).
// Deploy : supabase functions deploy trust-badge --no-verify-jwt     (also set verify_jwt = false in supabase/config.toml)
//
// Honest limits: the badge is public HTML on someone else's site and can always be copied. What cannot be faked is the
// verification page: it only confirms facts for a signed token issued to a host the account proved it owns.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  BADGE_FRESH_DAYS, BADGE_MIN_SAMPLE, BADGE_TOKEN_TTL_S, BADGE_WINDOW_DAYS,
  buildPoweredByHref, buildView, decideState, hostAllowed, hostFromOrigin, normalizeDomain,
  parseLocale, parsePalette, parseRel, parseSize, parseTheme, parseVariant, pickStat,
  signBadgeToken, verifyBadgeToken,
  type BadgeMetric, type StatInputs,
} from "../../../src/lib/trustBadge/core.ts";

const APP_URL = (Deno.env.get("PUBLIC_APP_URL") ?? "https://vireek.com").replace(/\/+$/, "");
const SECRET = Deno.env.get("TRUST_BADGE_SIGNING_SECRET") ?? "";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BASE_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Vary": "Origin",
};
const CACHE_OK = "public, max-age=60, s-maxage=300, stale-while-revalidate=3600";
const CACHE_HIDDEN = "public, max-age=60, s-maxage=300";

function reply(body: unknown, status = 200, cache = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });
}
const hidden = (cache = CACHE_HIDDEN) => reply({ s: "hidden" }, 200, cache);

async function allow(bucket: string, limit: number): Promise<boolean> {
  const { data, error } = await admin.rpc("trust_badge_hit", { p_bucket: bucket, p_limit: limit });
  if (error) return true; // fail open: a limiter outage must not take every customer's badge down (the CDN also absorbs traffic)
  return data === true;
}

async function clientBucket(req: Request): Promise<string> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return `ip:${[...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`; // never store raw IPs
}

interface Ctx {
  slug: string; enabled: boolean; displayName: string; profileStatus: string; subscriptionStatus: string;
  whiteLabel: boolean; planCategory: string | null; activeSince: string | null; metric: BadgeMetric;
  stats: { callCount: number; latestCallAt: string | null; timedCount: number; latestTimedAt: string | null; avgAnswerMs: number | null } | null;
  showPoweredBy: boolean; linkRel: string[]; cardPhone: string | null; bookingSlug: string | null; partnerCode: string | null; hosts: string[];
}

async function loadContext(slug: string): Promise<Ctx | null> {
  const { data, error } = await admin.rpc("trust_badge_public_context", { p_slug: slug });
  if (error || !data) return null;
  return data as Ctx;
}

const statInputs = (c: Ctx): StatInputs => ({
  metric: c.metric,
  callCount: c.stats?.callCount ?? 0, latestCallAt: c.stats?.latestCallAt ?? null,
  timedCount: c.stats?.timedCount ?? 0, latestTimedAt: c.stats?.latestTimedAt ?? null,
  avgAnswerMs: c.stats?.avgAnswerMs ?? null,
});

async function render(req: Request, url: URL): Promise<Response> {
  if (SECRET.length < 32) return reply({ s: "hidden", error: "not_configured" }, 503);
  const q = url.searchParams;
  const slug = q.get("k") ?? "";
  if (!SLUG_RE.test(slug)) return hidden();

  const [okIp, okSlug] = await Promise.all([allow(await clientBucket(req), 300), allow(`slug:${slug}`, 1200)]);
  if (!okIp || !okSlug) return reply({ s: "hidden", error: "rate_limited" }, 429, "no-store");

  // Domain binding. The browser sets Origin on a cross-origin fetch and page JS cannot change it; `h` is only part of the
  // CDN cache key and must agree with it.
  const originHost = hostFromOrigin(req.headers.get("origin"));
  const claimed = normalizeDomain(q.get("h") ?? "");
  const ctx = await loadContext(slug);
  if (!ctx) return hidden();
  const hostOk = !!originHost && originHost === claimed && hostAllowed(originHost, ctx.hosts);

  const state = decideState({ enabled: ctx.enabled, profileStatus: ctx.profileStatus, subscriptionStatus: ctx.subscriptionStatus, hostOk });
  if (state === "hidden") return hidden();

  const variant = parseVariant(q.get("v"));
  const now = new Date();
  const iat = Math.floor(now.getTime() / 1000);
  const token = await signBadgeToken(SECRET, { s: slug, h: originHost, i: iat, e: iat + BADGE_TOKEN_TTL_S });
  const showPowered = ctx.showPoweredBy || !ctx.whiteLabel; // re-checked here so a plan downgrade applies immediately

  const view = buildView({
    state, variant, theme: parseTheme(q.get("t")), palette: parsePalette(q.get("c")), locale: parseLocale(q.get("l")),
    stat: state === "ok" ? pickStat(statInputs(ctx), now) : null,
    verifyHref: `${APP_URL}/verify/${slug}?t=${encodeURIComponent(token)}`,
    rel: parseRel(ctx.linkRel),
    card: { phone: ctx.cardPhone, bookingUrl: ctx.bookingSlug ? `${APP_URL}/book/${encodeURIComponent(ctx.bookingSlug)}` : null },
    poweredByHref: showPowered ? buildPoweredByHref({ appUrl: APP_URL, slug, variant, partnerCode: ctx.partnerCode }) : null,
  });
  parseSize(q.get("s")); // validated for the cache key only; the loader owns sizing

  // Install heartbeat (host only - never a visitor identifier). Skipped for Do-Not-Track / Global Privacy Control.
  if (q.get("dnt") !== "1") await admin.rpc("trust_badge_touch", { p_slug: slug, p_host: originHost }).then(() => undefined, () => undefined);
  return reply(view, 200, CACHE_OK);
}

async function verify(req: Request, url: URL): Promise<Response> {
  if (SECRET.length < 32) return reply({ error: "not_configured" }, 503);
  const slug = url.searchParams.get("slug") ?? "";
  if (!SLUG_RE.test(slug)) return reply({ found: false }, 404, "public, max-age=60");
  if (!(await allow(await clientBucket(req), 120)) || !(await allow(`verify:${slug}`, 600))) return reply({ error: "rate_limited" }, 429);

  const ctx = await loadContext(slug);
  if (!ctx) return reply({ found: false }, 404, "public, max-age=60");

  const state = decideState({ enabled: ctx.enabled, profileStatus: ctx.profileStatus, subscriptionStatus: ctx.subscriptionStatus, hostOk: true });
  const tokenParam = url.searchParams.get("t");
  const check = tokenParam ? await verifyBadgeToken(SECRET, tokenParam, slug, new Date()) : null;
  const token = check
    ? check.valid
      ? { valid: true, host: check.payload.h, issuedAt: new Date(check.payload.i * 1000).toISOString(), hostVerified: hostAllowed(check.payload.h, ctx.hosts) }
      : { valid: false, reason: check.reason }
    : null;

  if (state === "hidden") return reply({ found: true, active: false, token }, 200, "public, max-age=30, s-maxage=60");

  const stat = (metric: BadgeMetric) => pickStat({ ...statInputs(ctx), metric }, new Date());
  const calls = ctx.stats ? stat("calls") : null;
  const answerTime = ctx.stats ? stat("answer_time") : null;
  return reply({
    found: true,
    active: true,
    accountInGoodStanding: state === "ok",
    displayName: ctx.displayName,
    // Only what the customer ticked on the approvals list. A missing key means "not shared", not "unknown".
    facts: {
      ...(ctx.activeSince ? { activeSince: ctx.activeSince } : {}),
      ...(ctx.planCategory ? { planCategory: ctx.planCategory } : {}),
      ...(ctx.stats ? {
        windowDays: BADGE_WINDOW_DAYS, minSample: BADGE_MIN_SAMPLE, freshDays: BADGE_FRESH_DAYS,
        callsAnswered: calls ? { count: calls.value, asOf: calls.asOf } : null,
        avgAnswerMs: answerTime ? { value: answerTime.value, asOf: answerTime.asOf } : null,
      } : {}),
    },
    domains: ctx.hosts,
    token,
  }, 200, "public, max-age=30, s-maxage=60");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: BASE_HEADERS });
  if (req.method !== "GET" && req.method !== "HEAD") return reply({ error: "method_not_allowed" }, 405);
  try {
    const url = new URL(req.url);
    const res = url.pathname.endsWith("/render") ? await render(req, url) : url.pathname.endsWith("/verify") ? await verify(req, url) : reply({ error: "not_found" }, 404);
    return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
  } catch (e) {
    console.error("trust-badge failed", e instanceof Error ? e.message : "unknown");
    return hidden("no-store"); // a broken badge must never break the host page - the loader just collapses
  }
});
