// supabase/functions/_shared/ai-disclosure/select.ts
//
// Pure: which disclosure wording/language a given caller should hear.
//  1. caller language == language of the account script  -> the account script
//  2. caller language known, different                   -> built-in translation
//  3. caller language unknown                            -> the account script (fallback)

import { DEFAULT_LANGUAGE, type LanguageCode } from "../i18n/languages.ts";

export const DEFAULT_DISCLOSURE_SCRIPT = "This call is answered by an AI voice assistant, not a live person.";

/** Plain-language equivalents of the default sentence, used for non-matching caller languages. */
export const BUILTIN_DISCLOSURES: Record<LanguageCode, string> = {
  en: DEFAULT_DISCLOSURE_SCRIPT,
  es: "Esta llamada la atiende un asistente de voz con inteligencia artificial, no una persona real.",
  zh: "本次通话由 AI 语音助手接听，而非真人。",
  hi: "यह कॉल एक एआई वॉइस असिस्टेंट द्वारा उठाई गई है, किसी वास्तविक व्यक्ति द्वारा नहीं।",
  fr: "Cet appel est pris en charge par un assistant vocal basé sur l'intelligence artificielle, et non par une personne.",
  de: "Dieser Anruf wird von einem KI-Sprachassistenten beantwortet, nicht von einer realen Person.",
  ar: "يتم الرد على هذه المكالمة بواسطة مساعد صوتي يعمل بالذكاء الاصطناعي، وليس شخصاً حقيقياً.",
  fa: "این تماس توسط یک دستیار صوتی هوش مصنوعی پاسخ داده می‌شود، نه یک انسان واقعی.",
  ja: "この通話はAI音声アシスタントが対応しており、実際の人間ではありません。",
};

export type SelectionReason = "caller_language_match" | "caller_language_translation" | "default_fallback";
export type SelectionSource = "business_profile" | "builtin_translation";

export interface DisclosureSelection {
  language: LanguageCode;
  text: string;
  source: SelectionSource;
  reason: SelectionReason;
}

export function selectDisclosure(input: {
  script: string | null | undefined;
  scriptLanguage: LanguageCode | null | undefined;
  callerLanguage: LanguageCode | null | undefined;
}): DisclosureSelection {
  const script = input.script?.trim() || DEFAULT_DISCLOSURE_SCRIPT;
  const scriptLanguage = input.scriptLanguage ?? DEFAULT_LANGUAGE;
  const caller = input.callerLanguage ?? null;

  if (!caller) return { language: scriptLanguage, text: script, source: "business_profile", reason: "default_fallback" };
  if (caller === scriptLanguage) return { language: scriptLanguage, text: script, source: "business_profile", reason: "caller_language_match" };
  return { language: caller, text: BUILTIN_DISCLOSURES[caller], source: "builtin_translation", reason: "caller_language_translation" };
}
