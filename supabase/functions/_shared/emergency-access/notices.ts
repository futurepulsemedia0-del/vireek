// supabase/functions/_shared/emergency-access/notices.ts
// Plain, factual notice e-mails. They state what happened and what the recipient can do; they make no
// legal claims. Wording is English-only for now and has NOT had legal/brand review [COUNSEL].

export type NoticeRecipient = "owner" | "contact";
export interface NoticeCtx {
  kind: string;
  recipient: NoticeRecipient;
  ownerBusiness: string | null;
  contactName: string | null;
  requestReason: string | null;
  accessAvailableAt: string | null;
  accessExpiresAt: string | null;
  closedReason: string | null;
  waitHours: number | null;
  scopes: string[] | null;
}
export interface RenderedNotice { subject: string; html: string; text: string }

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const when = (iso: string | null): string => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? "an unknown time" : new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
};

const CLOSE_REASONS: Record<string, string> = {
  denied_by_owner: "the account owner denied it",
  cancelled_by_contact: "the contact cancelled it",
  owner_signed_in: "the account owner signed in",
  verification_expired: "the verification code expired",
  too_many_attempts: "too many wrong verification codes were entered",
  contact_revoked_by_owner: "the account owner removed the contact",
  access_window_elapsed: "the access period ended",
};

export function renderNotice(c: NoticeCtx, appUrl: string): RenderedNotice | null {
  const biz = c.ownerBusiness?.trim() || "a Vireek account";
  const who = c.contactName?.trim() || "your emergency contact";
  const link = `${appUrl.replace(/\/$/, "")}/dashboard/emergency-access`;
  const scopes = (c.scopes ?? []).join(", ") || "customers, invoices, jobs";
  const key = `${c.recipient}:${c.kind}`;
  let subject: string; let lines: string[];

  switch (key) {
    case "owner:requested":
      subject = "Emergency access was requested on your Vireek account";
      lines = [`${who} asked for emergency read-only access to your account.`, c.requestReason ? `Their stated reason: ${c.requestReason}` : "", "Nothing has been shared. If you can act, sign in and deny the request. Signing in also cancels it."];
      break;
    case "owner:verified":
      subject = "Emergency access countdown has started";
      lines = [`${who} confirmed their identity by e-mail code. Read-only access (${scopes}) would start at ${when(c.accessAvailableAt)} unless you sign in or deny it.`, "Access is read and export only. It cannot change records or move money."];
      break;
    case "owner:reminder":
      subject = "Reminder: emergency access is pending on your Vireek account";
      lines = [`Read-only access for ${who} would start at ${when(c.accessAvailableAt)}.`, "Sign in to cancel it, or deny it from the emergency access page."];
      break;
    case "owner:pre_grant":
      subject = "Final notice: emergency access starts within 24 hours";
      lines = [`Read-only access for ${who} would start at ${when(c.accessAvailableAt)}.`, "This is the last notice before access opens. Sign in or deny it now if it is not expected."];
      break;
    case "owner:granted":
      subject = "Emergency read-only access is now open on your account";
      lines = [`${who} can read and export ${scopes} until ${when(c.accessExpiresAt)}.`, "You can end it at any time from the emergency access page. Every read and export is logged there."];
      break;
    case "owner:first_access":
      subject = "Your records were accessed through emergency access";
      lines = [`${who} has started reading or exporting ${scopes}.`, "The full log is on the emergency access page."];
      break;
    case "owner:closed":
      subject = "Emergency access request closed";
      lines = [`The request from ${who} was closed: ${CLOSE_REASONS[c.closedReason ?? ""] ?? "it is no longer active"}.`];
      break;
    case "owner:accepted":
      subject = "Your emergency contact accepted";
      lines = [`${who} accepted the designation. They get no access unless they request it and the waiting period passes without you stopping it.`];
      break;
    case "contact:invited":
      subject = `${biz} named you as an emergency contact on Vireek`;
      lines = [`${biz} designated you to request read-only access to their business records if they become unable to act.`, `Waiting period before any access: ${c.waitHours ?? 72} hours, during which they are notified and can stop it.`, "To accept, sign in to Vireek (or create an account) with this e-mail address and open the link below. If you were not expecting this, ignore this message."];
      break;
    case "contact:granted":
      subject = "Emergency read-only access is open";
      lines = [`You can read and export ${scopes} for ${biz} until ${when(c.accessExpiresAt)}.`, "Access is read-only and every action is logged."];
      break;
    case "contact:closed":
      subject = "Emergency access request closed";
      lines = [`Your request for ${biz} was closed: ${CLOSE_REASONS[c.closedReason ?? ""] ?? "it is no longer active"}.`];
      break;
    default:
      return null;
  }
  lines = lines.filter(Boolean);
  const text = `${lines.join("\n\n")}\n\n${link}\n`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">${lines.map((l) => `<p>${esc(l)}</p>`).join("")}<p><a href="${esc(link)}">Open emergency access</a></p></div>`;
  return { subject, html, text };
}
