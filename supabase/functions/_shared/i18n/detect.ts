// supabase/functions/_shared/i18n/detect.ts
//
// Deterministic, zero-cost language detection for the 9 supported languages.
// No network call, no LLM: it runs on every call transcript / inbound message
// and must never fail or add latency.
//
//  - Non-Latin scripts are identified by Unicode block (Arabic-script, Devanagari,
//    Kana, Han). Persian vs Arabic is decided by script-specific letters and
//    function words; Japanese vs Chinese by the presence of kana.
//  - Latin script is scored against function-word lists. Portuguese and
//    Italian lists are included ONLY as decoys so they are reported as
//    "unsupported" instead of being mis-filed as Spanish / French.
//  - When evidence is thin or ambiguous the result is `language: null`.
//    A wrong stored language is worse than none, because it changes how the
//    customer is spoken to.

import { normalizeLanguage, type LanguageCode } from "./languages.ts";

export interface DetectionResult {
  /** Supported language, or null when unsure / unsupported. */
  language: LanguageCode | null;
  /** 0..1. Only meaningful when `language` is set. */
  confidence: number;
  /** What was recognised, even when unsupported (e.g. "pt", "ko", "ur"). */
  detected: string | null;
}

export const NO_DETECTION: DetectionResult = { language: null, confidence: 0, detected: null };

/** Minimum confidence callers should require before persisting a detection. */
export const MIN_STORE_CONFIDENCE = 0.7;

// ---------------------------------------------------------------------------
// Function-word lists (lower-case). Chosen for high frequency in spoken /
// texted customer-service language and low overlap between languages.
// ---------------------------------------------------------------------------
const WORDS: Record<string, ReadonlySet<string>> = {
  en: new Set(
    "the and is are i you your my to of it in that have for not with this can please need hello hi thanks thank what how when would like want we our there be do does am just about it's i'm i've don't can't tomorrow today thursday monday tuesday wednesday friday saturday sunday fix broken working house heater leaking".split(
      " ",
    ),
  ),
  es: new Set(
    "el la los las de que y en un una es por con para no mi se su hola gracias necesito quiero tengo está esta cómo como qué buenos buenas días dias favor casa agua aire puedo pueden muy pero del al me le lo tiene hay estoy mañana hoy arreglar roto funciona".split(
      " ",
    ),
  ),
  fr: new Set(
    "le la les des du et est un une je il vous pour pas que qui dans mon ma mes bonjour merci besoin suis avec sur ce cette très bien ai ne nous peut plaît maison eau chauffage demain aujourd'hui réparer cassé fonctionne".split(
      " ",
    ),
  ),
  de: new Set(
    "der die das und ist nicht ich ein eine zu mit für auf den dem es wir sie haben bitte danke hallo guten tag brauche möchte mein meine haus wasser heizung kann können aber auch wie was morgen heute reparieren kaputt funktioniert".split(
      " ",
    ),
  ),
  // Decoys: recognised so they are NOT mistaken for es/fr, never returned as supported.
  pt: new Set(
    "o a os as de que e em um uma não nao com para por eu meu minha obrigado obrigada olá ola preciso você voce está estou tenho bom dia casa água agua amanhã hoje consertar quebrado funciona".split(
      " ",
    ),
  ),
  it: new Set(
    "il lo la gli di che e un una non per con mi ho sono ciao grazie buongiorno bisogno vorrei casa acqua è domani oggi riparare rotto funziona".split(
      " ",
    ),
  ),
};

const SUPPORTED_LATIN = new Set(["en", "es", "fr", "de"]);

// Persian / Arabic function words (matched on whole tokens).
const FA_WORDS = new Set(
  "است که را این من می‌خواهم میخواهم نیست هست با برای از در به یک ممنون خرابه خراب شده نمی‌کند نمیکند لطفا لطفاً امروز فردا خانه آب تعمیر".split(
    " ",
  ),
);
const AR_WORDS = new Set(
  "في من على هذا هذه أنا انا ليس لا نعم مرحبا شكرا شكراً أريد اريد يوجد هناك مع إلى الى عن كان تعطل لدي عندي اليوم غدا غداً منزل ماء تصليح".split(
    " ",
  ),
);

