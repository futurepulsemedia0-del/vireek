// supabase/functions/_shared/interpreter/critical.ts
//
// Critical-field handling: the data that must NEVER be wrong across a
// translation — phone numbers, street numbers, units, ZIPs, times, weekdays,
// prices and model codes.
//
//  extractCritical   deterministic extraction, per language, no model involved
//  compareCritical   source vs translation: any missing/extra value is a defect
//  buildReadback     fixed-template read-back in the speaker's language
//  confirmation      yes / no / unclear in every supported language
//
// Honest limits: spoken numbers are only parsed as DIGIT runs ("five five five")
// or as digits. Positional number words ("one hundred twenty", "三百五十") are
// not parsed; `hasUnparsedNumerals` flags them so the governor forces a re-ask.

import { PHRASES, type InterpLang } from "./languages.ts";
import { cap, digitsOnly, normalizeDigits } from "./text.ts";

export type CriticalKind = "phone" | "address" | "unit" | "zip" | "time" | "day" | "money" | "code" | "number";
export interface CriticalEntity {
  kind: CriticalKind;
  /** Canonical value used for comparison. */
  value: string;
  /** What was said / written (used for read-back wording). */
  raw: string;
  /** am/pm when stated or implied (hour >= 13). */
  mer?: "am" | "pm";
}

// ----------------------------------------------------------------- weekdays
type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" | "today" | "tomorrow";
const DAY_WORDS: Record<Day, string[]> = {
  mon: ["monday", "lunes", "segunda-feira", "segunda feira", "segunda", "thứ hai", "星期一", "周一", "礼拜一", "الاثنين", "دوشنبه", "सोमवार", "lundi", "montag", "月曜日", "月曜"],
  tue: ["tuesday", "martes", "terça-feira", "terça feira", "terça", "thứ ba", "星期二", "周二", "礼拜二", "الثلاثاء", "سه‌شنبه", "سه شنبه", "mardi", "dienstag", "火曜日", "火曜", "मंगलवार"],
  wed: ["wednesday", "miércoles", "miercoles", "quarta-feira", "quarta feira", "quarta", "thứ tư", "星期三", "周三", "礼拜三", "الأربعاء", "الاربعاء", "چهارشنبه", "बुधवार", "mercredi", "mittwoch", "水曜日", "水曜"],
  thu: ["thursday", "jueves", "quinta-feira", "quinta feira", "quinta", "thứ năm", "星期四", "周四", "礼拜四", "الخميس", "پنجشنبه", "پنج‌شنبه", "गुरुवार", "jeudi", "donnerstag", "木曜日", "木曜"],
  fri: ["friday", "viernes", "sexta-feira", "sexta feira", "sexta", "thứ sáu", "星期五", "周五", "礼拜五", "الجمعة", "جمعه", "शुक्रवार", "vendredi", "freitag", "金曜日", "金曜"],
  sat: ["saturday", "sábado", "sabado", "thứ bảy", "星期六", "周六", "礼拜六", "السبت", "شنبه", "शनिवार", "samedi", "samstag", "土曜日", "土曜"],
  sun: ["sunday", "domingo", "chủ nhật", "星期日", "星期天", "周日", "礼拜天", "الأحد", "الاحد", "یکشنبه", "یک‌شنبه", "रविवार", "dimanche", "sonntag", "日曜日", "日曜"],
  today: ["today", "hoy", "hoje", "hôm nay", "今天", "اليوم", "امروز", "आज", "aujourd'hui", "heute", "今日"],
  tomorrow: ["tomorrow", "amanhã", "amanha", "ngày mai", "明天", "غدا", "غداً", "فردا", "कल", "demain", "morgen", "明日", "あした"],
};
const MORNING_CTX = /(?:de|por|en|a)\s+la\s+$/; // "de la mañana" => morning, not tomorrow

