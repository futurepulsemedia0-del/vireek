// src/lib/ivrStandards.ts
//
// IVR menu wording standards, compatible with pbx_ivr_menus / pbx_ivr_options
// (greeting_text <= 1000 chars, label <= 60 chars, digit 0-9 or *).

export interface IvrOptionInput { digit: string; label: string }
export interface IvrMenuInput {
  businessName: string;
  greeting: string;
  options: IvrOptionInput[];
  timeoutSeconds?: number;
  maxRetries?: number;
}
export interface IvrIssue { severity: "error" | "warning"; rule: string; message: string }

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function validateIvrMenu(m: IvrMenuInput): { ok: boolean; issues: IvrIssue[] } {
  const issues: IvrIssue[] = [];
  const add = (severity: IvrIssue["severity"], rule: string, message: string) => issues.push({ severity, rule, message });

  if (!m.greeting.trim()) add("error", "greeting_empty", "Greeting is empty.");
  if (m.greeting.length > 1000) add("error", "greeting_length", "Greeting exceeds 1000 characters.");
  if (m.businessName.trim() && !m.greeting.toLowerCase().includes(m.businessName.trim().toLowerCase())) {
    add("warning", "greeting_business", "Name your business in the greeting so callers know they reached the right place.");
  }
  if (words(m.greeting) > 25) add("warning", "greeting_brevity", "Keep the greeting under about 25 words (≈10 seconds).");

  if (m.options.length === 0) add("error", "no_options", "Add at least one menu option.");
  if (m.options.length > 4) add("warning", "too_many_options", "More than 4 options is hard to remember; group or use a sub-menu.");
  if (m.options.length > 9) add("error", "too_many_options", "A menu cannot have more than 9 options.");

  const seen = new Set<string>();
  let prev = -1;
  for (const o of m.options) {
    if (!/^[0-9*]$/.test(o.digit)) add("error", "digit_invalid", `"${o.digit}" is not a valid key.`);
    if (seen.has(o.digit)) add("error", "digit_duplicate", `Key ${o.digit} is used twice.`);
    seen.add(o.digit);
    const n = /^[0-9]$/.test(o.digit) ? Number(o.digit) : 99;
    if (n < prev) add("warning", "order", "List options in ascending key order.");
    prev = n;
    const label = o.label.trim();
    if (!label) add("error", "label_empty", `Key ${o.digit} has no label.`);
    if (label.length > 60) add("error", "label_length", `Key ${o.digit}: label exceeds 60 characters.`);
    if (words(label) > 6) add("warning", "label_brevity", `Key ${o.digit}: keep labels to 6 words or fewer.`);
    if (/^\s*press\b/i.test(label)) add("warning", "label_press", `Key ${o.digit}: don't start the label with "press"; the system adds it.`);
    if (/\d/.test(label)) add("warning", "label_digits", `Key ${o.digit}: avoid digits inside labels; they are confused with keys.`);
  }

  const emergency = m.options.findIndex((o) => /emergenc|urgent/i.test(o.label));
  if (emergency > 0) add("warning", "emergency_first", "Put the emergency option first.");
  if (!m.options.some((o) => o.digit === "0" || /operator|representative|person|someone|team/i.test(o.label))) {
    add("warning", "no_human", "Offer a way to reach a person (e.g. key 0).");
  }
  if (m.timeoutSeconds !== undefined && m.timeoutSeconds < 5) add("warning", "timeout_short", "Allow at least 5 seconds to respond.");
  if (m.maxRetries !== undefined && m.maxRetries > 2) add("warning", "retries_high", "More than 2 retries frustrates callers; route to voicemail or a person.");

  return { ok: !issues.some((i) => i.severity === "error"), issues };
}

/** Spoken script in the standard "For X, press N" order (action first, key last). */
export function buildIvrScript(m: IvrMenuInput): string {
  const opts = m.options.map((o) => `For ${o.label.trim().replace(/^for\s+/i, "")}, press ${o.digit === "*" ? "star" : o.digit}.`);
  return [m.greeting.trim(), ...opts].filter(Boolean).join(" ");
}
