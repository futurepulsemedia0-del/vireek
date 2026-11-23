import { describe, expect, it } from "vitest";
import { voicemailTwiml, type FallbackCtx } from "./twimlFallback";

const ctx = (language: "en" | "es"): FallbackCtx => ({ businessName: "Acme", forwardTargets: [], language, hook: (a) => `https://x.test/${a}` });

describe("voicemail fallback tells the caller it is recorded BEFORE <Record> starts", () => {
  for (const language of ["en", "es"] as const) {
    for (const [name, opts] of [["default", {}], ["skipPrompt", { skipPrompt: true }], ["noOneAvailable", { noOneAvailable: true }]] as const) {
      it(`${language} ${name}`, () => {
        const x = voicemailTwiml(ctx(language), opts);
        const notice = language === "en" ? "recorded and transcribed" : "grabado y transcrito";
        expect(x).toContain(notice);
        expect(x.indexOf(notice)).toBeLessThan(x.indexOf("<Record"));
      });
    }
  }
});
