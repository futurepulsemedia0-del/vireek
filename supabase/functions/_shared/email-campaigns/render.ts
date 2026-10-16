// supabase/functions/_shared/email-campaigns/render.ts
//
// Pure (no imports, no Deno/DOM globals) so the SAME code renders the
// dashboard preview (src/lib/emailCampaigns.ts re-exports it), test sends,
// and real sends — what the user previews is byte-for-byte what is delivered.

export interface RenderVars {
  name: string;
  first_name: string;
  company_name: string;
}

export interface RenderInput {
  subject: string;
  preheader?: string | null;
  body: string;
  vars: RenderVars;
  companyName: string;
  senderAddress: string;
  /** original URL -> tracked URL. URLs missing from the map stay untracked. */
  trackedLinks?: Map<string, string>;
  openPixelUrl?: string | null;
  unsubscribeUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCT_RE = /[).,;:!?]+$/;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Removes CR/LF (header injection) and collapses whitespace. */
export function singleLine(s: string): string {
  return s.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Replaces {{name}} / {{first_name}} / {{company_name}}; unknown keys become "". */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => vars[key] ?? "");
}

export function firstNameOf(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first || "there";
}

export function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

/** Splits trailing punctuation off a matched URL ("see https://x.com/a." -> url + "."). */
function splitUrl(match: string): { url: string; trail: string } {
  const m = match.match(TRAILING_PUNCT_RE);
  if (!m) return { url: match, trail: "" };
  return { url: match.slice(0, match.length - m[0].length), trail: m[0] };
}

/** Distinct http(s) links found in a template body, in order of appearance. */
export function extractLinks(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(URL_RE)) {
    const { url } = splitUrl(match[0]);
    if (isHttpUrl(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

function linkify(text: string, tracked?: Map<string, string>): string {
  let html = "";
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const { url, trail } = splitUrl(match[0]);
    html += escapeHtml(text.slice(last, start));
    if (isHttpUrl(url)) {
      const href = tracked?.get(url) ?? url;
      html += `<a href="${escapeHtml(href)}" style="color:#2563eb">${escapeHtml(url)}</a>${escapeHtml(trail)}`;
    } else {
      html += escapeHtml(match[0]);
    }
    last = start + match[0].length;
  }
  return html + escapeHtml(text.slice(last));
}

export function renderEmail(input: RenderInput): RenderedEmail {
  const vars: Record<string, string> = { ...input.vars };
  const subject = singleLine(fillTemplate(input.subject, vars));
  const body = fillTemplate(input.body, vars).replace(/\r\n/g, "\n").trim();
  const preheader = singleLine(fillTemplate(input.preheader ?? "", vars));

  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;line-height:1.6">${linkify(p, input.trackedLinks).replace(/\n/g, "<br>")}</p>`)
    .join("");

  const company = escapeHtml(singleLine(input.companyName));
  const address = escapeHtml(singleLine(input.senderAddress));
  const unsub = escapeHtml(input.unsubscribeUrl);

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">` +
    (preheader
      ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>`
      : "") +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px">` +
    `<tr><td style="padding:32px 28px;font-size:16px">${paragraphs}</td></tr>` +
    `<tr><td style="padding:20px 28px;border-top:1px solid #e4e4e7;font-size:12px;line-height:1.5;color:#71717a">` +
    `${company}<br>${address}<br>You received this because you're a customer of ${company}. ` +
    `<a href="${unsub}" style="color:#71717a">Unsubscribe</a></td></tr>` +
    `</table></td></tr></table>` +
    (input.openPixelUrl
      ? `<img src="${escapeHtml(input.openPixelUrl)}" width="1" height="1" alt="" style="display:block;border:0">`
      : "") +
    `</body></html>`;

  const text =
    `${body}\n\n--\n${singleLine(input.companyName)}\n${singleLine(input.senderAddress)}\n` +
    `Unsubscribe: ${input.unsubscribeUrl}\n`;

  return { subject, html, text };
}
