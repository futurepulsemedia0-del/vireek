import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES, LANGUAGE_META, languageOptionLabel, normalizeLanguage, canAutoDetectOverwrite, intlLocale, sourceLabel } from "./languages";
import { CATALOG, escapeHtml, formatDate, formatMoney, htmlLangAttrs, renderTemplate, textAlignStart, type TemplateKey } from "./templates";

const keys = Object.keys(CATALOG) as TemplateKey[];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("languages", () => {
  it("normalizes region/underscore/case variants and rejects the rest", () => {
    expect(normalizeLanguage("fa-IR")).toBe("fa");
    expect(normalizeLanguage("ES")).toBe("es");
    expect(normalizeLanguage(" zh_CN ")).toBe("zh");
    for (const bad of ["pt", "", "xx", null, undefined, 5, {}, "english"]) expect(normalizeLanguage(bad)).toBeNull();
  });

  it("has complete metadata for every supported language", () => {
    for (const c of SUPPORTED_LANGUAGES) {
      const m = LANGUAGE_META[c];
      expect(m.name && m.nativeName && m.locale).toBeTruthy();
      expect(["ltr", "rtl"]).toContain(m.dir);
    }
    expect(LANGUAGE_META.fa.dir).toBe("rtl");
    expect(LANGUAGE_META.ar.dir).toBe("rtl");
    expect(languageOptionLabel("es")).toBe("Español (Spanish)");
    expect(languageOptionLabel("en")).toBe("English");
  });

  it("auto-detection may only fill an empty language", () => {
    expect(canAutoDetectOverwrite(null)).toBe(true);
    expect(canAutoDetectOverwrite(undefined)).toBe(true);
    expect(canAutoDetectOverwrite("")).toBe(true);
    expect(canAutoDetectOverwrite("es")).toBe(false);
    expect(canAutoDetectOverwrite("fa-IR")).toBe(false);
  });

  it("describes sources for the staff UI", () => {
    expect(sourceLabel("staff")).toMatch(/team/i);
    expect(sourceLabel("customer")).toMatch(/customer/i);
    expect(sourceLabel("auto_detected")).toMatch(/automatic/i);
    expect(sourceLabel(null)).toMatch(/not set/i);
  });

  it("forces Gregorian calendar and Latin digits for documents", () => {
    for (const c of SUPPORTED_LANGUAGES) expect(intlLocale(c)).toMatch(/-u-ca-gregory-nu-latn$/);
  });
});

describe("template catalog", () => {
  it("is non-empty", () => expect(keys.length).toBeGreaterThan(20));

  it.each(keys)("%s: all 9 languages present, non-empty, same placeholders as English", (key) => {
    const entry = CATALOG[key] as Record<string, string>;
    expect(Object.keys(entry).sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
    const en = placeholders(entry.en);
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(entry[lang].trim(), `${key}:${lang} empty`).not.toBe("");
      expect(placeholders(entry[lang]), `${key}:${lang} placeholders`).toEqual(en);
    }
  });

  it("non-English templates are actually translated (not copies of English)", () => {
    // Short brand-ish strings may legitimately match; everything else must differ.
    for (const key of keys) {
      const entry = CATALOG[key] as Record<string, string>;
      for (const lang of SUPPORTED_LANGUAGES.filter((l) => l !== "en")) {
        if (entry[lang] === entry.en) throw new Error(`${key}:${lang} is identical to English`);
      }
    }
  });
});

describe("renderTemplate", () => {
  it("interpolates and falls back to English for unknown languages", () => {
    const args = { name: "Ana", amount: "$10.00", url: "https://x.test/p" };
    expect(renderTemplate("payment.sms.ready", "es", args)).toBe("Hola Ana, su factura por $10.00 está lista. Pague de forma segura: https://x.test/p");
    expect(renderTemplate("payment.sms.ready", "xx", args)).toBe(renderTemplate("payment.sms.ready", "en", args));
    expect(renderTemplate("payment.sms.ready", null, args)).toBe(renderTemplate("payment.sms.ready", "en", args));
    expect(renderTemplate("payment.sms.ready", "fa-IR", args)).toBe(renderTemplate("payment.sms.ready", "fa", args));
  });

  it("never re-expands placeholders that appear inside values", () => {
    const out = renderTemplate("invoice.email.greeting", "en", { name: "{url}" });
    expect(out).toBe("Hi {url},");
  });

  it("renders missing variables as empty, not 'undefined'", () => {
    expect(renderTemplate("invoice.email.greeting", "en", {})).toBe("Hi ,");
    expect(renderTemplate("invoice.email.greeting", "en", { name: null })).toBe("Hi ,");
  });

  it("escapes values (not template text) when asked", () => {
    const html = renderTemplate("invoice.email.greeting", "en", { name: `<b>"x"&</b>` }, { escape: escapeHtml });
    expect(html).toBe("Hi &lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;,");
  });
});

describe("html helpers", () => {
  it("sets lang and direction", () => {
    expect(htmlLangAttrs("fa")).toBe('lang="fa" dir="rtl"');
    expect(htmlLangAttrs("ja")).toBe('lang="ja" dir="ltr"');
    expect(htmlLangAttrs("nope")).toBe('lang="en" dir="ltr"');
    expect(textAlignStart("ar")).toBe("right");
    expect(textAlignStart("de")).toBe("left");
  });
});

describe("formatMoney / formatDate", () => {
  it("formats USD per language with Latin digits", () => {
    expect(formatMoney(1234.5, "en")).toBe("$1,234.50");
    expect(formatMoney(1234.5, "de")).toMatch(/1\.234,50/);
    expect(formatMoney(1234.5, "fr")).toMatch(/1\s234,50/);
    expect(formatMoney(1234.5, "fa")).toMatch(/1,?234\.50|1٬?234/); // digits stay Latin
    expect(formatMoney(1234.5, "ar")).toMatch(/[0-9]/);
    expect(formatMoney(1234.5, "ja")).toMatch(/1,234/);
  });
  it("is safe for bad numbers/currency", () => {
    expect(formatMoney(Number.NaN, "en")).toBe("$0.00");
    expect(formatMoney(5, "en", "NOPE!")).toContain("5.00");
  });
  it("formats date-only strings without shifting the day, in the Gregorian calendar", () => {
    expect(formatDate("2026-10-20", "en")).toBe("October 20, 2026");
    expect(formatDate("2026-10-20", "es")).toMatch(/20 de octubre de 2026/);
    expect(formatDate("2026-10-20", "de")).toMatch(/20\. Oktober 2026/);
    expect(formatDate("2026-10-20", "fa")).toMatch(/2026/); // not 1405 (Solar Hijri)
    expect(formatDate("2026-10-20", "ja")).toMatch(/2026年10月20日/);
    expect(formatDate("not a date", "en")).toBe("");
  });
});
