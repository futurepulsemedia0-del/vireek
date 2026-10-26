// supabase/functions/_shared/richMessaging/cards.ts
//
// Rich-card templates (booking confirmation, technician ETA, pay-now, reschedule),
// content validation and the plain-text (SMS) rendering used for automatic fallback.
// Pure module: no I/O.

import type { RichAction, RichCard, RichContent } from "./types.ts";

export const LIMITS = { title: 100, description: 400, label: 25, actions: 4, text: 1600, url: 2048 } as const;

export interface Brand {
  name: string;
  logoUrl?: string | null;
  phone?: string | null;
}

export type CardTemplate =
  | { template: "booking_confirmation"; jobId: string; service: string; startsAt: string; timeZone: string; address?: string | null; manageUrl?: string | null }
  | { template: "technician_eta"; jobId: string; technicianName: string; etaMinutes?: number | null; etaAt?: string | null; timeZone: string; trackUrl?: string | null; vehicle?: string | null }
  | { template: "pay_now"; invoiceRef: string; amountCents: number; currency?: string; description?: string | null; payUrl: string; dueDate?: string | null; timeZone?: string }
  | { template: "reschedule"; jobId: string; service: string; startsAt: string; timeZone: string; rescheduleUrl?: string | null };

export const CARD_TEMPLATES = ["booking_confirmation", "technician_eta", "pay_now", "reschedule"] as const;

export class CardError extends Error {}

// ---- helpers --------------------------------------------------------------------

export function clip(input: string, max: number): string {
  const s = input.replace(/[ \t]+\n/g, "\n").trim();
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function isHttpsUrl(value: string): boolean {
  if (typeof value !== "string" || value.length > LIMITS.url) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function isE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}

const REF_STRIP = /[^A-Za-z0-9_.-]/g;

/** Compact, opaque postback id carried by reply buttons: act:<action>:<ref>. */
export function encodePostback(action: string, ref: string): string {
  return `act:${action.replace(REF_STRIP, "").slice(0, 32)}:${ref.replace(REF_STRIP, "").slice(0, 64)}`;
}

export function parsePostback(data: string | null | undefined): { action: string; ref: string } | null {
  const m = /^act:([A-Za-z0-9_.-]{1,32}):([A-Za-z0-9_.-]{0,64})$/.exec(data ?? "");
  return m ? { action: m[1], ref: m[2] } : null;
}

export function formatWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  let out: string;
  try {
    out = new Intl.DateTimeFormat("en-US", { ...opts, timeZone }).format(d);
  } catch {
    out = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(d);
  }
  return out.replace(/[\u202f\u00a0]/g, " ");
}

export function formatMoney(cents: number, currency = "USD"): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function formatDay(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(d);
  }
}

// ---- SMS fallback rendering -----------------------------------------------------

/** Plain-text rendering of a card: what the customer gets when RCS/Apple cannot be used. */
export function renderCardAsText(card: RichCard, brandName: string): string {
  const lines: string[] = [`${brandName}: ${card.title}`];
  if (card.description) lines.push(card.description);
  const extras: string[] = [];
  for (const a of card.actions) {
    if (a.type === "url") extras.push(`${a.label}: ${a.value}`);
    else if (a.type === "call") extras.push(`${a.label}: ${a.value}`);
    else if (a.keyword) extras.push(`Reply ${a.keyword} to ${a.label.toLowerCase()}.`);
  }
  if (extras.length) lines.push("", ...extras);
  return clip(lines.join("\n"), LIMITS.text);
}

// ---- validation -----------------------------------------------------------------

export function validateAction(a: RichAction): string | null {
  if (!a.label?.trim()) return "Action label is required";
  if (a.label.length > LIMITS.label) return `Action label exceeds ${LIMITS.label} characters`;
  if (a.type === "url" && !isHttpsUrl(a.value)) return `Action "${a.label}" needs an https URL`;
  if (a.type === "call" && !isE164(a.value)) return `Action "${a.label}" needs an E.164 phone number`;
  if (a.type === "reply" && !a.value?.trim()) return `Action "${a.label}" needs a postback id`;
  return null;
}

/** Returns an error message, or null when the content is safe to send. */
export function validateContent(content: RichContent): string | null {
  if (content.kind === "text") {
    if (!content.text?.trim()) return "Message text is required";
    if (content.text.length > LIMITS.text) return `Message exceeds ${LIMITS.text} characters`;
    return null;
  }
  const { card } = content;
  if (!card.title?.trim()) return "Card title is required";
  if (card.title.length > LIMITS.title) return `Card title exceeds ${LIMITS.title} characters`;
  if ((card.description?.length ?? 0) > LIMITS.description) return `Card description exceeds ${LIMITS.description} characters`;
  if (card.imageUrl && !isHttpsUrl(card.imageUrl)) return "Card image must be an https URL";
  if (card.actions.length > LIMITS.actions) return `A card supports at most ${LIMITS.actions} actions`;
  for (const a of card.actions) {
    const err = validateAction(a);
    if (err) return err;
  }
  if (!content.fallbackText?.trim()) return "Card fallback text is required";
  return null;
}

