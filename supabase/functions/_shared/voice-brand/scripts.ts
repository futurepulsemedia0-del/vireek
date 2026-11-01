// supabase/functions/_shared/voice-brand/scripts.ts
//
// Script library: voice lines + SMS templates with SAFE merge fields.
// - Voice lines are spoken by Sarah (short, no symbols).
// - AI disclosure is NOT written into greetings: it is prepended at runtime
//   (existing {{ai_disclosure}} flow) so it stays per-language and drift-checked.
// - Recording-consent wording comes from compliance/recordingConsent.ts.
// LEGAL: all SMS opt-out/HELP wording and consent lines need counsel review
// (TCPA, CTIA guidelines, state recording laws) before production use.

export const MERGE_FIELDS = [
  "business_name", "assistant_name", "callback_number", "hours_text",
  "holiday_name", "tech_name", "eta_window", "appointment_time",
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export type MergeValues = Partial<Record<MergeField, string>>;

export type ScriptChannel = "voice" | "sms";

export interface ScriptTemplate {
  id: string;
  channel: ScriptChannel;
  /** A/B variants; first is the default. */
  variants: readonly string[];
  /** Fields that MUST be supplied for this template. */
  required: readonly MergeField[];
}

const STOP = "Reply STOP to opt out, HELP for help.";

export const SCRIPT_LIBRARY: Record<string, ScriptTemplate> = {
  greeting_business_hours: {
    id: "greeting_business_hours", channel: "voice", required: ["business_name", "assistant_name"],
    variants: [
      "Thanks for calling {{business_name}}, this is {{assistant_name}}. How can I help?",
      "Hi, you've reached {{business_name}}. I'm {{assistant_name}} — what can I do for you today?",
    ],
  },
  greeting_after_hours: {
    id: "greeting_after_hours", channel: "voice", required: ["business_name", "assistant_name"],
    variants: [
      "Thanks for calling {{business_name}}. The office is closed right now, but I'm {{assistant_name}} and I can help. What's going on?",
      "You've reached {{business_name}} after hours. I'm {{assistant_name}} — tell me what's happening and I'll make sure the right person sees it.",
    ],
  },
  greeting_emergency: {
    id: "greeting_emergency", channel: "voice", required: ["business_name", "assistant_name"],
    variants: [
      "{{business_name}} emergency line, this is {{assistant_name}}. Is anyone in danger right now?",
      "You've reached {{business_name}}. I'm {{assistant_name}}. Tell me what's happening — if anyone is in danger, hang up and call 911.",
    ],
  },
  greeting_holiday: {
    id: "greeting_holiday", channel: "voice", required: ["business_name", "assistant_name", "holiday_name"],
    variants: [
      "Happy {{holiday_name}} from {{business_name}}. I'm {{assistant_name}} — how can I help?",
    ],
  },
  transfer: {
    id: "transfer", channel: "voice", required: [],
    variants: ["Let me connect you with someone who can help. One moment.", "I'm transferring you now. If we get cut off, we'll call you right back."],
  },
  hold: {
    id: "hold", channel: "voice", required: [],
    variants: ["Thanks for holding — I'm still working on that for you.", "Still with you. Just another moment."],
  },
  confirmation_booking: {
    id: "confirmation_booking", channel: "voice", required: ["appointment_time", "business_name"],
    variants: ["You're booked for {{appointment_time}} with {{business_name}}. You'll get a text confirmation shortly."],
  },
  error_didnt_catch: {
    id: "error_didnt_catch", channel: "voice", required: [],
    variants: ["Sorry, I didn't catch that. Could you say it once more?", "I missed that — one more time, please?"],
  },
  error_system: {
    id: "error_system", channel: "voice", required: ["business_name", "callback_number"],
    variants: ["I'm having trouble on my end. I'll have {{business_name}} call you back — or you can reach them at {{callback_number}}."],
  },
  voicemail_prompt: {
    id: "voicemail_prompt", channel: "voice", required: ["business_name"],
    variants: ["You've reached the voicemail for {{business_name}}. Please leave your name, number and what you need, and we'll call you back."],
  },
  sms_missed_call: {
    id: "sms_missed_call", channel: "sms", required: ["business_name"],
    variants: [`{{business_name}}: Sorry we missed your call. How can we help? Reply here and we'll get right back to you. ${STOP}`],
  },
  sms_booking_confirmation: {
    id: "sms_booking_confirmation", channel: "sms", required: ["business_name", "appointment_time"],
    variants: [`{{business_name}}: You're confirmed for {{appointment_time}}. Need to change it? Just reply. ${STOP}`],
  },
  sms_eta: {
    id: "sms_eta", channel: "sms", required: ["business_name", "tech_name", "eta_window"],
    variants: [`{{business_name}}: {{tech_name}} is on the way, arriving {{eta_window}}. ${STOP}`],
  },
  sms_opt_in_confirm: {
    id: "sms_opt_in_confirm", channel: "sms", required: ["business_name"],
    variants: ["{{business_name}}: You're subscribed to service updates. Msg frequency varies. Msg&data rates may apply. Reply STOP to opt out, HELP for help."],
  },
  sms_stop_reply: {
    id: "sms_stop_reply", channel: "sms", required: ["business_name"],
    variants: ["{{business_name}}: You're unsubscribed and won't receive more texts. Reply START to resubscribe."],
  },
  sms_help_reply: {
    id: "sms_help_reply", channel: "sms", required: ["business_name", "callback_number"],
    variants: ["{{business_name}}: For help call {{callback_number}}. Msg&data rates may apply. Reply STOP to opt out."],
  },
};

/** Strip control chars, template syntax and URLs; cap length. Values are data, never instructions. */
export function sanitizeMergeValue(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\{\{|\}\}/g, "")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export interface RenderResult {
  text: string;
  missing: MergeField[];
}

/** Single-pass render: unknown placeholders are left out of MERGE_FIELDS and reported, values are never re-interpolated. */
export function renderScript(templateId: string, values: MergeValues, variantIndex = 0): RenderResult {
  const tpl = SCRIPT_LIBRARY[templateId];
  if (!tpl) throw new Error(`Unknown script template: ${templateId}`);
  const variant = tpl.variants[variantIndex] ?? tpl.variants[0];
  const clean: MergeValues = {};
  for (const f of MERGE_FIELDS) {
    const v = values[f];
    if (typeof v === "string" && sanitizeMergeValue(v)) clean[f] = sanitizeMergeValue(v);
  }
  const missing = tpl.required.filter((f) => !clean[f]);
  const text = variant.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, key: string) => clean[key as MergeField] ?? "");
  return { text: text.replace(/\s{2,}/g, " ").trim(), missing: missing as MergeField[] };
}

/** Compose the first spoken message: disclosure → greeting → recording notice (if any). Mirrors the live firstMessage order. */
export function composeOpening(parts: { disclosure?: string | null; recordingNotice?: string | null; greeting: string }): string {
  return [parts.disclosure, parts.greeting, parts.recordingNotice].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
}

/** GSM-7 vs UCS-2 segment estimate (160/153 vs 70/67). Basic GSM charset only; extended chars count as 2. */
const GSM7 = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€";
export function smsSegments(text: string): { segments: number; encoding: "GSM-7" | "UCS-2"; chars: number } {
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7.includes(ch)) units += 1;
    else if (GSM7_EXT.includes(ch)) units += 2;
    else { gsm = false; break; }
  }
  if (gsm) return { segments: units <= 160 ? 1 : Math.ceil(units / 153), encoding: "GSM-7", chars: units };
  const u = [...text].length;
  return { segments: u <= 70 ? 1 : Math.ceil(u / 67), encoding: "UCS-2", chars: u };
}

export const SMS_OPT_OUT_PATTERN = /\bSTOP\b/;
