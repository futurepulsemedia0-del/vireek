// supabase/functions/_shared/billing/notices/compose.ts
// Pure message builders. All copy comes from the i18n CATALOG; all numbers from constants/inputs.
// No Deno, no I/O: unit-tested by Vitest, used by dispatch.ts.

import { DEFAULT_LANGUAGE, normalizeLanguage, type LanguageCode } from "../../i18n/languages.ts";
import { escapeHtml, formatDate, formatMoney, htmlLangAttrs, renderTemplate, textAlignStart } from "../../i18n/templates.ts";
import { minutesForPlan } from "../planCatalog.ts";

export interface ComposedNotice {
  subject: string;
  html: string;
  text: string;
  sms?: string;
}

export function noticeLanguage(value: unknown): LanguageCode {
  return normalizeLanguage(value) ?? DEFAULT_LANGUAGE;
}

export function planLabel(planId: string): string {
  return planId ? planId.charAt(0).toUpperCase() + planId.slice(1) : planId;
}

function layout(lang: LanguageCode, heading: string, bodyHtml: string, cta?: { label: string; url: string }, secondary?: { label: string; url: string }): string {
  const align = textAlignStart(lang);
  const button = cta
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:12px 24px;background:#111827;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px;">${escapeHtml(cta.label)}</a></p>`
    : "";
  const second = secondary
    ? `<p style="margin:16px 0 0;font-size:13px;"><a href="${escapeHtml(secondary.url)}" style="color:#374151;text-decoration:underline;">${escapeHtml(secondary.label)}</a></p>`
    : "";
  return `<div ${htmlLangAttrs(lang)} style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a1a;text-align:${align};"><h1 style="font-size:20px;margin:0 0 16px;">${escapeHtml(heading)}</h1><p style="font-size:15px;line-height:1.6;color:#374151;margin:0;">${bodyHtml}</p>${button}${second}</div>`;
}

const htmlBody = (s: string) => s.replace(/\n/g, "<br>");

export interface RenewalData {
  name: string;
  planId: string;
  /** Renewal calendar date "YYYY-MM-DD" on the account's own calendar. */
  renewalYmd: string;
  amountCents: number;
  currency: string;
  siteUrl: string;
}

export function composeRenewal(languageRaw: unknown, d: RenewalData): ComposedNotice {
  const lang = noticeLanguage(languageRaw);
  const minutes = minutesForPlan(d.planId);
  if (minutes === null) throw new Error(`composeRenewal: plan "${d.planId}" has no included-minutes constant`);
  const vars = {
    name: d.name,
    plan: planLabel(d.planId),
    date: formatDate(d.renewalYmd, lang),
    amount: formatMoney(d.amountCents / 100, lang, d.currency.toUpperCase()),
    minutes,
  };
  const subject = renderTemplate("billing.renewal.subject", lang, vars);
  const text = renderTemplate("billing.renewal.body", lang, vars);
  const body = renderTemplate("billing.renewal.body", lang, vars, { escape: escapeHtml });
  const cta = { label: renderTemplate("billing.notice.cta_billing", lang), url: `${d.siteUrl}/dashboard/billing` };
  // Cancelling must be one click away from the reminder itself.
  const cancel = { label: renderTemplate("billing.notice.cta_cancel", lang), url: `${d.siteUrl}/dashboard/billing/cancel` };
  return { subject, text: `${text}\n\n${cta.url}\n${cancel.label}: ${cancel.url}`, html: layout(lang, subject, htmlBody(body), cta, cancel) };
}

export interface PriceChangeData {
  name: string;
  planId: string;
  /** "YYYY-MM-DD" (date-only, formatted in UTC so the day never shifts). */
  effectiveDate: string;
  oldPriceCents: number | null;
  newPriceCents: number | null;
  oldMinutes: number | null;
  newMinutes: number | null;
  currency: string;
  siteUrl: string;
}

export function composePriceChange(languageRaw: unknown, d: PriceChangeData): ComposedNotice {
  const lang = noticeLanguage(languageRaw);
  const parts: string[] = [];
  const priceChanged = d.oldPriceCents !== null && d.newPriceCents !== null && d.newPriceCents > d.oldPriceCents;
  const limitReduced = d.oldMinutes !== null && d.newMinutes !== null && d.newMinutes < d.oldMinutes;
  if (priceChanged) {
    parts.push(
      renderTemplate("billing.price_change.summary_price", lang, {
        old_price: formatMoney((d.oldPriceCents as number) / 100, lang, d.currency.toUpperCase()),
        new_price: formatMoney((d.newPriceCents as number) / 100, lang, d.currency.toUpperCase()),
      }),
    );
  }
  if (limitReduced) {
    parts.push(renderTemplate("billing.price_change.summary_limit", lang, { old_minutes: d.oldMinutes, new_minutes: d.newMinutes }));
  }
  if (parts.length === 0) throw new Error("composePriceChange: notice describes no price increase or limit reduction");

  const base = { name: d.name, plan: planLabel(d.planId), date: formatDate(d.effectiveDate, lang) };
  const subject = renderTemplate("billing.price_change.subject", lang, base);
  const text = renderTemplate("billing.price_change.body", lang, { ...base, summary: parts.join(" ") });
  const body = renderTemplate("billing.price_change.body", lang, { ...base, summary: parts.join(" ") }, { escape: escapeHtml });
  const cta = { label: renderTemplate("billing.notice.cta_billing", lang), url: `${d.siteUrl}/dashboard/billing` };
  return { subject, text: `${text}\n\n${cta.url}`, html: layout(lang, subject, htmlBody(body), cta) };
}

export interface PaymentSuspendedData {
  name: string;
  supportEmail: string;
  siteUrl: string;
}

export function composePaymentSuspended(languageRaw: unknown, d: PaymentSuspendedData): ComposedNotice {
  const lang = noticeLanguage(languageRaw);
  const url = `${d.siteUrl}/dashboard/billing/update-payment`;
  const vars = { name: d.name, support_email: d.supportEmail };
  const subject = renderTemplate("billing.suspended.payment.subject", lang);
  const text = renderTemplate("billing.suspended.payment.body", lang, vars);
  const body = renderTemplate("billing.suspended.payment.body", lang, vars, { escape: escapeHtml });
  const cta = { label: renderTemplate("billing.notice.cta_update_payment", lang), url };
  return {
    subject,
    text: `${text}\n\n${url}`,
    html: layout(lang, subject, htmlBody(body), cta),
    sms: renderTemplate("billing.suspended.payment.sms", lang, { url }),
  };
}

export interface FraudNoticeData {
  name: string;
  status: "throttled" | "suspended";
  supportEmail: string;
  siteUrl: string;
}

/** Neutral by design: states the restriction, what keeps working and how to reach a person; never why. */
export function composeFraudNotice(languageRaw: unknown, d: FraudNoticeData): ComposedNotice {
  const lang = noticeLanguage(languageRaw);
  const vars = { name: d.name, support_email: d.supportEmail, url: `${d.siteUrl}/dashboard` };
  const subject = renderTemplate(d.status === "suspended" ? "billing.suspended.fraud.subject_suspended" : "billing.suspended.fraud.subject_throttled", lang);
  const text = renderTemplate("billing.suspended.fraud.body", lang, vars);
  const body = renderTemplate("billing.suspended.fraud.body", lang, vars, { escape: escapeHtml });
  return { subject, text, html: layout(lang, subject, htmlBody(body)) };
}
