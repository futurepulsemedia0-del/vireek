// supabase/functions/win-card-public/index.ts
//
// Public (no-auth) endpoint behind /win/:token.
//   POST { token, action: "get", peek?: true }          → public payload for the page (peek = don't count a view)
//   POST { token, action: "report", reason, detail? }   → abuse report (hashed reporter, auto-suspend at 3)
//   POST { token, action: "cta" }                       → counts the click, returns the attributed CTA URL
//   GET  ?t=TOKEN&img=og|square|story&theme=light|dark&anim=1&fmt=png|svg   → card image
//
// It can read ONLY win_cards.public_fields (+ brand switches). private_facts is never selected.
// A card is served only if: status='approved' AND expires_at > now() AND the account has Win Cards
// enabled AND not staff-locked. Revoke / expiry / disable therefore take effect on the next request.
//
// DEPLOYMENT: supabase functions deploy win-card-public --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SITE_URL, WIN_CARD_HASH_SALT,
//      WIN_CARD_FONT_URLS (comma-separated TTF/OTF URLs; REQUIRED for PNG output — see rasterize()).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { cleanText } from "../_shared/win-cards/redact.ts";
import { FORMATS, renderCardSvg } from "../_shared/win-cards/render.ts";
import { isValidToken, reporterHash } from "../_shared/win-cards/token.ts";
import type { CardFormat, PublicFields, Theme } from "../_shared/win-cards/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
const NOT_FOUND = () => json({ error: "NOT_FOUND" }, 404);

const siteUrl = () => (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
const admin = () => createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

// Best-effort per-isolate limiter (the CDN + token entropy are the real shields; this blunts a single noisy client).
const buckets = new Map<string, { n: number; reset: number }>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); if (buckets.size > 5000) buckets.clear(); return false; }
  b.n += 1;
  return b.n > max;
}
const clientIp = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";

interface ActiveCard {
  id: string; trigger_type: string; public_fields: PublicFields; theme: Theme; attribution_ref: string | null; expires_at: string; user_id: string;
  brand: { whiteLabel: boolean; brandName: string | null; accent: string | null };
}

async function loadActive(token: string): Promise<ActiveCard | null> {
  const db = admin();
  const { data: card } = await db.from("win_cards")
    .select("id,user_id,trigger_type,public_fields,theme,attribution_ref,expires_at")     // NOTE: no private_facts
    .eq("token", token).eq("status", "approved").gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!card) return null;
  const c = card as Omit<ActiveCard, "brand">;
  const { data: s } = await db.from("win_card_settings").select("enabled,staff_locked,white_label,brand_name,accent_color").eq("user_id", c.user_id).maybeSingle();
  const st = s as { enabled: boolean; staff_locked: boolean; white_label: boolean; brand_name: string | null; accent_color: string | null } | null;
  if (st && (!st.enabled || st.staff_locked)) return null;
  return { ...c, brand: { whiteLabel: st?.white_label ?? false, brandName: st?.brand_name ?? null, accent: st?.accent_color ?? null } };
}

// ------------------------------------------------------------------ PNG rasterisation (needed by OG crawlers)
//
// resvg-wasm cannot draw text without fonts, so we REFUSE to emit a PNG unless fonts loaded (a blank-text PNG
// would be worse than a clear 503). Fonts and wasm are cached per isolate.
let resvgReady: Promise<{ Resvg: new (svg: string, opts: unknown) => { render(): { asPng(): Uint8Array } }; fonts: Uint8Array[] }> | null = null;
function initResvg() {
  resvgReady ??= (async () => {
    const mod = await import("npm:@resvg/resvg-wasm@2.6.2");
    const wasm = await fetch("https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm");
    if (!wasm.ok) throw new Error("wasm_fetch_failed");
    await mod.initWasm(wasm);
    const urls = (Deno.env.get("WIN_CARD_FONT_URLS") ?? "").split(",").map((u) => u.trim()).filter(Boolean);
    if (!urls.length) throw new Error("no_fonts_configured");
    const fonts = await Promise.all(urls.map(async (u) => { const r = await fetch(u); if (!r.ok) throw new Error("font_fetch_failed"); return new Uint8Array(await r.arrayBuffer()); }));
    return { Resvg: mod.Resvg as never, fonts };
  })().catch((e) => { resvgReady = null; throw e; });
  return resvgReady;
}
async function toPng(svg: string, width: number): Promise<Uint8Array> {
  const { Resvg, fonts } = await initResvg();
  return new Resvg(svg, { fitTo: { mode: "width", value: width }, font: { fontBuffers: fonts, defaultFontFamily: "Inter", loadSystemFonts: false } }).render().asPng();
}

