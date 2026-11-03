// supabase/functions/_shared/interpreter/langid.ts
//
// First-utterance language identification for live calls, plus the "switch
// language" controls (spoken command and keypad).
//
// Builds on ../i18n/detect.ts (9 languages, no network, never throws) and adds
// Vietnamese and Portuguese, which that module deliberately does not return.
// Everything here is deterministic and runs in well under a millisecond, so it
// adds no latency to a turn.
//
// Decision policy (see `decideLanguage`):
//   confidence >= 0.85  -> "switch"   speak that language, no question asked
//   0.55 .. 0.85        -> "confirm"  ask politely IN that language, accept yes / "English"
//   otherwise           -> "fallback" stay in English, offer the language menu
// A wrong guess changes how a frightened caller is spoken to, so the middle band
// always asks instead of assuming.

import { detectLanguage } from "../i18n/detect.ts";
import { INTERP_LANGUAGES, INTERP_META, normalizeInterpLang, type InterpLang } from "./languages.ts";
import { cap, fold, tokenize } from "./text.ts";

export interface LangId {
  lang: InterpLang | null;
  /** 0..1, only meaningful when `lang` is set. */
  confidence: number;
  /** What was recognised even if unsupported ("ko", "ru", "ur"...). */
  detected: string | null;
}

export const NO_ID: LangId = { lang: null, confidence: 0, detected: null };
export const SWITCH_CONFIDENCE = 0.85;
export const CONFIRM_CONFIDENCE = 0.55;

const clamp = (n: number, lo = 0, hi = 0.97) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------- Vietnamese
const VI_WORDS = new Set(
  "tôi của và là không có được nhà nước xin chào cần sửa ống bị rò hỏng điều hòa máy lạnh nóng lạnh anh chị em bạn cho hỏi giúp mình ơi dạ vâng ạ rồi nhé đang hôm nay ngày mai sáng chiều tối giờ nhờ đến thợ".split(" "),
);
const VI_ONLY = /[ăâđêôơưĂÂĐÊÔƠƯ]/;
const VI_TONED = /[Ạ-ỹ]/; // Latin Extended Additional: ạ ả ấ ầ ẩ ẫ ậ ắ ằ ẳ ẵ ặ ẹ ẻ ẽ ế ề ể ễ ệ ỉ ị ọ ỏ ố ồ ổ ỗ ộ ớ ờ ở ỡ ợ ụ ủ ứ ừ ử ữ ự ỳ ỵ ỷ ỹ

function scoreVietnamese(text: string): LangId {
  const t = cap(text).normalize("NFC").toLowerCase();
  const toks = tokenize(t);
  if (!toks.length) return NO_ID;
  let letters = 0;
  let viLetters = 0;
  for (const ch of t) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    if (VI_ONLY.test(ch) || VI_TONED.test(ch)) viLetters++;
  }
  const words = toks.filter((w) => VI_WORDS.has(w)).length;
  if (viLetters + words === 0) return NO_ID;
  // Unaccented Vietnamese ("toi can sua ong nuoc") is not detectable reliably: stays unknown.
  const evidence = viLetters * 1.0 + words * 1.5;
  const density = viLetters / Math.max(letters, 1);
  if (evidence < 3 || (density < 0.04 && words < 2)) return NO_ID;
  return { lang: "vi", confidence: clamp(0.5 + Math.min(evidence, 12) * 0.04 + density * 0.4), detected: "vi" };
}

// ---------------------------------------------------------------- Portuguese
// Words that are Portuguese and NOT Spanish (shared words like "de", "que", "para" are excluded).
const PT_ONLY = new Set(
  "não nao você voce vocês obrigado obrigada olá estou tenho preciso também tambem nós eu meu minha é um uma houve cano muito está estão fazer quero consertar vazamento encanador amanhã hoje água ligue aqui ainda então pode favor casa torneira chuveiro geladeira aquecedor ar-condicionado".split(" "),
);
const ES_ONLY = new Set(
  "no usted ustedes gracias hola estoy tengo necesito también nosotros yo mi muy está están hacer quiero arreglar fuga plomero mañana hoy agua llame aquí todavía entonces puede favor casa grifo ducha refrigerador calentador".split(" "),
);

