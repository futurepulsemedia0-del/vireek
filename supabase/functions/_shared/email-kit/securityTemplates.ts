// Security-event notifications. Every one answers: what happened, when, where / on what device,
// and what to do if it wasn't you. English copy; add locales by extending SECURITY_COPY.
// Callers pass only coarse, already-masked facts (device label, city/country, masked IP) — never
// tokens, full IPs, or key material.

import type { UnifiedNotification } from "./notification.ts";

export type SecurityEvent =
  | "new_sign_in"
  | "password_changed"
  | "email_changed"
  | "mfa_enrolled"
  | "mfa_disabled"
  | "recovery_codes_regenerated"
  | "api_key_created"
  | "api_key_revoked";

export interface SecurityEventContext {
  whenUtc: Date;
  device?: string | null;
  location?: string | null;
  ipMasked?: string | null;
  /** API key events: the key's display name (never the secret). */
  keyName?: string | null;
  /** email_changed: where the notice goes; the new address is masked by the caller. */
  newEmailMasked?: string | null;
  /** new_sign_in: "new device" | "new location" | "new device in a new location". */
  reason?: string | null;
}

interface Copy {
  title: string;
  body: string;
  severity: UnifiedNotification["severity"];
  actionLabel: string;
  actionPath: string;
}
const NOT_YOU_PATH = "/dashboard/settings/security";

