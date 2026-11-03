// supabase/functions/_shared/interpreter/runtime.ts
//
// Server glue used by vapi-webhook (mode a: Sarah handles the whole call in the
// caller's language). Every function is best-effort and NEVER throws: interpretation
// is an enhancement and must not be able to break a call webhook.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { geminiTranslate } from "./gemini.ts";
import { identifyLanguage } from "./langid.ts";
import { DEFAULT_GREETINGS, INTERP_META, fill, normalizeInterpLang, type InterpLang } from "./languages.ts";
import { verifyTranslation } from "./mt.ts";
import { detectEmergency } from "./safety.ts";
import { extractCallerText } from "../i18n/detect.ts";

export interface InterpreterSettings {
  enabled: boolean;
  languages: InterpLang[];
  greetings: Partial<Record<InterpLang, string>>;
  retentionDays: number;
}

const warn = (event: string, err: unknown) => console.error(JSON.stringify({ event, error: err instanceof Error ? err.message : String(err) }));

export async function loadInterpreterSettings(admin: SupabaseClient, userId: string): Promise<InterpreterSettings | null> {
  try {
    const { data } = await admin.from("interpreter_settings").select("enabled, enabled_languages, greetings, retention_days").eq("user_id", userId).maybeSingle();
    if (!data?.enabled) return null;
    const languages = ((data.enabled_languages as string[]) ?? []).map(normalizeInterpLang).filter((l): l is InterpLang => !!l);
    const greetings: InterpreterSettings["greetings"] = {};
    for (const [k, v] of Object.entries((data.greetings ?? {}) as Record<string, unknown>)) {
      const l = normalizeInterpLang(k);
      if (l && typeof v === "string" && v.trim()) greetings[l] = v.trim().slice(0, 400);
    }
    return { enabled: true, languages, greetings, retentionDays: Number(data.retention_days) || 90 };
  } catch (e) {
    warn("interpreter_settings_failed", e);
    return null;
  }
}

/** Prompt block for Sarah (variable `interpreter_context`). Empty string when the feature is off. */
export function buildInterpreterContext(s: InterpreterSettings | null): string {
  if (!s || !s.languages.length) return "";
  const names = s.languages.map((l) => INTERP_META[l].name).join(", ");
  return [
    `INTERPRETATION: you can run the whole call in: ${names}. Detect the caller's language from their first words.`,
    "If you are not sure, politely ask in that language whether they would like to continue in it; if they say English or do not answer, continue in English.",
    "The caller may say 'English' at any time to switch; honour it immediately.",
    "Read back every address, phone number, appointment day and time, and price in the caller's language and wait for a clear yes before saving it.",
    "Keep street names, business names, phone digits and model numbers exactly as spoken.",
    "NEVER invent or improvise safety advice. For gas smell, fire, smoke, carbon monoxide, flooding or electrical sparks: use the safety instruction the business has approved, say you are connecting a person now, and transfer the call.",
    "If you cannot understand the caller after two tries, offer a human team member instead of guessing.",
  ].join(" ");
}

/** Business-written greeting for this language (name/assistant filled), else null. */
export function customGreeting(s: InterpreterSettings | null, lang: InterpLang | null, business: string | null, assistant: string | null): string | null {
  if (!s || !lang || lang === "en") return null;
  const tpl = s.greetings[lang];
  if (!tpl || !business) return null;
  return fill(tpl, { business, assistant: assistant || "Sarah" });
}
export { DEFAULT_GREETINGS };

interface Line { role: "caller" | "assistant"; text: string }

function parseLines(transcript: string): Line[] {
  const out: Line[] = [];
  for (const raw of transcript.split(/\r?\n/)) {
    const m = raw.trim().match(/^(user|customer|caller|client|ai|assistant|bot|agent|sarah)\s*:\s*(.*)$/i);
    if (m) out.push({ role: /^(user|customer|caller|client)$/i.test(m[1]) ? "caller" : "assistant", text: m[2].trim() });
    else if (raw.trim() && out.length) out[out.length - 1].text += ` ${raw.trim()}`;
  }
  return out.filter((l) => l.text);
}

