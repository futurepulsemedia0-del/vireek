import { describe, expect, it } from "vitest";
import { detectFromTranscript, detectLanguage, extractCallerText, MIN_STORE_CONFIDENCE } from "./detect";

const lang = (s: string) => detectLanguage(s).language;

describe("detectLanguage — Latin script", () => {
  it.each([
    ["en", "Hi, my heater is broken and I need someone to fix it tomorrow please"],
    ["es", "Hola, necesito que arreglen mi aire acondicionado, no funciona y tengo mucho calor"],
    ["fr", "Bonjour, j'ai besoin d'un plombier pour réparer une fuite d'eau dans ma maison"],
    ["de", "Hallo, ich brauche bitte einen Techniker, meine Heizung funktioniert nicht und ich möchte einen Termin"],
  ])("detects %s", (code, text) => {
    const r = detectLanguage(text);
    expect(r.language).toBe(code);
    expect(r.confidence).toBeGreaterThanOrEqual(MIN_STORE_CONFIDENCE);
  });

  it("reports Portuguese and Italian as unsupported instead of mis-filing them as es/fr", () => {
    const pt = detectLanguage("Olá, eu preciso de um técnico para consertar o ar condicionado da minha casa, não funciona");
    expect(pt.language).toBeNull();
    expect(pt.detected).toBe("pt");
    const it_ = detectLanguage("Buongiorno, ho bisogno di un tecnico per riparare il condizionatore, non funziona e vorrei un appuntamento");
    expect(it_.language).toBeNull();
    expect(it_.detected).toBe("it");
  });

  it("refuses to guess on tiny or neutral input", () => {
    for (const s of ["", " ", "ok", "yes", "STOP", "123 456", "555-1234", "a", "👍"]) {
      expect(lang(s), JSON.stringify(s)).toBeNull();
    }
  });

  it("ignores URLs, emails and digits", () => {
    expect(lang("https://example.com/hola/que/tal 12345 user@mail.com")).toBeNull();
  });

  it("is case-insensitive and tolerant of punctuation", () => {
    expect(lang("HELLO!!! I NEED HELP WITH MY WATER HEATER, THANKS")).toBe("en");
  });
});

describe("detectLanguage — non-Latin scripts", () => {
  it("Japanese (kana)", () => expect(lang("こんにちは、エアコンが壊れてしまったので修理をお願いしたいです")).toBe("ja"));
  it("Japanese: Han + a little kana is still Japanese", () => expect(lang("修理をお願いします")).toBe("ja"));
  it("Chinese (Han only)", () => expect(lang("你好，我家的空调坏了，需要师傅今天来修理")).toBe("zh"));
  it("Hindi", () => expect(lang("नमस्ते, मेरा एयर कंडीशनर खराब हो गया है, कृपया जल्दी ठीक करें")).toBe("hi"));
  it("Persian", () => {
    const r = detectLanguage("سلام، کولر گازی من خراب شده و می‌خواهم امروز یک تکنسین بیاید");
    expect(r.language).toBe("fa");
    expect(r.confidence).toBeGreaterThanOrEqual(MIN_STORE_CONFIDENCE);
  });
  it("Arabic", () => {
    const r = detectLanguage("مرحبا، أنا أريد فني لإصلاح المكيف في منزلي لأنه لا يعمل");
    expect(r.language).toBe("ar");
    expect(r.confidence).toBeGreaterThanOrEqual(MIN_STORE_CONFIDENCE);
  });
  it("Persian typed with Arabic keyboard letters is still Persian thanks to function words", () => {
    expect(lang("سلام من يك تعميرکار لازم دارم که این مشکل را حل کند")).toBe("fa");
  });
  it("a word shared by Persian and Arabic is ambiguous -> null", () => {
    expect(lang("سلام")).toBeNull();
  });
  it("Urdu / Korean / Russian are recognised but not supported", () => {
    expect(detectLanguage("ہیلو مجھے ٹھیک کرنے کے لیے ٹیکنیشن چاہیے ڑ")).toMatchObject({ language: null, detected: "ur" });
    expect(detectLanguage("안녕하세요 에어컨이 고장 났어요")).toMatchObject({ language: null, detected: "ko" });
    expect(detectLanguage("Здравствуйте, у меня сломался кондиционер")).toMatchObject({ language: null, detected: "ru" });
  });
  it("refuses mixed-script noise where no script dominates", () => {
    expect(lang("ab 你好 سلام नमस्ते")).toBeNull();
  });
});

describe("detectLanguage — robustness", () => {
  it("never throws on odd input", () => {
    for (const v of [null, undefined, 42 as unknown as string, "\u0000￿", "😀".repeat(5000), "a".repeat(100000)]) {
      expect(() => detectLanguage(v as string)).not.toThrow();
    }
  });
});

describe("extractCallerText / detectFromTranscript", () => {
  const transcript = [
    "AI: Hello, thanks for calling Acme Heating. How can I help you today?",
    "User: Hola, necesito que arreglen mi calefacción, no funciona",
    "AI: Of course, I can help with that. What is your address?",
    "User: Vivo en la calle principal y quiero una cita para mañana por favor",
  ].join("\n");

  it("keeps only the caller's lines", () => {
    const text = extractCallerText(transcript);
    expect(text).toContain("calefacción");
    expect(text).not.toContain("Acme Heating");
  });

  it("does not let the English assistant lines drown out a Spanish caller", () => {
    expect(detectFromTranscript(transcript).language).toBe("es");
  });

  it("handles multi-line caller turns and alternative role labels", () => {
    const t = "Assistant: How can I help?\nCaller: Bonjour,\nj'ai besoin d'un plombier pour ma maison\nAssistant: Sure.";
    expect(extractCallerText(t)).toBe("Bonjour,\nj'ai besoin d'un plombier pour ma maison");
  });

  it("returns unlabelled text (SMS body) unchanged", () => {
    expect(extractCallerText("  Hola necesito ayuda  ")).toBe("Hola necesito ayuda");
  });

  it("is empty-safe", () => {
    expect(extractCallerText(null)).toBe("");
    expect(extractCallerText("")).toBe("");
    expect(detectFromTranscript(undefined).language).toBeNull();
    expect(detectFromTranscript("AI: only the assistant spoke").language).toBeNull();
  });
});