const SECURITY_COPY: Record<string, Record<SecurityEvent, Copy>> = {
  en: {
    new_sign_in: { title: "New sign-in to your account", body: "We noticed a sign-in from {reason}.", severity: "warning", actionLabel: "Review sessions", actionPath: "/dashboard/settings/sessions" },
    password_changed: { title: "Your password was changed", body: "The password for your Vireek account was changed. All other sessions stay signed in until you sign them out.", severity: "high", actionLabel: "Review sessions", actionPath: "/dashboard/settings/sessions" },
    email_changed: { title: "Your account email was changed", body: "The email address on your Vireek account was changed{newEmail}. This notice is sent to your previous address so you can act if it wasn’t you.", severity: "critical", actionLabel: "Review security settings", actionPath: NOT_YOU_PATH },
    mfa_enrolled: { title: "Two-step verification is on", body: "A new two-step verification method was added to your account. You will be asked for it when you sign in from a new device.", severity: "info", actionLabel: "Manage two-step verification", actionPath: NOT_YOU_PATH },
    mfa_disabled: { title: "Two-step verification was turned off", body: "A two-step verification method was removed from your account, which makes it easier for someone else to sign in.", severity: "critical", actionLabel: "Turn it back on", actionPath: NOT_YOU_PATH },
    recovery_codes_regenerated: { title: "Your recovery codes were replaced", body: "New recovery codes were generated for your account. Your old codes no longer work.", severity: "high", actionLabel: "Review security settings", actionPath: NOT_YOU_PATH },
    api_key_created: { title: "A new API key was created", body: "An API key{keyName} was created for your account. Anyone with this key can access your data through the API.", severity: "high", actionLabel: "Review API keys", actionPath: "/dashboard/settings/api" },
    api_key_revoked: { title: "An API key was revoked", body: "The API key{keyName} was revoked and can no longer be used. Integrations that depended on it will stop working.", severity: "warning", actionLabel: "Review API keys", actionPath: "/dashboard/settings/api" },
  },
  fa: {
    new_sign_in: { title: "ورود جدید به حساب شما", body: "ورودی از {reason} مشاهده کردیم.", severity: "warning", actionLabel: "بررسی نشست‌ها", actionPath: "/dashboard/settings/sessions" },
    password_changed: { title: "رمز عبور شما تغییر کرد", body: "رمز عبور حساب ویریک شما تغییر کرد. نشست‌های دیگر تا زمانی که خودتان خارجشان نکنید وارد باقی می‌مانند.", severity: "high", actionLabel: "بررسی نشست‌ها", actionPath: "/dashboard/settings/sessions" },
    email_changed: { title: "ایمیل حساب شما تغییر کرد", body: "نشانی ایمیل حساب ویریک شما{newEmail} تغییر کرد. این اطلاعیه به نشانی قبلی شما ارسال می‌شود تا اگر کار شما نبوده اقدام کنید.", severity: "critical", actionLabel: "بررسی تنظیمات امنیتی", actionPath: NOT_YOU_PATH },
    mfa_enrolled: { title: "تأیید دومرحله‌ای فعال شد", body: "یک روش تأیید دومرحله‌ای جدید به حساب شما اضافه شد. هنگام ورود از دستگاه جدید از شما درخواست می‌شود.", severity: "info", actionLabel: "مدیریت تأیید دومرحله‌ای", actionPath: NOT_YOU_PATH },
    mfa_disabled: { title: "تأیید دومرحله‌ای غیرفعال شد", body: "یک روش تأیید دومرحله‌ای از حساب شما حذف شد؛ این کار ورود افراد دیگر را آسان‌تر می‌کند.", severity: "critical", actionLabel: "دوباره فعالش کنید", actionPath: NOT_YOU_PATH },
    recovery_codes_regenerated: { title: "کدهای بازیابی شما جایگزین شد", body: "کدهای بازیابی جدیدی برای حساب شما ساخته شد. کدهای قبلی دیگر کار نمی‌کنند.", severity: "high", actionLabel: "بررسی تنظیمات امنیتی", actionPath: NOT_YOU_PATH },
    api_key_created: { title: "کلید API جدید ساخته شد", body: "یک کلید API{keyName} برای حساب شما ساخته شد. هر کسی که این کلید را داشته باشد می‌تواند از طریق API به داده‌های شما دسترسی پیدا کند.", severity: "high", actionLabel: "بررسی کلیدهای API", actionPath: "/dashboard/settings/api" },
    api_key_revoked: { title: "یک کلید API لغو شد", body: "کلید API{keyName} لغو شد و دیگر قابل استفاده نیست. برنامه‌هایی که به آن وابسته بودند از کار می‌افتند.", severity: "warning", actionLabel: "بررسی کلیدهای API", actionPath: "/dashboard/settings/api" },
  },
};
const FACT_LABELS: Record<string, { what: string; when: string; where: string; device: string; network: string }> = {
  en: { what: "What happened", when: "When", where: "Where", device: "Device", network: "Network" },
  fa: { what: "چه اتفاقی افتاد", when: "زمان", where: "مکان", device: "دستگاه", network: "شبکه" },
};
const WORDS: Record<string, { to: string; defaultReason: string; notYouText: string; notYouLabel: string }> = {
  en: { to: "to", defaultReason: "a new device", notYouText: "If this wasn’t you, secure your account now: sign out other sessions, change your password and review two-step verification.", notYouLabel: "This wasn’t me — secure my account" },
  fa: { to: "به", defaultReason: "یک دستگاه جدید", notYouText: "اگر کار شما نبوده، همین حالا حساب خود را ایمن کنید: نشست‌های دیگر را ببندید، رمز عبور را عوض کنید و تأیید دومرحله‌ای را بررسی کنید.", notYouLabel: "این من نبودم — حسابم را ایمن کن" },
};

export function formatUtc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function buildSecurityNotification(event: SecurityEvent, ctx: SecurityEventContext, locale = "en"): UnifiedNotification {
  const lang = SECURITY_COPY[locale] ? locale : "en";
  const labels = FACT_LABELS[lang];
  const w = WORDS[lang];
  const c = SECURITY_COPY[lang][event];
  const body = c.body
    .replace("{reason}", ctx.reason ?? w.defaultReason)
    .replace("{newEmail}", ctx.newEmailMasked ? ` ${w.to} ${ctx.newEmailMasked}` : "")
    .replace("{keyName}", ctx.keyName ? ` “${ctx.keyName}”` : "");
  const facts: Array<[string, string]> = [[labels.when, formatUtc(ctx.whenUtc)]];
  if (ctx.device) facts.push([labels.device, ctx.device]);
  if (ctx.location) facts.push([labels.where, ctx.location]);
  if (ctx.ipMasked) facts.push([labels.network, ctx.ipMasked]);
  return {
    title: c.title,
    body,
    severity: c.severity,
    facts,
    action: { label: c.actionLabel, url: c.actionPath },
    notYou:
      event === "mfa_enrolled" || event === "api_key_revoked"
        ? undefined
        : { text: w.notYouText, action: { label: w.notYouLabel, url: NOT_YOU_PATH } },
  };
}
