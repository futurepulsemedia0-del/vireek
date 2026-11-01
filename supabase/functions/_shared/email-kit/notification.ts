// One notification schema for toast, in-app, push, SMS and email.
// Producers build a UnifiedNotification once; each channel adapter derives its payload from it,
// so voice, severity and deep link can't drift between channels.
// Keep the Severity union in sync with ../notify/routing.ts and src/lib/notificationRouting.ts.

import type { Severity } from "../notify/routing.ts";
import { renderEmail, safeUrl, type RenderedEmail } from "./layout.ts";

export interface UnifiedNotification {
  title: string;
  body: string;
  severity: Severity;
  /** Primary action. `url` may be an in-app path ("/dashboard/settings/security") or absolute https URL. */
  action?: { label: string; url: string };
  /** What/When/Where facts (email table, in-app detail rows). */
  facts?: Array<[string, string]>;
  /** Short inbox preview for email. Falls back to the body's first sentence. */
  preheader?: string;
  /** "If this wasn't you" escape hatch (security events). */
  notYou?: { text: string; action: { label: string; url: string } };
}

export type ToastTone = "info" | "warning" | "error";

export function toAbsoluteUrl(urlOrPath: string, siteUrl: string): string {
  if (/^https?:\/\//i.test(urlOrPath)) return safeUrl(urlOrPath);
  if (urlOrPath.startsWith("/") && !urlOrPath.startsWith("//")) return `${siteUrl.replace(/\/$/, "")}${urlOrPath}`;
  return "#";
}

const firstSentence = (s: string, max = 90): string => {
  const one = s.replace(/\s+/g, " ").trim();
  const cut = one.split(/(?<=[.!?])\s/)[0] ?? one;
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
};

export function toToast(n: UnifiedNotification): { tone: ToastTone; title: string; message: string; actionLabel?: string; href?: string } {
  return {
    tone: n.severity === "info" ? "info" : n.severity === "warning" ? "warning" : "error",
    title: n.title,
    message: firstSentence(n.body, 140),
    actionLabel: n.action?.label,
    href: n.action?.url,
  };
}

/** Push: short title/body + deep link in `data.url`. */
export function toPush(n: UnifiedNotification, siteUrl: string): { title: string; body: string; data: { url: string; severity: Severity } } {
  return {
    title: n.title.slice(0, 65),
    body: firstSentence(n.body, 160),
    data: { url: toAbsoluteUrl(n.action?.url ?? "/dashboard", siteUrl), severity: n.severity },
  };
}

/** SMS: single segment target (≤160 chars); the link is kept whole, the body is trimmed. */
export function toSms(n: UnifiedNotification, siteUrl: string, max = 160): string {
  const link = n.action ? ` ${toAbsoluteUrl(n.action.url, siteUrl)}` : "";
  const head = `Vireek: ${n.title}. `;
  const room = Math.max(0, max - head.length - link.length);
  const body = firstSentence(n.body, room);
  return `${head}${room > 8 ? body : ""}${link}`.replace(/\s+$/, "").slice(0, Math.max(max, head.length + link.length));
}

export function toEmail(
  n: UnifiedNotification,
  ctx: { siteUrl: string; locale?: string | null; preferencesUrl?: string; subject?: string; extraFooterLines?: string[] },
): RenderedEmail {
  return renderEmail({
    locale: ctx.locale,
    subject: ctx.subject ?? n.title,
    preheader: n.preheader ?? firstSentence(n.body),
    title: n.title,
    body: n.body,
    severity: n.severity,
    facts: n.facts,
    action: n.action ? { label: n.action.label, url: toAbsoluteUrl(n.action.url, ctx.siteUrl) } : undefined,
    notYou: n.notYou ? { text: n.notYou.text, action: { label: n.notYou.action.label, url: toAbsoluteUrl(n.notYou.action.url, ctx.siteUrl) } } : undefined,
    siteUrl: ctx.siteUrl,
    preferencesUrl: ctx.preferencesUrl,
    extraFooterLines: ctx.extraFooterLines,
  });
}

// ---------- logging hygiene ----------
/** Masks emails, bearer/JWT-looking tokens, long hex/base64 blobs and phone numbers before anything is logged. */
export function scrubForLog(s: string): string {
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[jwt]")
    .replace(/\b(?:sk|pk|rk|re|whsec)_[A-Za-z0-9_]{8,}/g, "[secret]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[hex]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]");
}
