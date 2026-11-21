// supabase/functions/_shared/billing/planResumeEmail.ts
//
// The ONE reminder for people who started choosing a plan and did not finish. Pure builder (no I/O, no Deno globals).
// Sent only to owners who ticked the reminder box on /onboarding/plan, at most once (billing_notice_log kind "plan_resume").
// No prices, no discounts and no urgency claims: it only links back to where they stopped.
// [COUNSEL] whether a pre-ticked box would also be acceptable in the markets served; today it is opt-in, unticked.

import { escapeHtml } from "./trialEmail.ts";

export interface PlanResumeEmailParams {
  greetingName: string;
  /** Display name of the plan they had picked, if any ("Professional"). */
  planName: string | null;
  resumeUrl: string;
}

export function buildPlanResumeEmail(p: PlanResumeEmailParams) {
  const subject = "Finish choosing your Vireek plan";
  const name = p.greetingName.trim() || "there";
  const line1 = p.planName
    ? `You were looking at the ${p.planName} plan. Your choice is saved, so you can pick up exactly where you stopped.`
    : "You started choosing a plan. Your progress is saved, so you can pick up exactly where you stopped.";
  const line2 = "You are getting this one reminder because you asked for it on the plan page. We will not send another.";
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1c1b15;">
      <h1 style="font-size: 22px; margin: 0 0 16px;">Hi ${escapeHtml(name)}, ready to pick up where you left off?</h1>
      <p style="font-size: 15px; line-height: 1.6; color: #44423D;">${escapeHtml(line1)}</p>
      <a href="${escapeHtml(p.resumeUrl)}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #1C1B15; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px;">Choose my plan</a>
      <p style="margin-top: 24px; font-size: 13px; line-height: 1.5; color: #6b6a64;">${escapeHtml(line2)}</p>
    </div>`;
  const text = `Hi ${name},\n\n${line1}\n\nChoose your plan: ${p.resumeUrl}\n\n${line2}`;
  return { subject, html, text };
}
