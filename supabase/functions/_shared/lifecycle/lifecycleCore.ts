// supabase/functions/_shared/lifecycle/lifecycleCore.ts
//
// Pure logic for Customer Lifecycle Touches (birthday, home-purchase anniversary,
// equipment-install anniversary, first-service anniversary).
//
// NO imports, NO Deno / DOM APIs: this file is shared by
//   - the edge function  supabase/functions/lifecycle-touch-tick   (sending)
//   - the dashboard      src/lib/lifecycle.ts                       (previews, validation)
//   - the unit tests     lifecycleCore.test.ts                      (vitest)
// so the preview an owner sees is produced by the exact code that sends the message.
//
// Which occurrences exist (who has an anniversary on which day, leap-day handling,
// min/max years, equipment-type filter) is decided ONCE, in SQL:
//   public.lifecycle_occurrences()  (see the migration). This file only decides
//   WHEN an occurrence is due, WHICH channels may be used, and WHAT the message says.

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

export const TOUCH_TYPES = [
  "birthday",
  "home_purchase_anniversary",
  "equipment_install_anniversary",
  "first_service_anniversary",
] as const;
export type TouchType = (typeof TOUCH_TYPES)[number];

export type Channel = "email" | "sms";
export const CHANNELS: readonly Channel[] = ["email", "sms"];

/** A touch still goes out up to this many days AFTER its date (missed ticks, quiet hours). */
export const LATE_GRACE_DAYS = 2;
export const MAX_LEAD_DAYS = 30;
/** Real send attempts per channel per occurrence (deferrals by quiet hours do not count). */
export const MAX_ATTEMPTS = 3;
/** A 'claimed' row older than this belongs to a crashed run and may be taken over. */
export const CLAIM_STALE_MS = 15 * 60_000;

export function isTouchType(v: unknown): v is TouchType {
  return typeof v === "string" && (TOUCH_TYPES as readonly string[]).includes(v);
}

export interface TouchMeta {
  type: TouchType;
  label: string;
  campaignName: string;
  /** Stored on marketing_campaigns.trigger_event so these campaigns are recognisable in the Marketing page. */
  triggerEvent: string;
  description: string;
  /** false for birthdays: we deliberately never store a birth YEAR, so there is no age/"years" to show. */
  hasYears: boolean;
  /** Where the date comes from — shown in the UI. */
  dataSource: string;
  defaultLeadDays: number;
  defaultSendHour: number;
}

export const TOUCH_META: Record<TouchType, TouchMeta> = {
  birthday: {
    type: "birthday",
    label: "Birthday",
    campaignName: "Lifecycle · Birthday",
    triggerEvent: "lifecycle_birthday",
    description: "A warm birthday greeting (optionally with a gift offer) on the customer's birthday.",
    hasYears: false,
    dataSource: "Birth month & day recorded on the customer (no birth year is ever stored).",
    defaultLeadDays: 0,
    defaultSendHour: 9,
  },
  home_purchase_anniversary: {
    type: "home_purchase_anniversary",
    label: "Home-purchase anniversary",
    campaignName: "Lifecycle · Home anniversary",
    triggerEvent: "lifecycle_home_purchase_anniversary",
    description: "Congratulates the customer on each year in their home — a natural moment to offer a home checkup.",
    hasYears: true,
    dataSource: "Home-purchase date recorded on the customer.",
    defaultLeadDays: 0,
    defaultSendHour: 10,
  },
  equipment_install_anniversary: {
    type: "equipment_install_anniversary",
    label: "Equipment-install anniversary",
    campaignName: "Lifecycle · Equipment anniversary",
    triggerEvent: "lifecycle_equipment_install_anniversary",
    description: "Each year after an install, invites the customer to a maintenance visit for that exact equipment.",
    hasYears: true,
    dataSource: "Install date on each active equipment record.",
    defaultLeadDays: 7,
    defaultSendHour: 10,
  },
  first_service_anniversary: {
    type: "first_service_anniversary",
    label: "First-service anniversary",
    campaignName: "Lifecycle · First-service anniversary",
    triggerEvent: "lifecycle_first_service_anniversary",
    description: "Thanks the customer for each year since their first completed job with you.",
    hasYears: true,
    dataSource: "Date of the customer's earliest completed job.",
    defaultLeadDays: 0,
    defaultSendHour: 10,
  },
};

