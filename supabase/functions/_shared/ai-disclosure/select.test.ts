import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "../i18n/languages.ts";
import { BUILTIN_DISCLOSURES, DEFAULT_DISCLOSURE_SCRIPT, selectDisclosure } from "./select.ts";

describe("selectDisclosure", () => {
  const script = "Heads up: this is an AI assistant.";
  it("unknown caller language -> account script (fallback)", () => {
    expect(selectDisclosure({ script, scriptLanguage: "en", callerLanguage: null })).toMatchObject({
      text: script, language: "en", source: "business_profile", reason: "default_fallback",
    });
  });
  it("caller language equals script language -> account script", () => {
    expect(selectDisclosure({ script, scriptLanguage: "en", callerLanguage: "en" }).reason).toBe("caller_language_match");
  });
  it("different caller language -> built-in translation in that language", () => {
    const r = selectDisclosure({ script, scriptLanguage: "en", callerLanguage: "es", outboundLanguages: ["en", "es"] });
    expect(r).toMatchObject({ language: "es", source: "builtin_translation", reason: "caller_language_translation" });
    expect(r.text).toBe(BUILTIN_DISCLOSURES.es);
  });
  it("caller language not cleared for outbound compliance text -> account script, never an unreviewed translation", () => {
    for (const callerLanguage of ["es", "fr", "de", "ar", "fa", "hi", "ja", "zh"] as const) {
      const r = selectDisclosure({ script, scriptLanguage: "en", callerLanguage, outboundLanguages: ["en"] });
      expect(r).toMatchObject({ language: "en", text: script, source: "business_profile", reason: "default_fallback" });
    }
  });
  it("with the shipped default list, no non-English translation is served until it is reviewed", () => {
    expect(selectDisclosure({ script, scriptLanguage: "en", callerLanguage: "es" }).source).toBe("business_profile");
  });
  it("account script written in Spanish is used for Spanish callers", () => {
    expect(selectDisclosure({ script, scriptLanguage: "es", callerLanguage: "es" }).text).toBe(script);
  });
  it("blank/missing script falls back to the default sentence", () => {
    expect(selectDisclosure({ script: "  ", scriptLanguage: null, callerLanguage: null }).text).toBe(DEFAULT_DISCLOSURE_SCRIPT);
  });
  it("has a non-empty built-in translation for every supported language", () => {
    for (const l of SUPPORTED_LANGUAGES) expect(BUILTIN_DISCLOSURES[l].trim().length).toBeGreaterThan(10);
  });
});