function scorePortuguese(text: string): LangId {
  const t = cap(text).normalize("NFC").toLowerCase();
  const toks = tokenize(t);
  if (toks.length < 2) return NO_ID;
  let pt = 0;
  let es = 0;
  for (const w of toks) {
    if (PT_ONLY.has(w)) pt++;
    if (ES_ONLY.has(w) && !PT_ONLY.has(w)) es++;
  }
  if (/[ãõç]/.test(t)) pt += 2;
  if (/[ñ¿¡]/.test(t)) es += 3;
  if (/(?:ção|ções|ões|ãe|lh[aoe])\b/.test(t)) pt += 1;
  if (pt < 2 || pt <= es) return NO_ID;
  return { lang: "pt", confidence: clamp(0.5 + Math.min(pt - es, 8) * 0.06), detected: "pt" };
}

// ------------------------------------------------------------------- one-word greetings
const GREETINGS: { re: RegExp; lang: InterpLang; confidence: number }[] = [
  { re: /^(?:hola|buenas|buenos días|buenas tardes|buenas noches|buen día)[\s.!¡,]*$/iu, lang: "es", confidence: 0.7 },
  { re: /^(?:olá|ola|oi|bom dia|boa tarde|boa noite)[\s.!,]*$/iu, lang: "pt", confidence: 0.7 },
  { re: /^(?:xin chào|chào|alo|a lô|dạ|alô)[\s.!,]*$/iu, lang: "vi", confidence: 0.7 },
  { re: /^(?:你好|喂|您好|你好啊|喂喂)[\s。！!,，]*$/u, lang: "zh", confidence: 0.82 },
  { re: /^(?:مرحبا|مرحباً|السلام عليكم|ألو|الو|أهلا|اهلا)[\s.!،]*$/u, lang: "ar", confidence: 0.7 },
  { re: /^(?:سلام|الو|الو؟|بله|درود)[\s.!،]*$/u, lang: "fa", confidence: 0.55 },
  { re: /^(?:नमस्ते|हेलो|हैलो)[\s.!।]*$/u, lang: "hi", confidence: 0.8 },
  { re: /^(?:bonjour|allô|allo|salut|bonsoir)[\s.!,]*$/iu, lang: "fr", confidence: 0.7 },
  { re: /^(?:guten tag|hallo|moin|guten morgen)[\s.!,]*$/iu, lang: "de", confidence: 0.6 },
  { re: /^(?:もしもし|こんにちは|はい)[\s。！!、]*$/u, lang: "ja", confidence: 0.82 },
];

/**
 * Identifies the language of the caller's words. Pass ONLY the caller's text.
 * Total function: never throws, never returns a language outside INTERP_LANGUAGES.
 */
export function identifyLanguage(text: string | null | undefined): LangId {
  if (typeof text !== "string" || !text.trim()) return NO_ID;
  const t = cap(text);

  const vi = scoreVietnamese(t);
  if (vi.lang) return vi;

  const base = detectLanguage(t);
  if (base.language) {
    const lang = normalizeInterpLang(base.language);
    if (lang) return { lang, confidence: base.confidence, detected: base.detected };
  }
  if (!base.language && /[\u0600-\u06ff\u0900-\u097f\u3040-\u30ff\u4e00-\u9fff]/.test(t)) {
    // Code-switching ("我的地址是789 Pine Street"): judge the non-Latin part on its own.
    const stripped = detectLanguage(t.replace(/[A-Za-z0-9]+/g, " "));
    const lang = normalizeInterpLang(stripped.language);
    if (lang) return { lang, confidence: Math.min(stripped.confidence, 0.9), detected: stripped.detected };
  }
  if (!base.language) {
    const pt = scorePortuguese(t);
    if (pt.lang) return pt;
  }
  for (const g of GREETINGS) if (g.re.test(t.trim())) return { lang: g.lang, confidence: g.confidence, detected: g.lang };
  return { lang: null, confidence: 0, detected: base.detected };
}

