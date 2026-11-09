// Vireek email kit — the ONE layout every transactional email goes through.
// Pure string composition (no Deno / DOM APIs) so it runs in edge functions and Vitest.
//
// Guarantees: table layout + MSO wrapper (Outlook-safe), bulletproof button, hidden preheader,
// light + dark palettes (prefers-color-scheme and Outlook.com [data-ogsc]), lang/dir for RTL,
// plain-text twin, every dynamic value escaped, links restricted to http(s)/mailto.

import type { Severity } from "../notify/routing.ts";
import { platformEndorsementLine } from "./endorsement.ts";

// ---------- design tokens (email clients can't read CSS variables) ----------
export interface Palette {
  page: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  accent: string; // button background + eyebrow
  onAccent: string; // button label
}

const LIGHT_BASE = { page: "#f1f5f9", card: "#ffffff", text: "#0f172a", muted: "#475569", border: "#e2e8f0" };
const DARK_BASE = { page: "#0b1220", card: "#111a2e", text: "#f1f5f9", muted: "#a8b3c7", border: "#24324d" };

export const LIGHT: Record<Severity, Palette> = {
  info: { ...LIGHT_BASE, accent: "#1d4ed8", onAccent: "#ffffff" },
  warning: { ...LIGHT_BASE, accent: "#b45309", onAccent: "#ffffff" },
  high: { ...LIGHT_BASE, accent: "#c2410c", onAccent: "#ffffff" },
  critical: { ...LIGHT_BASE, accent: "#b91c1c", onAccent: "#ffffff" },
};
export const DARK: Record<Severity, Palette> = {
  info: { ...DARK_BASE, accent: "#60a5fa", onAccent: "#0b1220" },
  warning: { ...DARK_BASE, accent: "#fbbf24", onAccent: "#0b1220" },
  high: { ...DARK_BASE, accent: "#fb923c", onAccent: "#0b1220" },
  critical: { ...DARK_BASE, accent: "#f87171", onAccent: "#0b1220" },
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// ---------- localized chrome (footer / labels). Body copy is supplied by each template. ----------
export interface Chrome {
  eyebrow: Record<Severity, string>;
  sentBecause: string;
  preferences: string;
  help: string;
  viewInBrowserFallback: string;
}
const CHROME_EN: Chrome = {
  eyebrow: { info: "Notice", warning: "Heads up", high: "Important", critical: "Security alert" },
  sentBecause: "You are receiving this because of activity on your Vireek account.",
  preferences: "Notification preferences",
  help: "Need help? Reply to this email or visit the Help Center.",
  viewInBrowserFallback: "If a button does not work, copy this link into your browser:",
};
const CHROME_FA: Chrome = {
  eyebrow: { info: "اطلاعیه", warning: "توجه", high: "مهم", critical: "هشدار امنیتی" },
  sentBecause: "این ایمیل به‌دلیل فعالیتی در حساب ویریک شما ارسال شده است.",
  preferences: "تنظیمات اعلان‌ها",
  help: "کمک لازم دارید؟ به این ایمیل پاسخ دهید یا به مرکز راهنما سر بزنید.",
  viewInBrowserFallback: "اگر دکمه کار نکرد، این پیوند را در مرورگر خود باز کنید:",
};
// Add a locale here as it is translated; every other locale falls back to English (see resolveLocale).
const CHROME: Record<string, Chrome> = { en: CHROME_EN, fa: CHROME_FA };
export const RTL_LOCALES = new Set(["ar", "fa", "he", "ur"]);

/** "fa-IR" -> "fa" -> "en". Never throws, never returns an unsupported tag. */
export function resolveLocale(locale: string | null | undefined, supported: Iterable<string> = Object.keys(CHROME)): string {
  const set = new Set(supported);
  const tag = (locale ?? "").trim().toLowerCase().replace("_", "-");
  if (set.has(tag)) return tag;
  const base = tag.split("-")[0];
  return set.has(base) ? base : "en";
}

// ---------- escaping & link safety ----------
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** Only http(s) and mailto survive; anything else (javascript:, data:, …) becomes "#". */
export function safeUrl(url: string): string {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : "#";
}
/** Paragraphs separated by blank lines; single newlines become <br>. */
function paragraphs(s: string, cls: string, style: string): string {
  return s
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p class="${cls}" style="margin:0 0 16px;${style}">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// ---------- contrast (used by tests to prove WCAG AA for every palette) ----------
export function contrastRatio(fg: string, bg: string): number {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// ---------- public API ----------
export interface EmailAction {
  label: string;
  url: string;
}
export interface RenderEmailInput {
  locale?: string | null;
  subject: string;
  /** Inbox preview line (≈40–90 chars). Never repeat the title verbatim. */
  preheader: string;
  title: string;
  /** Body copy; blank line = new paragraph. */
  body: string;
  severity?: Severity;
  /** Key/value facts, e.g. What / When / Where / Device. */
  facts?: Array<[string, string]>;
  action?: EmailAction;
  /** Shown under the button, e.g. "If this wasn't you, …". Optional second CTA. */
  notYou?: { text: string; action: EmailAction };
  siteUrl: string;
  /** Link to notification preferences — shown only when provided (legally required for non-transactional mail). */
  preferencesUrl?: string;
  brandName?: string;
  /** Tenant/white-label footer lines appended after the Vireek footer (already plain text). */
  extraFooterLines?: string[];
  endorsementLine?: string | null;
}
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  lang: string;
  dir: "ltr" | "rtl";
}

function button(a: EmailAction, p: Palette, cls = "btn"): string {
  const href = esc(safeUrl(a.url));
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr>` +
    `<td class="${cls}" bgcolor="${p.accent}" style="background:${p.accent};border-radius:8px;mso-padding-alt:12px 22px">` +
    `<a class="${cls}-a" href="${href}" style="display:inline-block;padding:12px 22px;font:600 15px/1.2 ${FONT};color:${p.onAccent};text-decoration:none;border-radius:8px">${esc(a.label)}</a>` +
    `</td></tr></table>`
  );
}

export function renderEmail(i: RenderEmailInput): RenderedEmail {
  const severity: Severity = i.severity ?? "info";
  const lang = resolveLocale(i.locale);
  const dir: "ltr" | "rtl" = RTL_LOCALES.has(lang) ? "rtl" : "ltr";
  const chrome = CHROME[lang] ?? CHROME_EN;
  const L = LIGHT[severity];
  const D = DARK[severity];
  const brand = i.brandName ?? "Vireek";
  const align = dir === "rtl" ? "right" : "left";

  const factsHtml = (i.facts ?? []).length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;border-top:1px solid ${L.border}" class="rule">` +
      (i.facts ?? [])
        .map(
          ([k, v]) =>
            `<tr><td class="muted rule" style="padding:10px 16px 10px 0;border-bottom:1px solid ${L.border};font:14px/1.4 ${FONT};color:${L.muted};text-align:${align}" width="34%" valign="top">${esc(k)}</td>` +
            `<td class="txt rule" style="padding:10px 0;border-bottom:1px solid ${L.border};font:600 14px/1.4 ${FONT};color:${L.text};text-align:${align}" valign="top">${esc(v)}</td></tr>`,
        )
        .join("") +
      `</table>`
    : "";

  const notYouHtml = i.notYou
    ? `<p class="txt" style="margin:0 0 12px;font:15px/1.5 ${FONT};color:${L.text}">${esc(i.notYou.text)}</p>${button(i.notYou.action, { ...L, accent: L.text, onAccent: L.card }, "btn2")}`
    : "";

  const linkFallback = i.action
    ? `<p class="muted" style="margin:0 0 16px;font:12px/1.5 ${FONT};color:${L.muted};word-break:break-all">${esc(chrome.viewInBrowserFallback)}<br>${esc(safeUrl(i.action.url))}</p>`
    : "";

  const platformBranded = !i.brandName || i.brandName === "Vireek";
  const endorsement = platformBranded ? (i.endorsementLine === undefined ? platformEndorsementLine() : i.endorsementLine) : null;
  const footerLines = [chrome.sentBecause, ...(i.extraFooterLines ?? [])];
  const footerHtml =
    footerLines.map((l) => `<p class="muted" style="margin:0 0 6px;font:12px/1.5 ${FONT};color:${L.muted}">${esc(l)}</p>`).join("") +
    `<p class="muted" style="margin:0;font:12px/1.5 ${FONT};color:${L.muted}">${esc(chrome.help)}` +
    (i.preferencesUrl ? ` · <a class="lnk" href="${esc(safeUrl(i.preferencesUrl))}" style="color:${L.muted};text-decoration:underline">${esc(chrome.preferences)}</a>` : "") +
    `</p>` + (endorsement ? `<p class="muted" style="margin:6px 0 0;font:12px/1.5 ${FONT};color:${L.muted}">${esc(endorsement)}</p>` : "");

  const dark = (P: Palette) =>
    `.pg{background:${P.page}!important}.card{background:${P.card}!important}.txt{color:${P.text}!important}.muted,.lnk{color:${P.muted}!important}` +
    `.rule{border-color:${P.border}!important}.eyebrow{color:${P.accent}!important}` +
    `.btn{background:${P.accent}!important}.btn-a{color:${P.onAccent}!important}.btn2{background:${P.text}!important}.btn2-a{color:${P.card}!important}`;

  const html =
    `<!doctype html><html lang="${lang}" dir="${dir}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="x-apple-disable-message-reformatting">` +
    `<title>${esc(i.subject)}</title>` +
    `<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->` +
    `<style>:root{color-scheme:light dark;supported-color-schemes:light dark}body{margin:0;padding:0;-webkit-text-size-adjust:100%}` +
    `@media (max-width:600px){.wrap{width:100%!important}.pad{padding:24px 20px!important}}` +
    `@media (prefers-color-scheme:dark){${dark(D)}}[data-ogsc] .pg{background:${D.page}!important}[data-ogsc] .card{background:${D.card}!important}[data-ogsc] .txt{color:${D.text}!important}[data-ogsc] .muted{color:${D.muted}!important}` +
    `</style></head>` +
    `<body class="pg" style="margin:0;padding:0;background:${L.page}">` +
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${L.page};opacity:0">${esc(i.preheader)}${"&nbsp;&zwnj;".repeat(40)}</div>` +
    `<table role="presentation" class="pg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${L.page}" style="background:${L.page}"><tr><td align="center" style="padding:24px 12px">` +
    `<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->` +
    `<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">` +
    `<tr><td style="padding:0 4px 16px;text-align:${align};font:700 20px/1 ${FONT};letter-spacing:-.02em"><a href="${esc(safeUrl(i.siteUrl))}" class="txt" style="color:${L.text};text-decoration:none">${esc(brand)}</a></td></tr>` +
    `<tr><td class="card pad" bgcolor="${L.card}" style="background:${L.card};border:1px solid ${L.border};border-radius:12px;padding:32px;text-align:${align}">` +
    `<p class="eyebrow" style="margin:0 0 8px;font:700 12px/1 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${L.accent}">${esc(chrome.eyebrow[severity])}</p>` +
    `<h1 class="txt" style="margin:0 0 16px;font:700 22px/1.3 ${FONT};color:${L.text}">${esc(i.title)}</h1>` +
    paragraphs(i.body, "txt", `font:15px/1.6 ${FONT};color:${L.text}`) +
    factsHtml +
    (i.action ? button(i.action, L) : "") +
    linkFallback +
    notYouHtml +
    `</td></tr>` +
    `<tr><td style="padding:16px 4px 0;text-align:${align}">${footerHtml}</td></tr>` +
    `</table><!--[if mso]></td></tr></table><![endif]-->` +
    `</td></tr></table></body></html>`;

  const text =
    `${i.title}\n\n${i.body.trim()}\n` +
    ((i.facts ?? []).length ? `\n${(i.facts ?? []).map(([k, v]) => `${k}: ${v}`).join("\n")}\n` : "") +
    (i.action ? `\n${i.action.label}: ${safeUrl(i.action.url)}\n` : "") +
    (i.notYou ? `\n${i.notYou.text}\n${i.notYou.action.label}: ${safeUrl(i.notYou.action.url)}\n` : "") +
    `\n--\n${footerLines.join("\n")}\n${chrome.help}` +
    (i.preferencesUrl ? `\n${chrome.preferences}: ${safeUrl(i.preferencesUrl)}` : "") +
    (endorsement ? `\n${endorsement}` : "") +
    `\n`;

  return { subject: i.subject, html, text, lang, dir };
}
