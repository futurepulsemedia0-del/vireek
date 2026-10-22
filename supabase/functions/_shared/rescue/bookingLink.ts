// Pure helpers for the Rescue Loop's tracked booking link.
// Runtime-agnostic (Deno + Node/Vitest). No imports on purpose.

const SLUG_RE = /^[a-z0-9-]{3,60}$/;
const TOKEN_RE = /^[0-9a-f]{20}$/;

/**
 * https://app.example.com/book/<slug>?src=text_back&rl=<token>
 * Returns null unless slug, token and origin are all valid, so a bad value can
 * never put a broken or attacker-shaped link into a customer's text message.
 */
export function buildTrackedBookingLink(input: { siteUrl: string; slug: string | null | undefined; token: string | null | undefined; source?: string }): string | null {
  const { slug, token } = input;
  if (!slug || !SLUG_RE.test(slug)) return null;
  if (!token || !TOKEN_RE.test(token)) return null;
  let origin: string;
  try {
    const u = new URL(input.siteUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    origin = u.origin;
  } catch {
    return null;
  }
  const source = /^[a-z0-9_]{1,30}$/.test(input.source ?? "") ? input.source : "text_back";
  return `${origin}/book/${slug}?src=${source}&rl=${token}`;
}

/** Appends the link once; leaves the body untouched when the link is missing or already present. */
export function appendBookingLink(body: string, link: string | null | undefined): string {
  if (!link || body.includes(link)) return body;
  const trimmed = body.trimEnd();
  return `${trimmed}${trimmed.length > 0 ? " " : ""}Book online: ${link}`;
}

/** True when a step's SMS should carry the tracked link. */
export function wantsBookingLink(config: Record<string, unknown>): boolean {
  if (config.include_booking_link === true) return true;
  return /\{\{\s*booking_link\s*\}\}/.test(String(config.body ?? ""));
}