function extractDays(text: string): CriticalEntity[] {
  const out: CriticalEntity[] = [];
  const lower = text.toLowerCase();
  const consumed: [number, number][] = [];
  const free = (a: number, b: number) => !consumed.some(([x, y]) => a < y && b > x);
  const noSpace = /[一-鿿぀-ヿ]/;
  // Longer words first so "segunda-feira" wins over "segunda", "thứ năm" over "năm".
  const entries = (Object.entries(DAY_WORDS) as [Day, string[]][]).flatMap(([d, ws]) => ws.map((w) => [d, w] as const));
  entries.sort((a, b) => b[1].length - a[1].length);
  for (const [day, word] of entries) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(word, from);
      if (i < 0) break;
      from = i + word.length;
      const j = i + word.length;
      if (!free(i, j)) continue;
      if (!noSpace.test(word)) {
        const before = i === 0 ? " " : lower[i - 1];
        const after = j >= lower.length ? " " : lower[j];
        if (/[\p{L}\p{M}\p{N}]/u.test(before) || /[\p{L}\p{M}\p{N}]/u.test(after)) continue;
      }
      // Spanish "mañana" is "tomorrow" unless it follows "de la / por la / en la".
      if (day === "tomorrow" && word === "morgen") {
        // German "morgen" is also "morning" ("heute morgen"): only count when not preceded by heute/gestern/diesen.
        const pre = lower.slice(Math.max(0, i - 7), i);
        if (/(heute|gestern|diesen|jeden)\s$/.test(pre)) continue;
      }
      consumed.push([i, j]);
      out.push({ kind: "day", value: day, raw: text.slice(i, j) });
    }
  }
  // Spanish: bare "mañana" = tomorrow
  let from = 0;
  const low2 = lower;
  for (;;) {
    const i = low2.indexOf("mañana", from);
    if (i < 0) break;
    from = i + 6;
    const before = i === 0 ? " " : low2[i - 1];
    const after = i + 6 >= low2.length ? " " : low2[i + 6];
    if (/[\p{L}\p{M}\p{N}]/u.test(before) || /[\p{L}\p{M}\p{N}]/u.test(after)) continue;
    if (MORNING_CTX.test(low2.slice(Math.max(0, i - 8), i))) continue;
    out.push({ kind: "day", value: "tomorrow", raw: text.slice(i, i + 6) });
  }
  return out;
}

// -------------------------------------------------------------- meridiem
const PM_WORDS = ["p.m.", "pm", "p. m.", "afternoon", "evening", "tonight", "tarde", "noche", "noite", "chiều", "tối", "下午", "晚上", "傍晚", "مساء", "مساءً", "عصر", "بعدازظهر", "بعد الظهر", "शाम", "दोपहर", "après-midi", "soir", "nachmittags", "abends", "午後", "夜"];
const AM_WORDS = ["a.m.", "am", "a. m.", "morning", "de la mañana", "por la mañana", "en la mañana", "da manhã", "da madrugada", "manhã", "sáng", "上午", "早上", "صباحا", "صباحاً", "صباح", "صبح", "सुबह", "matin", "morgens", "vormittags", "午前", "朝"];

function meridiemNear(text: string, start: number, end: number): "am" | "pm" | undefined {
  const win = text.slice(Math.max(0, start - 16), Math.min(text.length, end + 24)).toLowerCase();
  const near = (words: string[]) =>
    words.some((w) => {
      const i = win.indexOf(w);
      if (i < 0) return false;
      if (/^[a-z.]+$/.test(w) && w.length <= 4) {
        const b = i === 0 ? " " : win[i - 1];
        const a = i + w.length >= win.length ? " " : win[i + w.length];
        return !/[a-z]/.test(b) && !/[a-z]/.test(a.replace(/\./g, " "));
      }
      return true;
    });
  const pm = near(PM_WORDS);
  const am = near(AM_WORDS);
  if (pm && !am) return "pm";
  if (am && !pm) return "am";
  return undefined;
}

// ------------------------------------------------------------ extraction
const STREET_SUFFIX =
  "street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way|place|pl|circle|cir|terrace|ter|highway|hwy|parkway|pkwy|calle|avenida|camino|rua|travessa|đường|phố";

