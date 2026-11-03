// supabase/functions/_shared/audit/emails.ts
// Pure email builders. The report-ready email is TRANSACTIONAL (the owner asked for the report). Steps 1-2 are
// marketing follow-ups, sent only with the separate opt-in, an unsubscribe link and a postal address (CAN-SPAM).

import { BAND_LABEL } from "./scoring.ts";
import type { ScoreResult } from "./types.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface EmailCtx {
  businessName: string;
  reportUrl: string;
  unsubscribeUrl: string;
  postalAddress: string | null;
  score: ScoreResult | null;
  trialUrl: string;
}

export interface BuiltEmail { subject: string; html: string; text: string }

const shell = (inner: string, c: EmailCtx, marketing: boolean) =>
  `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:560px">${inner}` +
  `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/><p style="font-size:12px;color:#555">` +
  `${marketing ? "You're receiving this because you asked for follow-up emails after your Vireek Missed-Call Audit. " : "You're receiving this because you requested a Vireek Missed-Call Audit. "}` +
  `<a href="${esc(c.unsubscribeUrl)}">Unsubscribe</a>. You can also delete your audit data from the report page.` +
  `${c.postalAddress ? `<br/>${esc(c.postalAddress)}` : ""}</p></div>`;

export function reportReadyEmail(c: EmailCtx): BuiltEmail {
  const s = c.score;
  const line = s && s.total !== null
    ? `Your line scored ${s.total} out of 100 (${BAND_LABEL[s.band!]}).`
    : "We couldn't complete enough test calls to score your line this time. Nothing was counted against you.";
  const text = `Your Missed-Call Audit for ${c.businessName} is ready.\n\n${line}\n\nOpen your private report (expires in 30 days):\n${c.reportUrl}\n\nUnsubscribe: ${c.unsubscribeUrl}${c.postalAddress ? `\n${c.postalAddress}` : ""}`;
  return {
    subject: `Your Missed-Call Audit results for ${c.businessName.slice(0, 60)}`,
    text,
    html: shell(`<p>Your Missed-Call Audit for <strong>${esc(c.businessName)}</strong> is ready.</p><p>${esc(line)}</p><p><a href="${esc(c.reportUrl)}">Open your private report</a> (the link expires in 30 days; keep it to yourself).</p>`, c, false),
  };
}

export function followupEmail(step: 1 | 2, c: EmailCtx): BuiltEmail {
  const body = step === 1
    ? "Here is the quickest win from your audit: make sure the first thing a caller hears is a person or an assistant, not a ring-out. If you'd like to hear how that sounds on your own line, you can run the same test again with Sarah (our AI receptionist) answering. It's free to try and you can stop any time."
    : "One last note on your audit. If missed calls are costing you jobs, Shadow Mode lets Sarah listen and show you what she would have done, without touching your real calls. It takes a few minutes to set up. If this isn't useful, just unsubscribe and we won't email again.";
  const cta = `Try it free: ${c.trialUrl}`;
  return {
    subject: step === 1 ? "Run your audit again with Sarah answering" : "Want to see Sarah on your line, risk-free?",
    text: `${body}\n\n${cta}\nYour report: ${c.reportUrl}\n\nUnsubscribe: ${c.unsubscribeUrl}${c.postalAddress ? `\n${c.postalAddress}` : ""}`,
    html: shell(`<p>${esc(body)}</p><p><a href="${esc(c.trialUrl)}">Try it free</a> &middot; <a href="${esc(c.reportUrl)}">Your report</a></p>`, c, true),
  };
}
