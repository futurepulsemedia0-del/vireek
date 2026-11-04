import { describe, expect, it } from "vitest";
import { buildPublicFields } from "./redact.ts";
import { FORMATS, renderCardSvg, wrap, xmlEscape } from "./render.ts";
import { suggestCaptions } from "./captions.ts";
import { buildOgHtml, OG_NOT_FOUND_HTML } from "./og.ts";
import { TRIGGER_TYPES, DEFAULT_SELECTION, type PrivateFacts, type PublicFields } from "./types.ts";

const PII = ["Sarah Mitchell", "+1 (212) 555-0147", "2125550147", "42 Elm Street"];
const mk = (trigger: PrivateFacts["trigger"], extra: Partial<PrivateFacts> = {}): PrivateFacts => ({
  trigger, occurredAt: "2026-11-03T07:14:00.000Z", valueCents: 420_000, valueBasis: "invoiced", milestone: 100, responseMs: 12_000, pii: PII, ...extra,
});
const sel = { ...DEFAULT_SELECTION, showValue: true, showTimeBucket: true, showMonth: true, showBusinessName: true, serviceLabel: "Emergency repair" };
const s = { timezone: "America/New_York", businessHoursStart: 8, businessHoursEnd: 18 };
const LEAKS = ["Sarah", "Mitchell", "212", "555", "0147", "Elm", "2:14", "4,200", "4200", "420000", "07:14"];
// SVG geometry contains arbitrary digits (e.g. y="555.84"), so numeric leaks are checked against the VISIBLE
// text only (text nodes, <title>, attribute strings); non-numeric leaks are checked against the whole file.
const textOf = (svg: string) => [...svg.matchAll(/>([^<]+)</g)].map((m) => m[1]).join("\n");
const WORD_LEAKS = ["Sarah", "Mitchell", "Elm", "2125550147", "(212)", "212-555", "0147", "T07:14"];

describe("renderer output contains no PII for any trigger × format × theme × mode", () => {
  for (const trigger of TRIGGER_TYPES) {
    const pub = buildPublicFields({ facts: mk(trigger), selection: sel, settings: s, businessName: "Acme HVAC" });
    for (const format of Object.keys(FORMATS) as (keyof typeof FORMATS)[])
      for (const theme of ["light", "dark"] as const)
        it(`${trigger} / ${format} / ${theme}`, () => {
          for (const animated of [false, true]) for (const whiteLabel of [false, true]) {
            const svg = renderCardSvg(pub, { format, theme, animated, whiteLabel, brandName: "Acme", seed: "ref123", accent: "#112233" });
            const vis = textOf(svg);
            for (const l of LEAKS) expect(vis).not.toContain(l);
            for (const l of WORD_LEAKS) expect(svg).not.toContain(l);
            expect(svg).toContain(`width="${FORMATS[format].w}"`);
            expect(svg).toContain(`height="${FORMATS[format].h}"`);
            expect(svg.startsWith("<svg")).toBe(true);
          }
        });
  }
});