function blank(s: string, a: number, b: number): string {
  return s.slice(0, a) + " ".repeat(b - a) + s.slice(b);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function extractCritical(input: string, lang: InterpLang | null = null): CriticalEntity[] {
  const original = cap(input);
  let s = normalizeDigits(original, lang);
  const out: CriticalEntity[] = [];

  // 1) money -------------------------------------------------------------
  const moneyRes: RegExp[] = [
    /(?:US)?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/gi,
    /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:dollars?|usd|d[oó]lares|d[oó]lar|reais|đô la|đô|美元|块钱|块|刀|دولار|دلار|डॉलर|dollar|ドル)/gi,
  ];
  for (const re of moneyRes) {
    for (const m of [...s.matchAll(re)]) {
      const whole = (m[1] ?? "").replace(/,/g, "");
      const cents = (m[2] ?? "").padEnd(2, "0");
      out.push({ kind: "money", value: String(BigInt(whole || "0") * 100n + BigInt(cents || "0")), raw: m[0].trim() });
      s = blank(s, m.index as number, (m.index as number) + m[0].length);
    }
  }

  // 2) times -------------------------------------------------------------
  const timeRes: { re: RegExp; h: number; m?: number; half?: number; needMer?: boolean }[] = [
    { re: /(\d{1,2})(?::(\d{2}))?\s*(?:a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/gi, h: 1, m: 2 },
    { re: /\b(\d{1,2}):(\d{2})\b/g, h: 1, m: 2 },
    { re: /\b(\d{1,2})\s?h(?:\s?(\d{2}))?\b/gi, h: 1, m: 2 },
    { re: /(\d{1,2})\s*(?:uhr|heures?)(?:\s*(\d{2}))?/gi, h: 1, m: 2 },
    { re: /(\d{1,2})\s*giờ(?:\s*(\d{1,2}))?(?:\s*(rưỡi))?/gi, h: 1, m: 2, half: 3 },
    { re: /(\d{1,2})\s*[点點](?:\s*(\d{1,2})\s*分?|\s*(半))?/g, h: 1, m: 2, half: 3 },
    { re: /(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分|\s*(半))?/g, h: 1, m: 2, half: 3 },
    { re: /(\d{1,2})\s*बजे/g, h: 1 },
    { re: /(?:^|[^\p{L}])(?:a\s+las?|às?|las)\s+(\d{1,2})(?::(\d{2}))?(?![\d:])/giu, h: 1, m: 2, needMer: true },
    { re: /(?:الساعة|ساعة|ساعت)\s*(\d{1,2})(?::(\d{2}))?/g, h: 1, m: 2 },
  ];
  for (const { re, h, m, half, needMer } of timeRes) {
    for (const mt of [...s.matchAll(re)]) {
      const idx = mt.index as number;
      let hour = Number(mt[h]);
      let min = m && mt[m] ? Number(mt[m]) : 0;
      if (half && mt[half]) min = 30;
      if (!(hour >= 0 && hour <= 24 && min >= 0 && min <= 59)) continue;
      let mer = meridiemNear(s, idx, idx + mt[0].length);
      if (/a\.?\s?m/i.test(mt[0]) && !/p\.?\s?m/i.test(mt[0])) mer = "am";
      if (/p\.?\s?m/i.test(mt[0])) mer = "pm";
      if (hour >= 13) mer = "pm";
      if (needMer && !mer && !mt[m ?? 0]) continue;
      if (hour === 24) hour = 0;
      const h12 = hour % 12 === 0 ? 12 : hour % 12;
      out.push({ kind: "time", value: `${h12}:${pad2(min)}`, raw: mt[0].trim(), mer });
      s = blank(s, idx, idx + mt[0].length);
    }
  }

  // 3) phone numbers (7-15 digits, separators allowed) --------------------
  for (const mt of [...s.matchAll(/\+?\d[\d\s().\-]{5,}\d/g)]) {
    const d = digitsOnly(mt[0]);
    if (d.length >= 7 && d.length <= 15) {
      out.push({ kind: "phone", value: d.length === 11 && d.startsWith("1") ? d.slice(1) : d, raw: mt[0].trim() });
      s = blank(s, mt.index as number, (mt.index as number) + mt[0].length);
    }
  }

  // 4) street address + unit ----------------------------------------------
  const addrA = new RegExp(`\\b(\\d{1,6})\\s+((?:[\\p{L}.'’-]+\\s+){0,1}[\\p{L}.'’-]+)\\s+(?:${STREET_SUFFIX})\\b\\.?`, "giu");
  for (const mt of [...s.matchAll(addrA)]) {
    out.push({ kind: "address", value: mt[1], raw: mt[0].trim() });
    s = blank(s, mt.index as number, (mt.index as number) + mt[0].length);
  }
  const addrB = /\b(?:calle|avenida|camino|rua|đường)\s+(?:[\p{L}.'’-]+\s+){0,3}?(?:n[úu]mero|numero|n[º°o]\.?|#|no\.?|số)?\s*(\d{1,6})\b/giu;
  for (const mt of [...s.matchAll(addrB)]) {
    out.push({ kind: "address", value: mt[1], raw: mt[0].trim() });
    s = blank(s, mt.index as number, (mt.index as number) + mt[0].length);
  }
  for (const mt of [...s.matchAll(/(?:^|[^\p{L}\p{N}])((?:apt|apartment|unit|suite|ste|apto|apartamento|depto|departamento|căn hộ|公寓|单元|室|شقة|شقه)\.?|#)\s*([A-Za-z]?\d{1,5}[A-Za-z]?|[A-Za-z])(?![\p{L}\p{N}])/giu)]) {
    out.push({ kind: "unit", value: mt[2].toUpperCase(), raw: mt[0].trim() });
    s = blank(s, mt.index as number, (mt.index as number) + mt[0].length);
  }

  // 5) ZIP -----------------------------------------------------------------
  for (const mt of [...s.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)]) {
    out.push({ kind: "zip", value: mt[1], raw: mt[0] });
    s = blank(s, mt.index as number, (mt.index as number) + mt[0].length);
  }

  // 6) model / serial codes (letters + digits, >= 5 chars) -------------------
  for (const mt of [...original.matchAll(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{5,}\b/g)]) {
    const v = mt[0].replace(/-/g, "").toUpperCase();
    if (/^(?:\d{1,2}(?:AM|PM))$/.test(v)) continue;
    out.push({ kind: "code", value: v, raw: mt[0] });
  }

  // 7) any other number (quantities, years...) is compared too so a changed digit can never slip through,
  //    but it is not "critical data" for read-back purposes (see isReadbackKind).
  for (const mt of [...s.matchAll(/(?<![A-Za-z0-9-])\d+(?:[.,]\d+)*(?![A-Za-z0-9-])/g)]) {
    out.push({ kind: "number", value: mt[0].replace(/[.,]/g, ""), raw: mt[0] });
  }

  // 8) weekdays / today / tomorrow ------------------------------------------
  out.push(...extractDays(original));
  return out;
}

/** True when the text contains numerals we cannot parse (so a read-back is mandatory). */
export function hasUnparsedNumerals(text: string, lang: InterpLang | null): boolean {
  const t = cap(text);
  if (lang === "zh" || lang === "ja") {
    return /[零一二三四五六七八九十百千万两]{2,}(?=\s*(?:美元|块|元|点|點|時|号|號|分|ドル|円|番))/.test(t) || /[十百千万][零一二三四五六七八九]/.test(t);
  }
  if (lang === "es") return /\b(?:veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|mil)\b/i.test(t);
  if (lang === "pt") return /\b(?:vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|duzentos|trezentos|quinhentos|mil)\b/i.test(t);
  if (lang === "en" || lang === null) return /\b(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/i.test(t);
  if (lang === "vi") return /\b(?:mươi|trăm|nghìn|ngàn)\b/i.test(t);
  return false;
}

// ------------------------------------------------------------- comparison
const keyOf = (e: CriticalEntity): string => `${e.kind}|${e.value}`;

export interface CriticalDiff {
  ok: boolean;
  /** In the source but not (the same number of times) in the translation. */
  missing: CriticalEntity[];
  /** In the translation but not in the source: a hallucinated value. */
  extra: CriticalEntity[];
}

export function compareCritical(src: CriticalEntity[], tgt: CriticalEntity[]): CriticalDiff {
  const count = (list: CriticalEntity[]) => {
    const m = new Map<string, CriticalEntity[]>();
    for (const e of list) m.set(keyOf(e), [...(m.get(keyOf(e)) ?? []), e]);
    return m;
  };
  const a = count(src);
  const b = count(tgt);
  const missing: CriticalEntity[] = [];
  const extra: CriticalEntity[] = [];
  for (const [k, list] of a) {
    const other = b.get(k) ?? [];
    for (let i = other.length; i < list.length; i++) missing.push(list[i]);
    // am/pm disagreement is a defect even when the clock value matches
    if (list[0].kind === "time" && other.length) {
      const sm = list[0].mer;
      const tm = other[0].mer;
      if (sm && tm && sm !== tm) missing.push(list[0]);
    }
  }
  for (const [k, list] of b) {
    const other = a.get(k) ?? [];
    for (let i = other.length; i < list.length; i++) extra.push(list[i]);
  }
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

/** Kinds that trigger a read-back (a bare "number" does not). */
export const isReadbackKind = (k: CriticalKind): boolean => k !== "number";

/** Collapses duplicates (same kind+value) keeping the first. */
export function uniqueCritical(list: CriticalEntity[]): CriticalEntity[] {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(keyOf(e)) ? false : (seen.add(keyOf(e)), true)));
}

// ---------------------------------------------------------------- read-back
function spokenPhone(d: string): string {
  if (d.length === 10) return `${d.slice(0, 3)}, ${d.slice(3, 6)}, ${d.slice(6)}`;
  return d.split("").join(" ");
}
function moneyText(cents: string): string {
  const n = BigInt(cents);
  const dollars = (n / 100n).toString();
  const c = Number(n % 100n);
  return c === 0 ? `$${dollars}` : `$${dollars}.${pad2(c)}`;
}

/**
 * Fixed-template read-back, in `lang`, of the critical values just heard.
 * Returns "" when there is nothing critical to confirm. Deterministic: this
 * text never goes through a model.
 */
export function buildReadback(entities: CriticalEntity[], lang: InterpLang): string {
  const list = uniqueCritical(entities);
  if (!list.length) return "";
  const P = PHRASES[lang];
  const lines: string[] = [];
  const label = (k: CriticalKind) =>
    k === "phone" ? P.labels.phone : k === "address" || k === "unit" || k === "zip" ? P.labels.address
      : k === "time" ? P.labels.time : k === "money" ? P.labels.amount : k === "day" ? P.labels.day : P.labels.code;
  const order: CriticalKind[] = ["address", "unit", "zip", "phone", "day", "time", "money", "code"];
  for (const kind of order) {
    for (const e of list.filter((x) => x.kind === kind)) {
      let v = e.raw;
      if (kind === "phone") v = spokenPhone(e.value);
      else if (kind === "money") v = moneyText(e.value);
      else if (kind === "time") v = `${e.value}${e.mer ? ` ${e.mer.toUpperCase()}` : ""}`;
      else if (kind === "code") v = e.raw.toUpperCase().split("").join(" ");
      lines.push(`${label(kind)}: ${v}.`);
    }
  }
  return `${P.readbackIntro} ${lines.join(" ")} ${P.readbackAsk}`;
}

// ------------------------------------------------------------ confirmation
export type Confirmation = "yes" | "no" | "unclear";
const YES: Record<InterpLang, string[]> = {
  en: ["yes", "yeah", "yep", "yup", "correct", "right", "exactly", "that's right", "sure", "ok", "okay"],
  es: ["sí", "si", "correcto", "exacto", "así es", "claro", "está bien", "ok"],
  pt: ["sim", "correto", "certo", "exato", "isso mesmo", "isso", "ok"],
  vi: ["đúng", "đúng rồi", "vâng", "dạ", "có", "ừ", "chính xác", "phải"],
  zh: ["对", "是", "是的", "没错", "正确", "对的", "好的", "嗯"],
  ar: ["نعم", "ايوه", "أيوه", "ايوا", "صح", "صحيح", "تمام", "اجل"],
  fa: ["بله", "آره", "درسته", "درست", "اره", "بلی"],
  hi: ["हाँ", "हां", "सही", "जी", "ठीक", "जी हाँ"],
  fr: ["oui", "exact", "correct", "c'est ça", "c'est ca", "d'accord"],
  de: ["ja", "genau", "richtig", "stimmt", "korrekt", "jawohl"],
  ja: ["はい", "そうです", "合っています", "あってます", "ええ"],
};
const NO: Record<InterpLang, string[]> = {
  en: ["no", "nope", "wrong", "incorrect", "not right", "that's wrong", "not correct"],
  es: ["no", "incorrecto", "mal", "equivocado", "falso"],
  pt: ["não", "nao", "errado", "incorreto", "errada"],
  vi: ["không", "sai", "chưa đúng", "không đúng", "chưa phải", "không phải"],
  zh: ["不", "不对", "不是", "错", "错了", "不行", "没有"],
  ar: ["لا", "خطأ", "غلط", "خاطئ", "مش صح"],
  fa: ["نه", "نخیر", "غلط", "اشتباه", "نادرست"],
  hi: ["नहीं", "ना", "गलत", "नही"],
  fr: ["non", "faux", "incorrect", "pas correct"],
  de: ["nein", "falsch", "nicht richtig", "inkorrekt"],
  ja: ["いいえ", "違います", "ちがう", "ちがいます", "違う"],
};

export function confirmation(text: string, lang: InterpLang): Confirmation {
  let t = cap(text).toLowerCase().replace(/[.,!?;:¿¡。！？、]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "unclear";
  // phrases that contain a negation word but mean YES
  if (lang === "vi") t = t.replace(/không sai/g, "đúng");
  if (lang === "zh") t = t.replace(/没错|不错/g, "对");
  if (lang === "ar") t = t.replace(/مش غلط/g, "صح");
  const words = t.split(" ").slice(0, 8);
  const hit = (list: string[]) =>
    list.some((w) => (/^[\p{L}'’]+( [\p{L}'’]+)*$/u.test(w) && !/[一-鿿぀-ヿ]/.test(w)
      ? (" " + words.join(" ") + " ").includes(" " + w + " ")
      : words.join("").includes(w)));
  const no = hit(NO[lang]);
  const yes = hit(YES[lang]) || (lang !== "en" && hit(["yes", "yeah", "ok", "okay"]));
  if (no && !yes) return "no";
  if (yes && !no) return "yes";
  if (yes && no) return NO[lang].some((w) => t.startsWith(w)) ? "no" : "unclear";
  return "unclear";
}
