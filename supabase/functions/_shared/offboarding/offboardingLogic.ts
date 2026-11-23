// supabase/functions/_shared/offboarding/offboardingLogic.ts
//
// Pure logic for the opt-in win-back sequence (no Deno, no I/O: unit-tested by Vitest, used by
// supabase/functions/offboarding-sweep). Timing is owned by SQL (offboarding_set_winback_consent);
// this file decides "should this claimed message still go out?" and builds the email.
//
// Win-back is MARKETING to the account owner: every message carries an unsubscribe link and the
// sender's postal address, and the sweep refuses to send at all while the address is not configured.
// [COUNSEL] wording, sender identity, postal address and per-country rules are NOT decided here.

import { escapeHtml, formatDate } from "../i18n/templates.ts";

export const CONSENT_VERSION = "winback-v1";
export const MAX_WINBACK_MESSAGES = 2;

export type WinbackSeq = 1 | 2;

export interface ClaimedMessage {
  message_id: string;
  case_id: string;
  user_id: string;
  seq: number;
  unsubscribe_token: string;
  access_ends_at: string;
  reason: string | null;
}

export interface WinbackOwner {
  email: string | null;
  name: string;
  companyName: string | null;
  status: string | null;
  subscriptionStatus: string | null;
}

export interface WinbackContext {
  owner: WinbackOwner | null;
  /** True when an active/processing/completed full_account deletion_request exists for the account. */
  deletionRequested: boolean;
}

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isWinbackSeq = (n: unknown): n is WinbackSeq => n === 1 || n === 2;

/**
 * Re-checked at send time, because the world moves between consent and delivery.
 * Returns the skip reason (stored on the message) or null when the message may be sent.
 */
export function winbackSkipReason(msg: Pick<ClaimedMessage, "seq" | "unsubscribe_token">, ctx: WinbackContext): string | null {
  if (!isWinbackSeq(msg.seq)) return "invalid_sequence";
  if (!UUID_RE.test(msg.unsubscribe_token)) return "invalid_token";
  if (!ctx.owner) return "account_gone";
  if (ctx.deletionRequested) return "deletion_requested";
  if (ctx.owner.status === "active" && ctx.owner.subscriptionStatus === "active") return "already_active";
  if (!ctx.owner.email || !EMAIL_RE.test(ctx.owner.email)) return "no_email";
  return null;
}

export interface WinbackEmailInput {
  seq: WinbackSeq;
  name: string;
  reason: string | null;
  accessEndsAt: string;
  siteUrl: string;
  unsubscribeToken: string;
  postalAddress: string;
  supportEmail: string;
}

export interface WinbackEmail {
  subject: string;
  html: string;
  text: string;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

export function unsubscribeUrl(siteUrl: string, token: string): string {
  return `${trimSlash(siteUrl)}/winback/unsubscribe/${encodeURIComponent(token)}`;
}

/** One reason-specific sentence. Never a discount, a feature promise or a deadline we cannot keep. */
export function reasonLine(reason: string | null): string {
  switch (reason) {
    case "too_expensive":
      return "You mentioned the price was the sticking point. If that is still true, reply and tell us what would have made it work. We read every answer.";
    case "missing_features":
      return "You mentioned something was missing. If you reply with what it was, we will read it. No sales follow-up, just a note.";
    case "technical_issues":
      return "You mentioned something did not work properly. If you reply with what happened, we would rather know than guess.";
    case "switching":
      return "You mentioned you were moving to something else. If it is not working out, you are welcome back. And if it is, we would still like to hear what it does better.";
    case "not_using":
      return "You mentioned you were not using it much. That is useful to know, and a fair reason to leave.";
    case "closing_business":
      return "You mentioned the business is winding down. We are sorry to hear it, and nothing here needs anything from you.";
    default:
      return "";
  }
}

/** Plain, short, human. No urgency tricks; message 2 says plainly that it is the last one. */
export function composeWinback(input: WinbackEmailInput): WinbackEmail {
  const ended = formatDate(input.accessEndsAt, "en");
  const name = input.name.trim() || "there";
  const billing = `${trimSlash(input.siteUrl)}/dashboard/billing`;
  const offboarding = `${trimSlash(input.siteUrl)}/dashboard/billing/offboarding`;
  const unsub = unsubscribeUrl(input.siteUrl, input.unsubscribeToken);
  const why = input.seq === 1 ? reasonLine(input.reason) : "";
  const closing = input.reason === "closing_business";

  const subject = input.seq === 1 ? "A short note now that your Vireek access has ended" : "Our last note about Vireek";

  const paragraphs: string[] =
    input.seq === 1
      ? [
          `Hi ${name},`,
          `Your Vireek access ended on ${ended}. When you cancelled you asked us to check in, so this is that note. You will get at most one more after it.`,
          ...(why ? [why] : []),
          `If you have not downloaded your data yet, you can still sign in and use the export page: ${offboarding}`,
          ...(closing ? [] : [`If you want to come back, you can reactivate from Billing: ${billing}`]),
          "The Vireek team",
        ]
      : [
          `Hi ${name},`,
          "This is the second and last message we will send about this. After it, we will leave you alone unless you write to us.",
          ...(closing ? [] : [`If you ever want Vireek again, you can reactivate from Billing: ${billing}`]),
          `If something about your account still needs sorting out, reply to this email or write to ${input.supportEmail}.`,
          "The Vireek team",
        ];

  const footer = [
    `You are receiving this because you chose to hear from us when you cancelled. This is message ${input.seq} of ${MAX_WINBACK_MESSAGES}.`,
    `Unsubscribe: ${unsub}`,
    input.postalAddress,
  ];

  const text = `${paragraphs.join("\n\n")}\n\n--\n${footer.join("\n")}`;

  const linkify = (p: string) =>
    escapeHtml(p).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" style="color:#1c1b15;">${u}</a>`);
  const html =
    `<div lang="en" style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1c1b15;font-size:15px;line-height:1.6;">` +
    paragraphs.map((p) => `<p style="margin:0 0 16px;">${linkify(p)}</p>`).join("") +
    `<hr style="border:none;border-top:1px solid #e6e5df;margin:28px 0 14px;">` +
    `<p style="margin:0;font-size:12px;line-height:1.5;color:#73726c;">${escapeHtml(footer[0])}<br>` +
    `<a href="${escapeHtml(unsub)}" style="color:#73726c;">Unsubscribe</a><br>${escapeHtml(footer[2])}</p></div>`;

  return { subject, html, text };
}