// ---------------------------------------------------------------------------
// Script classification
// ---------------------------------------------------------------------------
type Script = "latin" | "arabic" | "devanagari" | "kana" | "han" | "hangul" | "cyrillic" | "other";

function scriptOf(cp: number): Script {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f)) return "latin";
  if ((cp >= 0x600 && cp <= 0x6ff) || (cp >= 0x750 && cp <= 0x77f) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return "arabic";
  if (cp >= 0x900 && cp <= 0x97f) return "devanagari";
  if (cp >= 0x3040 && cp <= 0x30ff) return "kana";
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) return "han";
  if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) return "hangul";
  if (cp >= 0x400 && cp <= 0x4ff) return "cyrillic";
  return "other";
}

// Letters that exist in Persian but not Arabic, and vice versa.
const PERSIAN_ONLY = new Set(["پ", "چ", "ژ", "گ", "ک", "ی"]); // پ چ ژ گ ک ی
const ARABIC_ONLY = new Set(["ي", "ك", "ة", "ى"]); // ي ك ة ى
const URDU_ONLY = new Set(["ٹ", "ڈ", "ڑ", "ں", "ے", "ھ"]); // ٹ ڈ ڑ ں ے ھ

function stripNoise(text: string): string {
  // Token-based on purpose: regexes such as /\S+@\S+\.\S+/ backtrack quadratically on
  // long unbroken input, and this runs on untrusted webhook text.
  return text
    .split(/\s+/)
    .filter((tok) => tok && !tok.includes("@") && !/^(https?:\/\/|www\.)/i.test(tok))
    .join(" ")
    .replace(/[\d_]+/g, " ");
}

function clamp(n: number, lo = 0, hi = 0.99): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Detects the language of `text`. Pass only the CUSTOMER's words (see
 * extractCallerText) — the assistant's own lines would bias the result.
 */
export function detectLanguage(text: string | null | undefined): DetectionResult {
  if (typeof text !== "string") return NO_DETECTION;
  const cleaned = stripNoise(text.slice(0, 6000).normalize("NFC")).slice(0, 4000);

  const counts: Record<Script, number> = {
    latin: 0, arabic: 0, devanagari: 0, kana: 0, han: 0, hangul: 0, cyrillic: 0, other: 0,
  };
  let persianOnly = 0;
  let arabicOnly = 0;
  let urduOnly = 0;
  let letters = 0;

  for (const ch of cleaned) {
    if (!/\p{L}/u.test(ch)) continue;
    const cp = ch.codePointAt(0) ?? 0;
    const s = scriptOf(cp);
    counts[s]++;
    letters++;
    if (s === "arabic") {
      if (PERSIAN_ONLY.has(ch)) persianOnly++;
      if (ARABIC_ONLY.has(ch)) arabicOnly++;
      if (URDU_ONLY.has(ch)) urduOnly++;
    }
  }
  if (letters < 2) return NO_DETECTION;

  const dominant = (Object.entries(counts) as [Script, number][]).sort((a, b) => b[1] - a[1])[0];
  const [script, scriptLetters] = dominant;
  const share = scriptLetters / letters;
  if (share < 0.5) return NO_DETECTION; // mixed / noisy: don't guess

  switch (script) {
    case "kana":
      return { language: "ja", confidence: clamp(0.8 + share * 0.19), detected: "ja" };
    case "han": {
      // Han-only text could be either; kana anywhere in the text makes it Japanese.
      if (counts.kana > 0) return { language: "ja", confidence: 0.9, detected: "ja" };
      return scriptLetters >= 2
        ? { language: "zh", confidence: clamp(0.75 + share * 0.2), detected: "zh" }
        : NO_DETECTION;
    }
    case "devanagari":
      return scriptLetters >= 3
        ? { language: "hi", confidence: clamp(0.75 + share * 0.2), detected: "hi" }
        : NO_DETECTION;
    case "hangul":
      return { language: null, confidence: 0, detected: "ko" };
    case "cyrillic":
      return { language: null, confidence: 0, detected: "ru" };
    case "arabic":
      return detectArabicScript(cleaned, persianOnly, arabicOnly, urduOnly, share);
    case "latin":
      return detectLatin(cleaned);
    default:
      return NO_DETECTION;
  }
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\u200c'’]+/gu)?.map((t) => t.replace(/’/g, "'")) ?? [];
}

