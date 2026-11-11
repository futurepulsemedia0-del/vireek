// supabase/functions/_shared/billing/trialEmail.ts
//
// Pure builder for the "your trial ends soon" email (sent on Stripe's customer.subscription.trial_will_end,
// which Stripe fires ~3 days before trial_end). No I/O, no Deno globals => unit-tested by Vitest.

import { TRIAL_MINUTES } from "./trialLifecycle.ts";

export interface TrialEndingEmailParams {
  greetingName: string;
  planName: string;
  /** ISO timestamp of trial end. */
  trialEndsAt: string;
  minutesUsed: number;
  manageUrl: string;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "soon"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export function buildTrialEndingEmail(p: TrialEndingEmailParams) {
  const date = formatDate(p.trialEndsAt);
  const used = Math.max(0, Math.min(TRIAL_MINUTES, Math.round(p.minutesUsed)));
  const subject = `Your Vireek trial ends on ${date}`;
  const line1 = `Your 14-day Vireek trial of the ${p.planName} plan ends on ${date}. Your card on file will be charged then unless you cancel before that date.`;
  const line2 = `You've used ${used} of your ${TRIAL_MINUTES} trial minutes. After your first payment your plan's full monthly minutes are unlocked.`;
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
      <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #b45309; margin: 0 0 16px;">Trial ending soon</p>
      <h1 style="font-size: 22px; margin: 0 0 16px;">Hi ${escapeHtml(p.greetingName)}, your trial ends on ${escapeHtml(date)}</h1>
      <p style="font-size: 15px; line-height: 1.6; color: #374151;">${escapeHtml(line1)}</p>
      <p style="font-size: 15px; line-height: 1.6; color: #374151;">${escapeHtml(line2)}</p>
      <a href="${escapeHtml(p.manageUrl)}" style="display: inline-block; margin-top: 24px; padding: 12px 24px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px;">Manage subscription</a>
      <p style="margin-top: 24px; font-size: 13px; color: #9ca3af;">You can cancel any time before ${escapeHtml(date)} from the billing page and you will not be charged.</p>
    </div>`;
  const text = `${line1}\n\n${line2}\n\nManage or cancel: ${p.manageUrl}`;
  return { subject, html, text };
}
