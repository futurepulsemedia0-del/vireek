// supabase/functions/_shared/win-cards/og.ts
// Minimal crawler-facing HTML for /win/:token (served by the Vercel edge route, because Supabase edge
// functions rewrite text/html to text/plain on *.supabase.co). Built from PublicFields only.

import { xmlEscape } from "./render.ts";
import { altText } from "./render.ts";
import type { PublicFields } from "./types.ts";

export interface OgInput {
  pub: PublicFields;
  pageUrl: string;   // https://app.vireek.com/win/<token>
  imageUrl: string;  // https://app.vireek.com/api/win-card?t=<token>&img=og
  siteName: string;  // "Vireek" or the white-label brand
}

export function buildOgHtml({ pub, pageUrl, imageUrl, siteName }: OgInput): string {
  const title = xmlEscape(pub.headline);
  const desc = xmlEscape([pub.detail, pub.valueText].filter(Boolean).join(" ") || pub.headline);
  const alt = xmlEscape(altText(pub));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="${desc}">
<link rel="canonical" href="${xmlEscape(pageUrl)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${xmlEscape(siteName)}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${xmlEscape(pageUrl)}">
<meta property="og:image" content="${xmlEscape(imageUrl)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${alt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${xmlEscape(imageUrl)}">
</head><body><main><h1>${title}</h1><p>${desc}</p></main></body></html>`;
}

/** Same page, for a missing/expired/revoked token: no content, no OG image, noindex, HTTP 404 at the caller. */
export const OG_NOT_FOUND_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>This card is no longer available</title><meta name="robots" content="noindex, nofollow"></head><body><p>This card is no longer available.</p></body></html>`;