export interface Occurrence {
  touch_type: TouchType;
  customer_id: string;
  customer_name: string;
  equipment_id: string | null;
  equipment_label: string | null;
  /** YYYY-MM-DD, the anniversary date inside the requested range (business-local calendar date). */
  occurrence_date: string;
  occurrence_year: number;
  /** null for birthdays. */
  years_count: number | null;
  opted_in: boolean;
  email_consent: boolean;
  sms_consent: boolean;
}

// ---------------------------------------------------------------------------
// Calendar-date helpers (no time-of-day maths on date-only values)
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIso(iso: string): number {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new Error(`Invalid ISO date: ${iso}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }
  return ms;
}

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    parseIso(v);
    return true;
  } catch {
    return false;
  }
}

export function addDays(iso: string, days: number): string {
  return new Date(parseIso(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (positive when `toIso` is later). */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseIso(toIso) - parseIso(fromIso)) / 86_400_000);
}

export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export interface ZonedNow {
  /** YYYY-MM-DD in the business time zone. */
  date: string;
  hour: number;
  minute: number;
}

export function zonedNow(now: Date, timeZone: string | null | undefined): ZonedNow {
  const tz = safeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

/** Formats a date-only value ("2026-11-20" → "November 20, 2026"); time zones never apply to calendar dates. */
export function formatLongDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }).format(new Date(parseIso(iso)));
}

// ---------------------------------------------------------------------------
// When is an occurrence due?
// ---------------------------------------------------------------------------

export type DueDecision =
  | { due: true; sendDay: string }
  | { due: false; reason: "too_early" | "too_late" | "before_send_hour" };

/**
 * An occurrence is due on (date - lead_days) from `send_hour` (business-local) onwards, and stays due
 * until LATE_GRACE_DAYS after its date. The ledger (unique per occurrence+channel) makes re-evaluation
 * on every hourly tick safe.
 */
export function evaluateDue(
  occurrenceDate: string,
  settings: { lead_days: number; send_hour: number },
  now: ZonedNow,
): DueDecision {
  const daysUntil = daysBetween(now.date, occurrenceDate);
  if (daysUntil > settings.lead_days) return { due: false, reason: "too_early" };
  if (daysUntil < -LATE_GRACE_DAYS) return { due: false, reason: "too_late" };
  const sendDay = addDays(occurrenceDate, -settings.lead_days);
  if (now.date === sendDay && now.hour < settings.send_hour) return { due: false, reason: "before_send_hour" };
  return { due: true, sendDay };
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

export type OfferType = "percent_off" | "amount_off" | "free_service" | "custom";

export interface OfferSettings {
  offer_enabled: boolean;
  offer_type: OfferType;
  offer_value: number | null;
  offer_title: string | null;
  offer_terms: string | null;
  offer_valid_days: number;
}

function money(v: number): string {
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

/** Human text of an offer ("10% off any repair"); "" when disabled or incomplete — never a half-built offer. */
export function formatOffer(o: OfferSettings): string {
  if (!o.offer_enabled) return "";
  const title = (o.offer_title ?? "").trim();
  if (!title) return "";
  switch (o.offer_type) {
    case "percent_off":
      return o.offer_value && o.offer_value > 0 && o.offer_value <= 100 ? `${o.offer_value}% off ${title}` : "";
    case "amount_off":
      return o.offer_value && o.offer_value > 0 ? `${money(o.offer_value)} off ${title}` : "";
    default:
      return title;
  }
}

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U

/**
 * Turns a keyed digest (hex, e.g. HMAC-SHA256 of the occurrence key) into a short, unguessable,
 * staff-friendly code: LC-XXXX-XXXX (40 bits). Deterministic, so both channels of one occurrence
 * share a code with no extra coordination.
 */
export function offerCodeFromDigest(hex: string): string {
  if (!/^[0-9a-fA-F]{10,}$/.test(hex)) throw new Error("digest must be at least 10 hex chars");
  let n = BigInt(`0x${hex.slice(0, 10)}`);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = CODE_ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return `LC-${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Forgiving normaliser for codes typed by staff ("lc abcd 1234", "LC-ABCD-1234", O/0, I/L/1). */
export function normalizeOfferCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned.startsWith("LC") || cleaned.length !== 10) return null;
  const body = cleaned.slice(2).replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(body)) return null;
  return `LC-${body.slice(0, 4)}-${body.slice(4)}`;
}

