// Tenant email branding, shared by every function that emails a tenant's CUSTOMERS.
// Pure composition (composeEmailBrand / brandedFrom / applyFooter) is unit-tested;
// loadEmailBrand is the only part that touches the database.

import { isValidEmail, normalizeLocalPart, sanitizeSenderName, sanitizeSignature } from "../messaging/emailSettings.ts";

/** Keep in sync with public.brand_plan_is_white_label() and src/lib/whiteLabel.ts. */
export const WHITE_LABEL_PLANS = ["business", "enterprise"];
export const planAllowsWhiteLabel = (plan: string | null | undefined): boolean =>
  typeof plan === "string" && WHITE_LABEL_PLANS.includes(plan);

export interface EmailBrand {
  fromName: string | null;
  /** Bare address on the tenant's VERIFIED sender domain, or null (use the platform address). */
  fromAddress: string | null;
  replyTo: string | null;
  /** The tenant's own footer text (brand_settings.email_footer). */
  footer: string | null;
  /** "Sent via Vireek" when Vireek branding applies, else null. */
  attribution: string | null;
  showVireek: boolean;
}

export interface BrandInputs {
  companyName: string | null | undefined;
  plan: string | null | undefined;
  brand: {
    email_sender_name?: string | null;
    email_reply_to?: string | null;
    email_footer?: string | null;
    portal_show_powered_by?: boolean | null;
  } | null;
  email: {
    sender_name?: string | null;
    reply_to_email?: string | null;
    sender_local_part?: string | null;
    sender_domain?: string | null;
    domain_status?: string | null;
  } | null;
}

export function composeEmailBrand(i: BrandInputs): EmailBrand {
  const stored = i.brand?.portal_show_powered_by ?? true;
  const showVireek = stored || !planAllowsWhiteLabel(i.plan);

  const fromName =
    sanitizeSenderName(i.email?.sender_name) ??
    sanitizeSenderName(i.brand?.email_sender_name) ??
    sanitizeSenderName(i.companyName) ??
    (showVireek ? null : "Customer service");

  const domain = (i.email?.sender_domain ?? "").trim().toLowerCase();
  const fromAddress =
    i.email?.domain_status === "verified" && domain
      ? `${normalizeLocalPart(i.email?.sender_local_part ?? "") ?? "hello"}@${domain}`
      : null;

  const rt = (i.email?.reply_to_email ?? i.brand?.email_reply_to ?? "").trim();

  return {
    fromName,
    fromAddress,
    replyTo: rt && isValidEmail(rt) ? rt : null,
    footer: sanitizeSignature(i.brand?.email_footer),
    attribution: showVireek ? "Sent via Vireek" : null,
    showVireek,
  };
}

const bareAddress = (from: string): string =>
  (from.includes("<") ? (from.split("<").pop() ?? "").replace(">", "") : from).trim();

/** Never leaves a "Vireek" display name on a white-labeled send. */
export function brandedFrom(brand: EmailBrand | undefined, platformFrom: string): string {
  if (!brand) return platformFrom;
  const address = brand.fromAddress ?? bareAddress(platformFrom);
  if (brand.fromName) return `${brand.fromName} <${address}>`;
  return brand.fromAddress ? address : platformFrom;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function applyFooter(html: string, text: string, brand: EmailBrand): { html: string; text: string } {
  const lines = [brand.footer, brand.attribution].filter((l): l is string => Boolean(l));
  if (lines.length === 0) return { html, text };
  return {
    html:
      `${html}<div style="max-width:480px;margin:0 auto;padding:0 24px 24px;font:12px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#9ca3af;white-space:pre-line">` +
      `${esc(lines.join("\n"))}</div>`,
    text: `${text}\n\n-- \n${lines.join("\n")}`,
  };
}

// deno-lint-ignore no-explicit-any
type Admin = { from: (table: string) => any };

export async function loadEmailBrand(admin: Admin, ownerId: string): Promise<EmailBrand> {
  const [profile, brand, email] = await Promise.all([
    admin.from("profiles").select("company_name, plan").eq("id", ownerId).maybeSingle(),
    admin
      .from("brand_settings")
      .select("email_sender_name, email_reply_to, email_footer, portal_show_powered_by")
      .eq("user_id", ownerId)
      .maybeSingle(),
    admin
      .from("email_settings")
      .select("sender_name, reply_to_email, sender_local_part, sender_domain, domain_status")
      .eq("user_id", ownerId)
      .maybeSingle(),
  ]);
  return composeEmailBrand({
    companyName: profile?.data?.company_name,
    plan: profile?.data?.plan,
    brand: brand?.data ?? null,
    email: email?.data ?? null,
  });
}