/**
 * End of an assistant-mode call: when the caller spoke a non-English enabled language,
 * store an interpreter session with ORIGINAL + English per turn, calls.transcript_en,
 * and the customer's spoken language. Idempotent per (user, vapi call, mode).
 */
export async function recordAssistantCall(
  admin: SupabaseClient,
  input: { userId: string; vapiCallId: string; callId: string; callerNumber: string | null; transcript: string; settings: InterpreterSettings | null },
): Promise<{ recorded: boolean; language?: InterpLang }> {
  try {
    const { settings, transcript } = input;
    if (!settings || !transcript.trim()) return { recorded: false };
    const id = identifyLanguage(extractCallerText(transcript));
    const lang = id.lang;
    if (!lang || lang === "en" || id.confidence < 0.7 || !settings.languages.includes(lang)) return { recorded: false };

    const { data: existing } = await admin.from("interpreter_sessions").select("id").eq("user_id", input.userId).eq("vapi_call_id", input.vapiCallId).eq("mode", "assistant").maybeSingle();
    if (existing) return { recorded: false };

    const lines = parseLines(transcript).slice(0, 80);
    const translate = geminiTranslate({ apiKey: Deno.env.get("GEMINI_API_KEY") ?? "", model: Deno.env.get("GEMINI_MODEL") || undefined });
    const out: { line: Line; en: string | null; conf: number | null; flags: string[]; critical: unknown }[] = [];
    for (let i = 0; i < lines.length; i += 4) { // bounded concurrency
      const batch = lines.slice(i, i + 4);
      out.push(...await Promise.all(batch.map(async (line) => {
        const from: InterpLang = lang; // in assistant mode Sarah speaks the caller's language too
        const r = await translate({ text: line.text.slice(0, 1500), from, to: "en", speaker: line.role === "caller" ? "caller" : "staff" });
        if (!r) return { line, en: null, conf: null, flags: ["translation_failed"], critical: {} };
        const v = verifyTranslation(line.text, from, r.text, "en");
        const flags = [...(v.criticalOk ? [] : ["critical_mismatch"]), ...(v.glossaryMisses.length ? ["glossary_miss"] : [])];
        return { line, en: r.text, conf: r.confidence, flags, critical: { values: v.src, ok: v.criticalOk } };
      })));
    }

    const { data: session, error } = await admin.from("interpreter_sessions").insert({
      user_id: input.userId, call_id: input.callId, vapi_call_id: input.vapiCallId, mode: "assistant", caller_language: lang,
      status: "ended", started_at: new Date().toISOString(), ended_at: new Date().toISOString(), training_consent: false,
    }).select("id").maybeSingle();
    if (error || !session) { if (error && error.code !== "23505") warn("interpreter_session_insert_failed", error); return { recorded: false }; }

    await admin.from("interpreter_turns").insert(out.map((o, i) => ({
      session_id: session.id, user_id: input.userId, seq: i + 1, speaker: o.line.role === "caller" ? "caller" : "staff",
      from_lang: lang, to_lang: "en", original: o.line.text.slice(0, 4000), translated: o.en?.slice(0, 8000) ?? null,
      mt_confidence: o.conf, action: o.en ? "relay" : "translation_failed", critical: o.critical, flags: o.flags,
      emergency: o.line.role === "caller" ? detectEmergency(o.line.text).kinds : [],
    })));
    const transcriptEn = out.map((o) => `${o.line.role === "caller" ? "Caller" : "Sarah"}: ${o.en ?? "[translation unavailable]"}`).join("\n");
    await admin.from("calls").update({ interpreter_language: lang, interpretation_mode: "assistant", transcript_en: transcriptEn.slice(0, 60000) }).eq("id", input.callId).eq("user_id", input.userId);
    if (input.callerNumber) await admin.rpc("record_spoken_language", { p_user_id: input.userId, p_phone: input.callerNumber, p_language: lang });
    return { recorded: true, language: lang };
  } catch (e) {
    warn("record_assistant_call_failed", e);
    return { recorded: false };
  }
}
