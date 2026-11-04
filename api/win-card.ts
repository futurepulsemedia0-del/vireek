// api/win-card.ts — Vercel Edge route for Win Cards.
//
// Why this exists: /win/:token is a SPA route, but Facebook / LinkedIn / X / Slack / Teams crawlers do not run
// JavaScript, and Supabase edge functions rewrite text/html to text/plain on *.supabase.co. So crawlers are
// rewritten here (see vercel.json) and get real HTML with OG tags, and card images are proxied from the
// brand domain so og:image points at app.vireek.com rather than a *.supabase.co URL.
//
//   GET /api/win-card?t=TOKEN                 → crawler HTML (OG/Twitter tags, noindex)
//   GET /api/win-card?t=TOKEN&img=og|square|story[&fmt=svg|png][&theme=…][&anim=1]  → image proxy
//
// Env (optional): WIN_CARD_FUNCTIONS_URL (default: this project's Supabase functions URL)

import { buildOgHtml, OG_NOT_FOUND_HTML } from "../supabase/functions/_shared/win-cards/og.ts";
import { isValidToken } from "../supabase/functions/_shared/win-cards/token.ts";
import type { PublicFields } from "../supabase/functions/_shared/win-cards/types.ts";

export const config = { runtime: "edge" };

const FN = (process.env.WIN_CARD_FUNCTIONS_URL ?? "https://tagpfcwwxnmsmjneciqh.supabase.co/functions/v1").replace(/\/$/, "") + "/win-card-public";
const html = (body: string, status: number, cache: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cache, "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } });

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  if (!isValidToken(token)) return html(OG_NOT_FOUND_HTML, 404, "public, max-age=60");
  const origin = `${url.protocol}//${url.host}`;

  const img = url.searchParams.get("img");
  if (img) {
    if (!["og", "square", "story"].includes(img)) return new Response("Bad request", { status: 400 });
    const q = new URLSearchParams({ t: token, img });
    for (const k of ["fmt", "theme", "anim"]) { const v = url.searchParams.get(k); if (v) q.set(k, v); }
    const up = await fetch(`${FN}?${q.toString()}`).catch(() => null);
    if (!up) return new Response("Upstream unavailable", { status: 502 });
    const h = new Headers();
    for (const k of ["content-type", "cache-control", "retry-after"]) { const v = up.headers.get(k); if (v) h.set(k, v); }
    h.set("X-Content-Type-Options", "nosniff");
    h.set("X-Robots-Tag", "noindex, nofollow");
    if ((h.get("content-type") ?? "").includes("svg")) h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    return new Response(up.body, { status: up.status, headers: h });
  }

  const up = await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action: "get", peek: true }) }).catch(() => null);
  if (!up || up.status === 404) return html(OG_NOT_FOUND_HTML, 404, "public, max-age=60");
  if (!up.ok) return html(OG_NOT_FOUND_HTML, 502, "no-store");
  const data = (await up.json()) as { card: { publicFields: PublicFields }; brand: { whiteLabel: boolean; brandName: string | null } };
  const siteName = data.brand.whiteLabel ? data.brand.brandName ?? "" : "Vireek";
  return html(
    buildOgHtml({ pub: data.card.publicFields, pageUrl: `${origin}/win/${token}`, imageUrl: `${origin}/api/win-card?t=${token}&img=og`, siteName }),
    200,
    "public, max-age=60, s-maxage=300",
  );
}