async function handleImage(req: Request, url: URL): Promise<Response> {
  const ip = clientIp(req);
  if (limited(`img:${ip}`, 60, 60_000)) return new Response("Too many requests", { status: 429, headers: { ...corsHeaders, "Retry-After": "60" } });
  const token = url.searchParams.get("t");
  if (!isValidToken(token)) return new Response("Not found", { status: 404, headers: corsHeaders });
  const fmtRaw = url.searchParams.get("img") ?? "og";
  if (!(fmtRaw in FORMATS)) return new Response("Bad request", { status: 400, headers: corsHeaders });
  const format = fmtRaw as CardFormat;
  const card = await loadActive(token);
  if (!card) return new Response("Not found", { status: 404, headers: corsHeaders });

  const themeQ = url.searchParams.get("theme");
  const theme: Theme = themeQ === "dark" || themeQ === "light" ? themeQ : card.theme;
  const svg = renderCardSvg(card.public_fields, {
    format, theme, animated: url.searchParams.get("anim") === "1", whiteLabel: card.brand.whiteLabel, brandName: card.brand.brandName,
    accent: card.brand.accent, seed: card.attribution_ref ?? card.id.slice(0, 8),
  });
  // Short CDN TTL so a revoke / expiry / org-disable is honoured quickly even for cached images.
  const cache = "public, max-age=60, s-maxage=300";
  const common = { ...corsHeaders, "Cache-Control": cache, "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" };
  if (url.searchParams.get("fmt") === "svg") return new Response(svg, { headers: { ...common, "Content-Type": "image/svg+xml; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
  try {
    const png = await toPng(svg, FORMATS[format].w);
    return new Response(png, { headers: { ...common, "Content-Type": "image/png" } });
  } catch (e) {
    console.error(JSON.stringify({ event: "win_card_png_failed", error: e instanceof Error ? e.message : String(e) }));
    return new Response("Image renderer unavailable", { status: 503, headers: { ...corsHeaders, "Retry-After": "300" } });
  }
}

const REASONS = ["contains_personal_info", "inaccurate", "spam_or_abuse", "other"] as const;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  const url = new URL(req.url);
  try {
    if (req.method === "GET") return await handleImage(req, url);
    if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!isValidToken(body.token)) return NOT_FOUND();
    const token = body.token;
    const ip = clientIp(req);
    if (limited(`api:${ip}`, 120, 60_000)) return json({ error: "RATE_LIMITED" }, 429, { "Retry-After": "60" });

    const card = await loadActive(token);
    if (!card) return NOT_FOUND();

    if (body.action === "get") {
      // Best-effort view counter (lost updates under a race are harmless). `peek` (crawler/OG fetches) never counts.
      if (body.peek !== true) {
        const db = admin();
        const { data: cur } = await db.from("win_cards").select("view_count").eq("id", card.id).maybeSingle();
        await db.from("win_cards").update({ view_count: ((cur as { view_count: number } | null)?.view_count ?? 0) + 1 }).eq("id", card.id);
      }
      return json({
        card: { publicFields: card.public_fields, theme: card.theme, expiresAt: card.expires_at },
        brand: card.brand,
        // White-label cards never point at Vireek marketing.
        cta: card.public_fields.showCta && !card.brand.whiteLabel,
      });
    }

    if (body.action === "cta") {
      if (card.brand.whiteLabel || !card.public_fields.showCta) return NOT_FOUND();
      const db = admin();
      const { data: cur } = await db.from("win_cards").select("cta_count").eq("id", card.id).maybeSingle();
      await db.from("win_cards").update({ cta_count: ((cur as { cta_count: number } | null)?.cta_count ?? 0) + 1 }).eq("id", card.id);
      const q = new URLSearchParams({ utm_source: "win_card", utm_medium: "share", utm_campaign: card.trigger_type, ref: `wc_${card.attribution_ref ?? ""}` });
      return json({ url: `${siteUrl()}/?${q.toString()}` });
    }

    if (body.action === "report") {
      if (limited(`rep:${ip}`, 5, 3_600_000)) return json({ error: "RATE_LIMITED" }, 429, { "Retry-After": "3600" });
      const reason = body.reason;
      if (typeof reason !== "string" || !(REASONS as readonly string[]).includes(reason)) return json({ error: "INVALID_REASON" }, 400);
      const detail = typeof body.detail === "string" ? cleanText(body.detail, 500) : null;
      const hash = await reporterHash(ip, req.headers.get("user-agent") ?? "", Deno.env.get("WIN_CARD_HASH_SALT") ?? "");
      const db = admin();
      const { data, error } = await db.rpc("win_card_report", { p_card_id: card.id, p_hash: hash, p_reason: reason, p_detail: detail });
      if (error) { console.error(JSON.stringify({ event: "win_card_report_failed", error: error.message })); return json({ error: "INTERNAL" }, 500); }
      if (data === "recorded" || data === "suspended") {
        await db.rpc("log_audit_event", { p_user_id: card.user_id, p_action: data === "suspended" ? "win_card_suspended_by_reports" : "win_card_reported", p_target_table: "win_cards", p_target_id: card.id, p_metadata: { reason } });
      }
      // Same answer for new and duplicate reports — nothing about the card's state is revealed to the reporter.
      return json({ ok: true });
    }

    return json({ error: "UNKNOWN_ACTION" }, 400);
  } catch (e) {
    console.error(JSON.stringify({ event: "win_card_public_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "INTERNAL" }, 500);
  }
});