function detectArabicScript(
  text: string,
  persianOnly: number,
  arabicOnly: number,
  urduOnly: number,
  share: number,
): DetectionResult {
  if (urduOnly >= 2) return { language: null, confidence: 0, detected: "ur" };

  const toks = tokens(text);
  let faWords = 0;
  let arWords = 0;
  for (const t of toks) {
    const plain = t.replace(/‌/g, "");
    if (FA_WORDS.has(t) || FA_WORDS.has(plain)) faWords++;
    if (AR_WORDS.has(t) || AR_WORDS.has(plain)) arWords++;
  }
  // Persian "می" verb prefix (with or without ZWNJ) is a strong, Persian-only signal.
  const miPrefix = toks.filter((t) => /^می‌?[\p{L}]{2,}/u.test(t)).length;
  const fa = persianOnly * 2 + (faWords + miPrefix) * 3;
  const ar = arabicOnly * 2 + arWords * 3;

  if (fa === ar) return { language: null, confidence: 0, detected: null }; // e.g. "سلام" — ambiguous
  const winner = fa > ar ? "fa" : "ar";
  const margin = Math.abs(fa - ar);
  return { language: winner, confidence: clamp(0.55 + Math.min(margin, 12) * 0.035 + share * 0.05), detected: winner };
}

function detectLatin(text: string): DetectionResult {
  const toks = tokens(text).filter((t) => t.length > 0);
  if (toks.length < 2) return NO_DETECTION;

  const score: Record<string, number> = { en: 0, es: 0, fr: 0, de: 0, pt: 0, it: 0 };
  for (const t of toks) {
    // "l'eau" / "j'ai" -> also test the part after the apostrophe.
    const parts = t.includes("'") ? [t, ...t.split("'").filter(Boolean)] : [t];
    for (const p of parts) {
      for (const lang of Object.keys(score)) if (WORDS[lang].has(p)) score[lang]++;
    }
  }

  const lower = text.toLowerCase();
  const bonus = (re: RegExp, lang: string, points: number) => {
    if (re.test(lower)) score[lang] += points;
  };
  bonus(/[ñ¿¡]/, "es", 3);
  bonus(/ß/, "de", 3);
  bonus(/[äöü]/, "de", 2);
  bonus(/[èêëîôûœ]/, "fr", 2);
  bonus(/[ãõ]/, "pt", 3);
  bonus(/[ìò]/, "it", 2);

  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const second = ranked[1][1];
  const margin = topScore - second;
  if (topScore < 2 || margin <= 0) return NO_DETECTION;

  if (!SUPPORTED_LATIN.has(top)) return { language: null, confidence: 0, detected: top };

  const confidence = clamp(0.45 + margin * 0.12 + Math.min(toks.length, 15) * 0.02);
  return { language: normalizeLanguage(top), confidence, detected: top };
}

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------

const CALLER_ROLE = /^(user|customer|caller|client)\s*:\s*/i;
const AGENT_ROLE = /^(ai|assistant|bot|agent|system|sarah)\s*:\s*/i;

/**
 * Vapi transcripts are "AI: ...\nUser: ..." lines. Returns only the caller's
 * lines. If the text carries no role labels at all it is returned unchanged
 * (e.g. an SMS body).
 */
export function extractCallerText(transcript: string | null | undefined): string {
  if (typeof transcript !== "string" || !transcript.trim()) return "";
  const lines = transcript.split(/\r?\n/);
  const labelled = lines.some((l) => CALLER_ROLE.test(l.trim()) || AGENT_ROLE.test(l.trim()));
  if (!labelled) return transcript.trim();

  const out: string[] = [];
  let inCaller = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (CALLER_ROLE.test(line)) {
      inCaller = true;
      out.push(line.replace(CALLER_ROLE, ""));
    } else if (AGENT_ROLE.test(line)) {
      inCaller = false;
    } else if (inCaller && line) {
      out.push(line); // continuation of a multi-line caller turn
    }
  }
  return out.join("\n").trim();
}

/** Detects the caller's language from a full Vapi transcript. */
export function detectFromTranscript(transcript: string | null | undefined): DetectionResult {
  return detectLanguage(extractCallerText(transcript));
}
