import { describe, expect, it } from "vitest";
import { extractEmailAddress, htmlToText, MAX_TEXT_CHARS, sanitizeFileName, sanitizeHeaderValue, sanitizeInboundText, sha256Hex } from "./sanitize.ts";

describe("sanitizeInboundText", () => {
  it("returns empty for non-strings and empty input", () => {
    expect(sanitizeInboundText(undefined).text).toBe("");
    expect(sanitizeInboundText(42).text).toBe("");
    expect(sanitizeInboundText("").truncated).toBe(false);
  });

  it("drops script/style/iframe blocks WITH their content and never returns markup", () => {
    const html = `<p>Work Order: 123</p><script>alert('x')</script><style>p{display:none}</style><iframe src="//evil"></iframe><img src=x onerror=alert(1)>NTE: $5`;
    const { text, stats } = sanitizeInboundText(html);
    expect(stats.htmlStripped).toBe(true);
    expect(text).toContain("Work Order: 123");
    expect(text).toContain("NTE: $5");
    expect(text).not.toMatch(/alert|display:none|evil|onerror|<|>/);
  });

  it("keeps entity-encoded markup as inert text and does not decode it into tags that get re-parsed", () => {
    const { text } = sanitizeInboundText("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(text).toBe("<script>alert(1)</script>"); // plain text; React escapes it, nothing re-strips it
  });

  it("rejects NUL / control / surrogate numeric entities", () => {
    const { text } = sanitizeInboundText("<p>a&#0;b&#x1b;c&#xD800;d&#x110000;e&#65;</p>");
    expect(text).toBe("a b c d eA");
  });

  it("removes bidi overrides, zero-width and control characters and counts them", () => {
    const { text, stats } = sanitizeInboundText("Work\u202EOrder\u200B: 1\u0000\u0007\u009f2\u2066x");
    expect(text).toBe("WorkOrder: 12x");
    expect(stats.bidiChars).toBe(2);
    expect(stats.invisibleChars).toBe(1);
    expect(stats.controlChars).toBe(3);
  });

  it("keeps tabs and newlines, normalises CRLF and collapses blank runs", () => {
    expect(sanitizeInboundText("a\r\nb\t c\r\r\r\r\nd   \n\n\n\ne").text).toBe("a\nb\t c\n\nd\n\ne");
  });

  it("truncates after cleaning and never splits a surrogate pair", () => {
    const r = sanitizeInboundText("😀".repeat(10), { maxChars: 5 });
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("😀😀");
    const big = sanitizeInboundText("a".repeat(MAX_TEXT_CHARS * 5));
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBe(MAX_TEXT_CHARS);
  });

  it("does not strip text that merely contains angle brackets", () => {
    const { text, stats } = sanitizeInboundText("NTE < $500 and 3 > 2");
    expect(stats.htmlStripped).toBe(false);
    expect(text).toBe("NTE < $500 and 3 > 2");
  });

  it("drops an unterminated tag fragment rather than hiding text inside it", () => {
    expect(sanitizeInboundText("<p>ok</p>\n<a href='x' onclick=").text).toBe("ok");
  });
});

describe("htmlToText cell and block handling", () => {
  it("separates table cells and rows so 'Label: value' pairs survive", () => {
    const t = htmlToText("<table><tr><td>Work Order:</td><td>555</td></tr><tr><td>NTE:</td><td>$9</td></tr></table>");
    expect(t).toMatch(/Work Order:\s+555/);
    expect(t.split("\n").some((l) => /NTE:\s+\$9/.test(l))).toBe(true);
  });
});

describe("sanitizeHeaderValue", () => {
  it("flattens CR/LF header-injection attempts and bidi tricks", () => {
    expect(sanitizeHeaderValue("Hi\r\nBcc: evil@x.com\u202E!")).toBe("Hi Bcc: evil@x.com!");
  });
  it("caps length and tolerates non-strings", () => {
    expect(sanitizeHeaderValue("x".repeat(1000), 10)).toBe("x".repeat(10));
    expect(sanitizeHeaderValue(null)).toBe("");
  });
});

describe("extractEmailAddress", () => {
  it("parses plain and display-name forms to lower case", () => {
    expect(extractEmailAddress("Ana <Ana@Example.COM>")).toBe("ana@example.com");
    expect(extractEmailAddress("bob+fm@example.org")).toBe("bob+fm@example.org");
  });
  it("rejects multiple, quoted, injected or malformed addresses", () => {
    for (const bad of ["a@b.com, c@d.com", "a@b.com\r\nBcc: x@y.z", "\"a b\"@x.com", "a@b", "@x.com", "a@@b.com", "<a@b.com> <c@d.com>", 5, "x".repeat(700)]) {
      expect(extractEmailAddress(bad as unknown)).toBeNull();
    }
  });
});

describe("sanitizeFileName", () => {
  it("strips paths, traversal and odd characters", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\x\\wo 12:34?.pdf")).toBe("wo 12_34_.pdf");
    expect(sanitizeFileName("...hidden")).toBe("hidden");
    expect(sanitizeFileName("\u202Egnp.exe")).toBe("gnp.exe");
  });
  it("falls back when nothing usable is left", () => {
    expect(sanitizeFileName("////")).toBe("upload");
    expect(sanitizeFileName(undefined, "x.pdf")).toBe("x.pdf");
  });
});

describe("sha256Hex", () => {
  it("matches the known SHA-256 of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