// ---------------------------------------------------------------- decision
export type LangDecision =
  | { action: "switch"; lang: InterpLang; confidence: number }
  | { action: "confirm"; lang: InterpLang; confidence: number }
  | { action: "fallback"; lang: "en"; detected: string | null };

/**
 * @param enabled languages the business turned on (English is always allowed)
 */
export function decideLanguage(id: LangId, enabled: readonly InterpLang[]): LangDecision {
  if (!id.lang || id.lang === "en") {
    return id.lang === "en" && id.confidence >= CONFIRM_CONFIDENCE
      ? { action: "switch", lang: "en", confidence: id.confidence }
      : { action: "fallback", lang: "en", detected: id.detected };
  }
  // Recognised but not enabled / not supported: do not pretend, stay English and offer a person.
  if (!enabled.includes(id.lang)) return { action: "fallback", lang: "en", detected: id.lang };
  if (id.confidence >= SWITCH_CONFIDENCE) return { action: "switch", lang: id.lang, confidence: id.confidence };
  if (id.confidence >= CONFIRM_CONFIDENCE) return { action: "confirm", lang: id.lang, confidence: id.confidence };
  return { action: "fallback", lang: "en", detected: id.detected };
}

// ---------------------------------------------------------------- switching
// Names of each language as a caller would say / type it, in every language we serve.
const LANG_NAMES: Record<InterpLang, string[]> = {
  en: ["english", "inglés", "ingles", "inglês", "tiếng anh", "英语", "英文", "الإنجليزية", "الانجليزية", "انجليزي", "إنجليزي", "انگلیسی", "अंग्रेज़ी", "अंग्रेजी", "anglais", "englisch", "英語", "えいご"],
  es: ["spanish", "español", "espanol", "castellano", "espanhol", "tiếng tây ban nha", "西班牙语", "西班牙文", "الإسبانية", "الاسبانية", "اسباني", "اسپانیایی", "اسپانیولی", "स्पेनिश", "espagnol", "spanisch", "スペイン語"],
  pt: ["portuguese", "português", "portugues", "portuguesa", "tiếng bồ đào nha", "葡萄牙语", "البرتغالية", "پرتغالی", "पुर्तगाली", "portugais", "portugiesisch", "ポルトガル語"],
  vi: ["vietnamese", "vietnamita", "vietnamês", "tiếng việt", "越南语", "الفيتنامية", "ویتنامی", "वियतनामी", "vietnamien", "vietnamesisch", "ベトナム語"],
  zh: ["chinese", "mandarin", "chino", "mandarín", "chinês", "mandarim", "tiếng trung", "中文", "普通话", "汉语", "الصينية", "چینی", "मंदारिन", "चीनी", "chinois", "chinesisch", "中国語"],
  ar: ["arabic", "árabe", "arabe", "tiếng ả rập", "阿拉伯语", "العربية", "عربي", "عربی", "अरबी", "arabisch", "アラビア語"],
  fa: ["persian", "farsi", "persa", "tiếng ba tư", "波斯语", "الفارسية", "فارسی", "फ़ारसी", "फारसी", "persan", "persisch", "ペルシア語"],
  hi: ["hindi", "tiếng hindi", "印地语", "الهندية", "هندی", "हिन्दी", "हिंदी", "ヒンディー語"],
  fr: ["french", "francés", "frances", "francês", "tiếng pháp", "法语", "الفرنسية", "فرانسوی", "فرانسه", "फ्रेंच", "français", "francais", "französisch", "フランス語"],
  de: ["german", "alemán", "aleman", "alemão", "tiếng đức", "德语", "الألمانية", "آلمانی", "जर्मन", "allemand", "deutsch", "ドイツ語"],
  ja: ["japanese", "japonés", "japones", "japonês", "tiếng nhật", "日语", "日本語", "اليابانية", "ژاپنی", "जापानी", "japonais", "japanisch"],
};