export function occurrenceKey(userId: string, occ: Pick<Occurrence, "touch_type" | "customer_id" | "equipment_id" | "occurrence_year">): string {
  return [userId, occ.touch_type, occ.customer_id, occ.equipment_id ?? "-", occ.occurrence_year].join("|");
}

export function offerExpiry(nowMs: number, validDays: number): string {
  return new Date(nowMs + validDays * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Template language
//   {{name}} {{full_name}} {{company_name}} {{years}} {{years_label}} {{ordinal_years}}
//   {{equipment}} {{offer}} {{offer_code}} {{offer_expires}}
//   {{#offer}} ... {{/offer}}   → kept only when the touch carries an offer
// ---------------------------------------------------------------------------

export const TEMPLATE_VARIABLES = [
  { key: "name", description: "Customer's first name", example: "Sara" },
  { key: "full_name", description: "Customer's full name", example: "Sara Ahmadi" },
  { key: "company_name", description: "Your business name", example: "Northwind Heating & Air" },
  { key: "years", description: "Number of years (anniversaries only)", example: "5" },
  { key: "years_label", description: "Years with correct plural", example: "5 years" },
  { key: "ordinal_years", description: "Ordinal anniversary", example: "5th" },
  { key: "equipment", description: "Equipment (equipment anniversary only)", example: "Carrier furnace" },
  { key: "offer", description: "The offer text", example: "10% off any repair" },
  { key: "offer_code", description: "Unique redeemable code", example: "LC-7K2M-9QXA" },
  { key: "offer_expires", description: "Offer expiry date", example: "November 20, 2026" },
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number]["key"];
const VARIABLE_KEYS: readonly string[] = TEMPLATE_VARIABLES.map((v) => v.key);

const OFFER_BLOCK = /\{\{\s*#offer\s*\}\}([\s\S]*?)\{\{\s*\/offer\s*\}\}/g;
const VAR_TOKEN = /\{\{\s*(\w+)\s*\}\}/g;

/** Single pass: values are inserted AFTER block resolution and are never re-scanned (no template injection). */
export function renderTemplate(template: string, vars: Partial<Record<TemplateVariable, string>>): string {
  const hasOffer = Boolean(vars.offer && vars.offer.trim());
  const withBlocks = template.replace(OFFER_BLOCK, (_m, inner: string) => (hasOffer ? inner : ""));
  const filled = withBlocks.replace(VAR_TOKEN, (_m, key: string) => (VARIABLE_KEYS.includes(key) ? (vars[key as TemplateVariable] ?? "") : ""));
  return filled
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface TemplateCheck {
  errors: string[];
  warnings: string[];
}

export function validateTemplate(channel: Channel, subject: string | null | undefined, body: string): TemplateCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = body ?? "";

  if (!text.trim()) errors.push("The message body is empty.");
  if (channel === "email") {
    if (!(subject ?? "").trim()) errors.push("Email needs a subject line.");
    else if ((subject ?? "").length > 150) errors.push("Subject is longer than 150 characters.");
    if (text.length > 5000) errors.push("Email body is longer than 5,000 characters.");
  } else if (text.length > 600) {
    errors.push("Text message template is longer than 600 characters.");
  }

  const all = `${subject ?? ""}\n${text}`;
  const unknown = new Set<string>();
  for (const m of all.matchAll(/\{\{\s*([#/]?)\s*(\w+)\s*\}\}/g)) {
    const [, marker, name] = m;
    if (marker ? name !== "offer" : !VARIABLE_KEYS.includes(name)) unknown.add(`{{${marker}${name}}}`);
  }
  for (const u of unknown) errors.push(`Unknown placeholder ${u}.`);

  const opens = (all.match(/\{\{\s*#offer\s*\}\}/g) ?? []).length;
  const closes = (all.match(/\{\{\s*\/offer\s*\}\}/g) ?? []).length;
  if (opens !== closes) errors.push("{{#offer}} and {{/offer}} must come in pairs.");

  const outsideBlocks = all.replace(OFFER_BLOCK, "");
  if (/\{\{\s*(offer|offer_code|offer_expires)\s*\}\}/.test(outsideBlocks)) {
    warnings.push("Offer placeholders outside {{#offer}}…{{/offer}} render blank when the touch has no offer.");
  }
  if (channel === "sms") {
    const seg = smsSegments(renderTemplate(text, sampleVars("birthday", "Your Company", true)));
    if (seg.segments > 2) warnings.push(`This text will use about ${seg.segments} SMS segments (higher carrier cost).`);
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Variables, wording helpers
// ---------------------------------------------------------------------------

export function firstName(full: string | null | undefined): string {
  const t = (full ?? "").trim().split(/\s+/)[0] ?? "";
  return t || "there";
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export function yearsLabel(n: number): string {
  return `${n} ${n === 1 ? "year" : "years"}`;
}

export interface OfferRender {
  label: string;
  code: string;
  expires: string;
}

export function buildTemplateVars(args: {
  occ: Pick<Occurrence, "customer_name" | "equipment_label" | "years_count">;
  companyName: string;
  offer: OfferRender | null;
}): Partial<Record<TemplateVariable, string>> {
  const { occ, companyName, offer } = args;
  const years = occ.years_count;
  return {
    name: firstName(occ.customer_name),
    full_name: (occ.customer_name ?? "").trim(),
    company_name: companyName.trim() || "our team",
    years: years == null ? "" : String(years),
    years_label: years == null ? "" : yearsLabel(years),
    ordinal_years: years == null ? "" : ordinal(years),
    equipment: (occ.equipment_label ?? "").trim() || "equipment",
    offer: offer?.label ?? "",
    offer_code: offer?.code ?? "",
    offer_expires: offer?.expires ?? "",
  };
}

/** Example data for previews in the dashboard and for template validation. */
export function sampleVars(touch: TouchType, companyName: string, withOffer: boolean): Partial<Record<TemplateVariable, string>> {
  return buildTemplateVars({
    occ: {
      customer_name: "Sara Ahmadi",
      equipment_label: touch === "equipment_install_anniversary" ? "Carrier furnace" : null,
      years_count: TOUCH_META[touch].hasYears ? 5 : null,
    },
    companyName,
    offer: withOffer ? { label: "10% off any repair", code: "LC-7K2M-9QXA", expires: "November 20, 2026" } : null,
  });
}

// ---------------------------------------------------------------------------
// Default templates (single source of truth: the dashboard sends these to ensure_lifecycle_touch_setup)
// ---------------------------------------------------------------------------

const OFFER_EMAIL_BLOCK =
  "{{#offer}}As a thank-you, enjoy {{offer}}. Mention code {{offer_code}} when you book — valid through {{offer_expires}}.\n\n{{/offer}}";
const OFFER_SMS_BLOCK = "{{#offer}} Enjoy {{offer}} with code {{offer_code}} (valid through {{offer_expires}}).{{/offer}}";

export interface SetupTemplate {
  touch_type: TouchType;
  name: string;
  trigger_event: string;
  lead_days: number;
  send_hour: number;
  steps: { channel: Channel; subject: string | null; body: string }[];
}

export const DEFAULT_TEMPLATES: Record<TouchType, { email: { subject: string; body: string }; sms: { body: string } }> = {
  birthday: {
    email: {
      subject: "Happy birthday, {{name}}!",
      body: `Hi {{name}},\n\nEveryone at {{company_name}} wishes you a very happy birthday!\n\n${OFFER_EMAIL_BLOCK}Warm regards,\nThe {{company_name}} team`,
    },
    sms: { body: `Happy birthday, {{name}}! Warm wishes from all of us at {{company_name}}.${OFFER_SMS_BLOCK}` },
  },
  home_purchase_anniversary: {
    email: {
      subject: "Happy {{ordinal_years}} home anniversary, {{name}}!",
      body: `Hi {{name}},\n\nIt has been {{years_label}} since you made your house a home — congratulations from all of us at {{company_name}}! A yearly checkup keeps your home comfortable and efficient for the years ahead.\n\n${OFFER_EMAIL_BLOCK}Reply to this email or call us any time to book.\n\nThe {{company_name}} team`,
    },
    sms: { body: `Happy {{ordinal_years}} home anniversary, {{name}}! — {{company_name}}.${OFFER_SMS_BLOCK}` },
  },
  equipment_install_anniversary: {
    email: {
      subject: "Your {{equipment}} is {{years_label}} old — time for a checkup?",
      body: `Hi {{name}},\n\nYour {{equipment}} was installed {{years_label}} ago. A yearly maintenance visit keeps it running efficiently and can catch small issues before they turn into expensive repairs.\n\n${OFFER_EMAIL_BLOCK}Reply to this email or call us to schedule a visit.\n\nThe {{company_name}} team`,
    },
    sms: { body: `Hi {{name}}, your {{equipment}} turns {{years_label}} old. Book a checkup with {{company_name}}.${OFFER_SMS_BLOCK}` },
  },
  first_service_anniversary: {
    email: {
      subject: "Thank you for {{years_label}} with {{company_name}}, {{name}}",
      body: `Hi {{name}},\n\n{{years_label}} ago you trusted us with your first service call, and we're grateful you've kept choosing {{company_name}}.\n\n${OFFER_EMAIL_BLOCK}Thank you for being part of our community.\n\nThe {{company_name}} team`,
    },
    sms: { body: `Thank you for {{years_label}} with {{company_name}}, {{name}}!${OFFER_SMS_BLOCK}` },
  },
};

export function defaultSetupTemplates(): SetupTemplate[] {
  return TOUCH_TYPES.map((t) => ({
    touch_type: t,
    name: TOUCH_META[t].campaignName,
    trigger_event: TOUCH_META[t].triggerEvent,
    lead_days: TOUCH_META[t].defaultLeadDays,
    send_hour: TOUCH_META[t].defaultSendHour,
    steps: [
      { channel: "email" as const, subject: DEFAULT_TEMPLATES[t].email.subject, body: DEFAULT_TEMPLATES[t].email.body },
      { channel: "sms" as const, subject: null, body: DEFAULT_TEMPLATES[t].sms.body },
    ],
  }));
}

// ---------------------------------------------------------------------------
// Message assembly
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function buildEmailHtml(body: string, o: { companyName: string; preferenceUrl: string }): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;line-height:1.55">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return (
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:16px;color:#1f2937;max-width:560px">` +
    paragraphs +
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px">` +
    `<p style="margin:0;font-size:12px;color:#6b7280;line-height:1.5">You are receiving this because you chose to hear from ${escapeHtml(o.companyName)}. ` +
    `<a href="${escapeHtml(o.preferenceUrl)}" style="color:#6b7280">Manage preferences or unsubscribe</a>.</p></div>`
  );
}

export function buildEmailText(body: string, o: { companyName: string; preferenceUrl: string }): string {
  return `${body}\n\n--\nYou are receiving this because you chose to hear from ${o.companyName}.\nManage preferences or unsubscribe: ${o.preferenceUrl}`;
}

export function buildSmsBody(body: string): string {
  const t = body.trim();
  return /\bSTOP\b/i.test(t) ? t : `${t}\nReply STOP to opt out.`;
}

const GSM7 = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(""),
);
const GSM7_EXT = new Set("^{}\\[~]|€".split(""));

export function smsSegments(text: string): { encoding: "gsm7" | "ucs2"; length: number; segments: number } {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7.has(ch)) septets += 1;
    else if (GSM7_EXT.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: "gsm7", length: septets, segments: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153) };
  const units = text.length; // UTF-16 code units, which is what UCS-2 segmentation counts
  return { encoding: "ucs2", length: units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

// ---------------------------------------------------------------------------
// Per-channel send planning (consent → contact → preferences → dedupe/retry)
// ---------------------------------------------------------------------------

export interface StepLike {
  id: string;
  step_order: number;
  channel: Channel;
  subject: string | null;
  body: string;
}

export type LogStatus = "claimed" | "sent" | "deferred" | "failed" | "skipped";

export interface ExistingLog {
  channel: Channel;
  status: LogStatus;
  attempts: number;
  claimed_at: string | null;
  skip_reason: string | null;
}

export type SkipReason = "no_channel_consent" | "no_contact" | "preferences_opt_out" | "do_not_contact" | "empty_template";

export interface ChannelPlan {
  channel: Channel;
  step: StepLike;
  /** send: attempt delivery · record_skip: write a 'skipped' ledger row · noop: nothing to do (already handled / not yet retryable). */
  action: "send" | "record_skip" | "noop";
  reason?: string;
  /** An existing ledger row is being taken over (compare-and-set on its status) instead of inserting a new one. */
  reclaim?: ExistingLog;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hasUsablePhone(p: string | null | undefined): boolean {
  return (p ?? "").replace(/\D/g, "").length >= 7;
}

export function planChannelActions(input: {
  steps: StepLike[];
  consent: { email: boolean; sms: boolean };
  contact: { email: string | null; phone: string | null };
  /** Result of mayContact(prefs, "marketing", channel) — computed by the caller. */
  prefsAllowed: { email: boolean; sms: boolean };
  /** SMS suppression list (STOP / DNC). */
  smsSuppressed: boolean;
  existing: ExistingLog[];
  nowMs: number;
}): ChannelPlan[] {
  const byChannel = new Map<Channel, StepLike>();
  for (const s of [...input.steps].sort((a, b) => a.step_order - b.step_order)) {
    if (!byChannel.has(s.channel)) byChannel.set(s.channel, s); // one message per channel: lowest step_order wins
  }

  const plans: ChannelPlan[] = [];
  for (const [channel, step] of byChannel) {
    const existing = input.existing.find((e) => e.channel === channel);

    if (existing) {
      if (existing.status === "sent") { plans.push({ channel, step, action: "noop", reason: "already_sent" }); continue; }
      if (existing.status === "failed" && existing.attempts >= MAX_ATTEMPTS) { plans.push({ channel, step, action: "noop", reason: "attempts_exhausted" }); continue; }
      if (existing.status === "claimed") {
        const claimedMs = existing.claimed_at ? Date.parse(existing.claimed_at) : 0;
        const stale = input.nowMs - claimedMs > CLAIM_STALE_MS;
        if (!stale) { plans.push({ channel, step, action: "noop", reason: "in_progress" }); continue; }
        if (existing.attempts >= MAX_ATTEMPTS) { plans.push({ channel, step, action: "noop", reason: "attempts_exhausted" }); continue; }
      }
    }

    let skip: SkipReason | null = null;
    if (!(channel === "email" ? input.consent.email : input.consent.sms)) skip = "no_channel_consent";
    else if (!(channel === "email" ? EMAIL_RE.test((input.contact.email ?? "").trim()) : hasUsablePhone(input.contact.phone))) skip = "no_contact";
    else if (!(channel === "email" ? input.prefsAllowed.email : input.prefsAllowed.sms)) skip = "preferences_opt_out";
    else if (channel === "sms" && input.smsSuppressed) skip = "do_not_contact";
    else if (!step.body.trim()) skip = "empty_template";

    if (skip) {
      // Re-evaluated every tick (consent may be granted later in the window) but only written once per reason.
      const alreadyRecorded = existing?.status === "skipped" && existing.skip_reason === skip;
      plans.push({ channel, step, action: alreadyRecorded || skip === "empty_template" ? "noop" : "record_skip", reason: skip, reclaim: existing });
      continue;
    }
    plans.push({ channel, step, action: "send", reclaim: existing });
  }
  return plans;
}
