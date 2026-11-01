// Every email the kit currently renders, with realistic sample data. Powers /dev/emails and email-preview-send.
// Add a template to the kit => add it here, and the gallery + render tests pick it up.

import { buildEmail } from "../notify/routing.ts";
import { renderEmail, type RenderedEmail } from "./layout.ts";
import { toEmail } from "./notification.ts";
import { buildSecurityNotification, type SecurityEvent } from "./securityTemplates.ts";

export interface PreviewSample {
  id: string;
  label: string;
  render: (locale: string, siteUrl: string) => RenderedEmail;
}

const SECURITY: SecurityEvent[] = ["new_sign_in", "password_changed", "email_changed", "mfa_enrolled", "mfa_disabled", "recovery_codes_regenerated", "api_key_created", "api_key_revoked"];
const WHEN = new Date("2027-04-02T10:15:30Z");

export const PREVIEW_SAMPLES: PreviewSample[] = [
  ...SECURITY.map<PreviewSample>((ev) => ({
    id: `security.${ev}`,
    label: `Security · ${ev}`,
    render: (locale, siteUrl) =>
      toEmail(
        buildSecurityNotification(ev, { whenUtc: WHEN, device: "Chrome on Windows", location: "Berlin, DE", ipMasked: "203.0.113.0", keyName: "Zapier", newEmailMasked: "j***@example.com", reason: "a new device" }, locale),
        { siteUrl, locale },
      ),
  })),
  {
    id: "alert.router.critical",
    label: "Alert · notification router (critical)",
    render: (_locale, siteUrl) => {
      const m = buildEmail({ title: "Emergency call missed", message: "A customer called about a gas leak and no one answered.\n\nCall back now.", severity: "critical", openUrl: `${siteUrl}/dashboard/calls`, ackUrl: `${siteUrl}/ack/example` });
      return { ...m, lang: "en", dir: "ltr" };
    },
  },
  {
    id: "comment.mention",
    label: "Comments · @mention",
    render: (locale, siteUrl) =>
      renderEmail({
        locale,
        subject: "Sam mentioned you on Job #1042",
        preheader: "“Can you confirm the part is on the truck?”",
        title: "Sam mentioned you on Job #1042",
        body: "Can you confirm the part is on the truck?",
        severity: "info",
        action: { label: "Open the conversation", url: `${siteUrl}/dashboard/jobs/1042` },
        siteUrl,
        extraFooterLines: ["You get this because you were mentioned or are part of the thread. Turn it off in Vireek under Settings → Notifications."],
      }),
  },
];
