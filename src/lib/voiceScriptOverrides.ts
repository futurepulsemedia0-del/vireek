// src/lib/voiceScriptOverrides.ts
//
// Validation + resolution for per-business script overrides (voice_script_overrides).

import { MERGE_FIELDS, SCRIPT_LIBRARY, renderScript, smsSegments, type MergeValues } from "../../supabase/functions/_shared/voice-brand/scripts";
import { scoreTurn } from "../../supabase/functions/_shared/voice-brand/styleCheck";

export const MAX_OVERRIDE_CHARS = 400;

const SAMPLE: MergeValues = {
  business_name: "Northside Plumbing & Heating", assistant_name: "Sarah", callback_number: "five five five, oh one two three",
  hours_text: "eight to five", holiday_name: "Thanksgiving", tech_name: "Alexander", eta_window: "between 2 and 3 PM", appointment_time: "Tuesday at 2 PM",
};

export function validateOverride(templateId: string, body: string): { ok: boolean; errors: string[]; segments?: number } {
  const tpl = SCRIPT_LIBRARY[templateId];
  if (!tpl) return { ok: false, errors: ["Unknown template."] };
  const errors: string[] = [];
  const text = body.trim();
  if (!text) errors.push("Text is empty.");
  if (text.length > MAX_OVERRIDE_CHARS) errors.push(`Maximum ${MAX_OVERRIDE_CHARS} characters.`);

  const used = [...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
  for (const f of used) if (!(MERGE_FIELDS as readonly string[]).includes(f)) errors.push(`Unknown field {{${f}}}.`);
  if (/\{\{|\}\}/.test(text.replace(/\{\{\s*[a-z_]+\s*\}\}/g, ""))) errors.push("Unbalanced {{ }}.");
  for (const f of tpl.required) if (!used.includes(f)) errors.push(`Must include {{${f}}}.`);
  if (errors.length) return { ok: false, errors };

  const rendered = renderScript(templateId, SAMPLE, 0, text).text;
  if (tpl.channel === "voice") {
    const s = scoreTurn(rendered);
    for (const v of s.violations) errors.push(`${v.rule}: ${v.detail}`);
    return { ok: errors.length === 0, errors };
  }
  if (templateId !== "sms_stop_reply" && !/\bSTOP\b/.test(rendered)) errors.push("SMS must include opt-out wording (e.g. Reply STOP to opt out).");
  const seg = smsSegments(rendered);
  if (seg.segments > 2) errors.push(`Too long: ${seg.segments} SMS segments (max 2).`);
  return { ok: errors.length === 0, errors, segments: seg.segments };
}

/** Resolve the text to render: valid override, else default variant. Invalid stored overrides are ignored. */
export function resolveOverrideBody(templateId: string, overrides: Record<string, string>): string | undefined {
  const b = overrides[templateId];
  return b && validateOverride(templateId, b).ok ? b : undefined;
}