describe("renderer behaviour", () => {
  const pub = buildPublicFields({ facts: mk("emergency_handled"), selection: sel, settings: s, businessName: "Acme HVAC" });
  it("is deterministic (snapshot-stable)", () => {
    const o = { format: "og", theme: "light", seed: "abc" } as const;
    expect(renderCardSvg(pub, o)).toBe(renderCardSvg(pub, o));
  });
  it("reduced-motion safe: animation exists only inside prefers-reduced-motion: no-preference", () => {
    const svg = renderCardSvg(pub, { format: "square", theme: "dark", seed: "a", animated: true });
    expect(svg).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(svg.replace(/@media \(prefers-reduced-motion: no-preference\)\{[^}]*\{[^}]*\}\}/, "")).not.toContain("animation:wc-pulse");
    expect(renderCardSvg(pub, { format: "square", theme: "dark", seed: "a", animated: false })).not.toContain("<style>");
  });
  it("white-label replaces the Vireek wordmark", () => {
    expect(renderCardSvg(pub, { format: "og", theme: "light", seed: "a" })).toContain(">Vireek<");
    const wl = renderCardSvg(pub, { format: "og", theme: "light", seed: "a", whiteLabel: true, brandName: "Acme Co" });
    expect(wl).not.toContain("Vireek");
    expect(wl).toContain("Acme Co");
  });
  it("escapes hostile text and rejects non-hex accents", () => {
    const evil: PublicFields = { ...pub, headline: `<script>alert(1)</script>"&'`, serviceText: `"><img src=x onerror=1>` };
    const svg = renderCardSvg(evil, { format: "square", theme: "light", seed: "a", accent: "red\" onload=\"x" });
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<img");
    expect(svg).not.toContain("onload");
    expect(xmlEscape(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
  it("wrap never exceeds max lines and ellipsises", () => {
    const l = wrap("one two three four five six seven eight nine ten", 10, 2);
    expect(l).toHaveLength(2);
    expect(l[1].endsWith("…")).toBe(true);
  });
  it("labels the waveform as decorative, not a recording", () => {
    expect(renderCardSvg(pub, { format: "square", theme: "light", seed: "a" })).toContain("not a recording");
  });
});

describe("captions are human, calm and PII-free", () => {
  for (const trigger of TRIGGER_TYPES) it(trigger, () => {
    const pub = buildPublicFields({ facts: mk(trigger), selection: sel, settings: s, businessName: "Acme HVAC" });
    const caps = suggestCaptions(pub);
    expect(caps).toHaveLength(3);
    for (const c of caps) {
      expect(c).not.toContain("!");
      expect(c.length <= 280).toBe(true);
      for (const l of LEAKS) expect(c).not.toContain(l);
      expect(/insane|game.?chang|best ever|crush|10x|revolution/i.test(c)).toBe(false);
    }
  });
});

describe("OG html", () => {
  const pub = buildPublicFields({ facts: mk("after_hours_booking"), selection: sel, settings: s, businessName: "Acme HVAC" });
  const html = buildOgHtml({ pub, pageUrl: "https://app.vireek.com/win/T", imageUrl: "https://app.vireek.com/api/win-card?t=T&img=og", siteName: "Vireek" });
  it("has the required tags, is noindex, and leaks nothing", () => {
    for (const t of ['property="og:title"', 'property="og:image"', 'content="1200"', 'content="630"', 'name="twitter:card"', 'content="noindex, nofollow"']) expect(html).toContain(t);
    for (const l of LEAKS) expect(html).not.toContain(l);
  });
  it("not-found page has no OG image and is noindex", () => {
    expect(OG_NOT_FOUND_HTML).not.toContain("og:image");
    expect(OG_NOT_FOUND_HTML).toContain("noindex");
  });
});

describe("layout bounds (no rasteriser available in CI sandbox, so geometry is checked numerically)", () => {
  type T = { x: number; y: number; fs: number; anchor: string; text: string };
  const texts = (svg: string): T[] =>
    [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" (?:text-anchor="(\w+)" )?font-size="(\d+)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({
      x: +m[1], y: +m[2], anchor: m[3] ?? "start", fs: +m[4], text: m[5],
    }));
  for (const trigger of TRIGGER_TYPES)
    for (const format of Object.keys(FORMATS) as (keyof typeof FORMATS)[])
      it(`${trigger} / ${format}: every text line fits inside the canvas`, () => {
        const pub = buildPublicFields({ facts: mk(trigger), selection: sel, settings: s, businessName: "Acme Heating & Cooling Services" });
        const { w, h } = FORMATS[format];
        const svg = renderCardSvg(pub, { format, theme: "light", seed: "a" });
        const ts = texts(svg);
        expect(ts.length > 3).toBe(true);
        for (const t of ts) {
          const width = t.text.length * t.fs * 0.58; // conservative average glyph width for a bold sans
          expect(t.y <= h - 8).toBe(true);
          if (t.anchor === "end") expect(t.x - width >= 16).toBe(true);
          else expect(t.x + width <= w - 16).toBe(true);
        }
      });
});
