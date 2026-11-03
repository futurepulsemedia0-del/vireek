// supabase/functions/_shared/interpreter/text.ts
//
// Text normalisation shared by language-ID, critical-field extraction and
// emergency matching. Pure and total: never throws, never allocates unbounded
// work (every public function caps its input length first).

import type { InterpLang } from "./languages.ts";

export const MAX_TEXT = 4000;
export const cap = (s: string | null | undefined): string => (typeof s === "string" ? s.slice(0, MAX_TEXT) : "");

/** Arabic-Indic, Extended Arabic-Indic (Persian) and full-width digits -> ASCII. */
export function asciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹０-９]/g, (ch) => {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0x660 && cp <= 0x669) return String(cp - 0x660);
    if (cp >= 0x6f0 && cp <= 0x6f9) return String(cp - 0x6f0);
    return String(cp - 0xff10);
  });
}

// ---------------------------------------------------------------------------
// Spoken digit words -> digits ("one two three" -> "123"). Only RUNS of >= 3
// digit words are converted, so "uno" in "tengo uno" or Vietnamese "năm" (year)
// in a sentence are left alone.
// ---------------------------------------------------------------------------
const DIGIT_WORDS: Partial<Record<InterpLang, Record<string, string>>> = {
  en: { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" },
  es: { cero: "0", uno: "1", una: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8", nueve: "9" },
  pt: { zero: "0", um: "1", uma: "1", dois: "2", duas: "2", tres: "3", três: "3", quatro: "4", cinco: "5", seis: "6", sete: "7", oito: "8", nove: "9" },
  vi: { không: "0", linh: "0", lẻ: "0", một: "1", mốt: "1", hai: "2", ba: "3", bốn: "4", tư: "4", năm: "5", lăm: "5", sáu: "6", bảy: "7", tám: "8", chín: "9" },
  ar: { صفر: "0", واحد: "1", اثنان: "2", اثنين: "2", ثلاثة: "3", ثلاثه: "3", أربعة: "4", اربعة: "4", خمسة: "5", ستة: "6", سبعة: "7", ثمانية: "8", تسعة: "9" },
  fa: { صفر: "0", یک: "1", دو: "2", سه: "3", چهار: "4", پنج: "5", شش: "6", هفت: "7", هشت: "8", نه: "9" },
  fr: { zéro: "0", zero: "0", un: "1", une: "1", deux: "2", trois: "3", quatre: "4", cinq: "5", six: "6", sept: "7", huit: "8", neuf: "9" },
  de: { null: "0", eins: "1", ein: "1", zwei: "2", drei: "3", vier: "4", fünf: "5", sechs: "6", sieben: "7", acht: "8", neun: "9" },
  hi: { शून्य: "0", एक: "1", दो: "2", तीन: "3", चार: "4", पाँच: "5", पांच: "5", छह: "6", छः: "6", सात: "7", आठ: "8", नौ: "9" },
};
const ZH_DIGITS: Record<string, string> = { 零: "0", 〇: "0", 一: "1", 幺: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };

function wordRun(text: string, table: Record<string, string>): string {
  // Tokenise on whitespace/commas/hyphens, keep separators so non-digit text is preserved exactly.
  const parts = text.split(/([\s,\-–.]+)/);
  const out: string[] = [];
  let run: { digits: string; start: number; last: number } | null = null;
  const flush = () => {
    if (run && run.digits.length >= 3) out.splice(run.start, run.last - run.start + 1, run.digits);
    run = null;
  };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i % 2 === 1) {
      out.push(p); // separator: keeps the run alive, preserved verbatim if the run is not converted
      continue;
    }
    const key = p.toLowerCase();
    const d = p.length > 0 && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
    if (d !== undefined) {
      if (!run) run = { digits: "", start: out.length, last: out.length };
      run.digits += d;
      run.last = out.length;
      out.push(p);
    } else {
      flush();
      out.push(p);
    }
  }
  flush();
  return out.join("");
}

/**
 * Normalises digits for comparison: native digits -> ASCII, and runs of >= 3
 * spoken digit words (in `lang`, plus English) -> digit strings.
 */
export function normalizeDigits(text: string, lang?: InterpLang | null): string {
  let s = asciiDigits(cap(text));
  const langs: InterpLang[] = lang && lang !== "en" ? [lang, "en"] : ["en"];
  for (const l of langs) {
    const t = DIGIT_WORDS[l];
    if (t) s = wordRun(s, t);
  }
  if (lang === "zh" || lang === "ja") {
    s = s.replace(/[零〇一幺二两三四五六七八九]{3,}/g, (m) => [...m].map((c) => ZH_DIGITS[c] ?? c).join(""));
  }
  return s;
}

/** Digits only. */
export const digitsOnly = (s: string): string => asciiDigits(s).replace(/\D/g, "");

// ---------------------------------------------------------------------------
// Folding for keyword matching. The policy differs per script on purpose:
// Latin-script languages fold diacritics (ASR and typists omit them), but
// Vietnamese must NOT: "cháy" (fire) and "chạy" (run) differ only by a tone mark.
// ---------------------------------------------------------------------------
const AR_FOLD: Record<string, string> = { "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ی": "ي", "ئ": "ي", "ک": "ك", "ة": "ه", "ؤ": "و", "ـ": "" };

export function fold(text: string, lang: InterpLang): string {
  let s = cap(text).normalize("NFC").toLowerCase();
  if (lang === "vi" || lang === "zh" || lang === "ja" || lang === "hi") return s.replace(/\s+/g, " ").trim();
  if (lang === "ar" || lang === "fa") {
    s = s.replace(/[ً-ٰٟۖ-ۭ]/g, "").replace(/‌/g, " ").replace(/‏|‎/g, "");
    s = s.replace(/[أإآٱىیئکةؤـ]/g, (c) => AR_FOLD[c] ?? c);
    return asciiDigits(s).replace(/\s+/g, " ").trim();
  }
  s = s.normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/g, "ss").replace(/đ/g, "d");
  return s.replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

/** Whole-word / whole-phrase containment that works for space-less scripts too. */
export function containsPhrase(haystack: string, needle: string, noSpaces: boolean): boolean {
  if (!needle) return false;
  if (noSpaces) return haystack.includes(needle);
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return false;
    const before = i === 0 ? " " : haystack[i - 1];
    const after = i + needle.length >= haystack.length ? " " : haystack[i + needle.length];
    const isWord = (c: string) => /[\p{L}\p{M}\p{N}]/u.test(c);
    if (!isWord(before) && !isWord(after)) return true;
    from = i + 1;
  }
}

export function tokenize(text: string): string[] {
  return cap(text).toLowerCase().match(/[\p{L}\p{N}'’‌]+/gu) ?? [];
}