const FOLDED_NAMES: { lang: InterpLang; name: string; folded: string }[] = [];
for (const lang of INTERP_LANGUAGES) {
  for (const name of LANG_NAMES[lang]) FOLDED_NAMES.push({ lang, name, folded: fold(name, "es") });
}
FOLDED_NAMES.sort((a, b) => b.folded.length - a.folded.length);

/**
 * Spoken switch command: "English", "in English please", "habla español",
 * "tiếng Anh", "说英语"... Only fires on SHORT utterances (<= 6 words / 14 CJK
 * characters) so "my grandson speaks English" does not switch the call.
 */
export function detectSwitchCommand(text: string | null | undefined): InterpLang | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const raw = cap(text).toLowerCase().normalize("NFC");
  const cjk = /[぀-ヿ一-鿿]/.test(raw);
  const words = tokenize(raw);
  if (cjk ? raw.replace(/\s/g, "").length > 14 : words.length > 6) return null;
  const folded = fold(raw, "es").replace(/[.,!?;:¿¡。！？、]/g, " ");
  for (const n of FOLDED_NAMES) {
    const needle = n.folded;
    if (!needle) continue;
    const idx = folded.indexOf(needle);
    if (idx < 0) continue;
    if (!cjk && !/[؀-ۿऀ-ॿ]/.test(needle)) {
      const b = idx === 0 ? " " : folded[idx - 1];
      const a = idx + needle.length >= folded.length ? " " : folded[idx + needle.length];
      if (/[\p{L}\p{M}\p{N}]/u.test(b) || /[\p{L}\p{M}\p{N}]/u.test(a)) continue;
    }
    return n.lang;
  }
  return null;
}

/** Keypad: digit -> language. 1 = English, 2 = Spanish, then the business's other enabled languages in order. */
export function dtmfMap(enabled: readonly InterpLang[]): Record<string, InterpLang> {
  const map: Record<string, InterpLang> = { "1": "en" };
  const rest = enabled.filter((l) => l !== "en");
  const ordered: InterpLang[] = [...(rest.includes("es") ? ["es" as InterpLang] : []), ...rest.filter((l) => l !== "es")];
  ordered.slice(0, 8).forEach((l, i) => (map[String(i + 2)] = l));
  return map;
}

/** Short multilingual menu, each line in its own language. Used when nothing could be identified. */
export function languageMenuPrompt(enabled: readonly InterpLang[]): string {
  const map = dtmfMap(enabled);
  const verbs: Partial<Record<InterpLang, (n: string, d: string) => string>> = {
    en: (n, d) => `For ${n}, press ${d}.`,
    es: (n, d) => `Para ${n}, oprima ${d}.`,
    pt: (n, d) => `Para ${n}, pressione ${d}.`,
    vi: (n, d) => `Để dùng ${n}, nhấn phím ${d}.`,
    zh: (n, d) => `${n}请按${d}。`,
    ar: (n, d) => `لـ${n}، اضغط ${d}.`,
    fa: (n, d) => `برای ${n}، عدد ${d} را فشار دهید.`,
    hi: (n, d) => `${n} के लिए ${d} दबाएँ।`,
    fr: (n, d) => `Pour le ${n}, appuyez sur ${d}.`,
    de: (n, d) => `Für ${n} drücken Sie die ${d}.`,
    ja: (n, d) => `${n}は${d}を押してください。`,
  };
  return Object.entries(map)
    .map(([digit, lang]) => (verbs[lang] ?? verbs.en!)(INTERP_META[lang].nativeName, digit))
    .join(" ");
}