/** Text used for the SMS fallback of any content. */
export function fallbackTextOf(content: RichContent): string {
  return content.kind === "text" ? content.text : content.fallbackText;
}

/** Short plain-text rendering stored in rich_messages.body (inbox list / search). */
export function bodyOf(content: RichContent): string {
  if (content.kind === "text") return content.text;
  return [content.card.title, content.card.description].filter(Boolean).join(" — ");
}

// ---- templates ------------------------------------------------------------------

function make(brand: Brand, card: RichCard): RichContent {
  const content: RichContent = {
    kind: "card",
    card,
    fallbackText: renderCardAsText(card, brand.name),
  };
  const err = validateContent(content);
  if (err) throw new CardError(err);
  return content;
}

function reply(label: string, value: string, keyword: string): RichAction {
  return { type: "reply", label, value, keyword };
}

function maybeUrl(label: string, url: string | null | undefined): RichAction[] {
  return url && isHttpsUrl(url) ? [{ type: "url", label, value: url }] : [];
}

function maybeCall(label: string, phone: string | null | undefined): RichAction[] {
  return phone && isE164(phone) ? [{ type: "call", label, value: phone }] : [];
}

export function buildCard(t: CardTemplate, brand: Brand): RichContent {
  const name = brand.name?.trim() || "Your service team";
  const b: Brand = { ...brand, name };

  switch (t.template) {
    case "booking_confirmation": {
      const when = formatWhen(t.startsAt, t.timeZone);
      if (!when) throw new CardError("startsAt is not a valid date");
      return make(b, {
        title: "Booking confirmed",
        description: clip([t.service, when, t.address ?? ""].filter(Boolean).join("\n"), LIMITS.description),
        imageUrl: b.logoUrl ?? undefined,
        actions: [
          ...maybeUrl("View details", t.manageUrl),
          reply("Reschedule", encodePostback("reschedule", t.jobId), "RESCHEDULE"),
          ...maybeCall("Call us", b.phone),
        ].slice(0, LIMITS.actions),
      });
    }
    case "technician_eta": {
      let arrival = "";
      if (t.etaAt) arrival = `Arriving around ${formatWhen(t.etaAt, t.timeZone).split(", ").slice(-1)[0]}`;
      else if (t.etaMinutes != null && t.etaMinutes >= 0) arrival = `Arriving in about ${Math.max(1, Math.round(t.etaMinutes))} min`;
      if (!arrival) throw new CardError("etaMinutes or etaAt is required");
      return make(b, {
        title: clip(`${t.technicianName} is on the way`, LIMITS.title),
        description: clip([arrival, t.vehicle ?? ""].filter(Boolean).join("\n"), LIMITS.description),
        imageUrl: b.logoUrl ?? undefined,
        actions: [
          ...maybeUrl("Track technician", t.trackUrl),
          ...maybeCall("Call us", b.phone),
          reply("Reschedule", encodePostback("reschedule", t.jobId), "RESCHEDULE"),
        ].slice(0, LIMITS.actions),
      });
    }
    case "pay_now": {
      if (!Number.isInteger(t.amountCents) || t.amountCents <= 0) throw new CardError("amountCents must be a positive integer");
      if (!isHttpsUrl(t.payUrl)) throw new CardError("payUrl must be an https URL");
      const due = t.dueDate ? formatDay(t.dueDate, t.timeZone ?? "UTC") : "";
      return make(b, {
        title: clip(`Invoice ${t.invoiceRef} · ${formatMoney(t.amountCents, t.currency)}`, LIMITS.title),
        description: clip([t.description ?? "", due ? `Due ${due}` : ""].filter(Boolean).join("\n"), LIMITS.description) || undefined,
        imageUrl: b.logoUrl ?? undefined,
        actions: [
          { type: "url", label: "Pay now", value: t.payUrl },
          reply("I have a question", encodePostback("question", t.invoiceRef), "HELP"),
        ],
      });
    }
    case "reschedule": {
      const when = formatWhen(t.startsAt, t.timeZone);
      if (!when) throw new CardError("startsAt is not a valid date");
      return make(b, {
        title: "Need to reschedule?",
        description: clip(`${t.service}\nCurrently ${when}`, LIMITS.description),
        imageUrl: b.logoUrl ?? undefined,
        actions: [
          ...maybeUrl("Pick a new time", t.rescheduleUrl),
          reply("Reschedule", encodePostback("reschedule", t.jobId), "RESCHEDULE"),
          reply("Keep appointment", encodePostback("keep", t.jobId), "KEEP"),
        ],
      });
    }
    default:
      throw new CardError("Unknown card template");
  }
}
