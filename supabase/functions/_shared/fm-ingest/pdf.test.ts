import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectPdf, PDF_MAX_BYTES } from "./pdf.ts";

const fx = (name: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));

describe("inspectPdf (synthetic sample files)", () => {
  it("accepts a plain text PDF", () => {
    const v = inspectPdf(fx("sample-work-order.pdf"));
    expect(v.ok).toBe(true);
  });
  it("accepts a PDF carrying hostile TEXT (text is handled by sanitize, not rejected here)", () => {
    expect(inspectPdf(fx("sample-injection.pdf")).ok).toBe(true);
  });
  it.each([
    ["sample-encrypted.pdf", "encrypted"],
    ["sample-javascript.pdf", "active_content"],
    ["sample-embedded-file.pdf", "embedded_files"],
    ["sample-truncated.pdf", "truncated"],
    ["sample-not-a-pdf.pdf", "not_pdf"],
  ])("rejects %s as %s", (file, code) => {
    const v = inspectPdf(fx(file));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(code);
  });
  it("rejects empty and oversized input without scanning it", () => {
    expect(inspectPdf(new Uint8Array(0))).toMatchObject({ ok: false, code: "empty" });
    expect(inspectPdf(new Uint8Array(PDF_MAX_BYTES + 1))).toMatchObject({ ok: false, code: "too_large" });
  });
  it("sees through #xx name obfuscation of /JavaScript", () => {
    const evil = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /S /J#61vaScript /JS (x) >>\nendobj\n%%EOF\n");
    expect(inspectPdf(evil)).toMatchObject({ ok: false, code: "active_content" });
  });
  it("does not treat similarly named keys as active content", () => {
    const ok = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /JSONData (x) /Subtype /Link >>\nendobj\n%%EOF\n");
    expect(inspectPdf(ok).ok).toBe(true);
  });
  it("requires the header at byte 0 (no polyglot prefix)", () => {
    const poly = new TextEncoder().encode("GIF89a%PDF-1.7\n%%EOF\n");
    expect(inspectPdf(poly)).toMatchObject({ ok: false, code: "not_pdf" });
  });
});

import { joinPdfTextItems } from "./pdf.ts";

describe("joinPdfTextItems", () => {
  const it_ = (str: string, x: number, y: number, width = 40, hasEOL = false) => ({ str, transform: [1, 0, 0, 1, x, y], width, hasEOL });
  it("splits lines on baseline change and keeps same-line items together", () => {
    const out = joinPdfTextItems([it_("Work Order:", 72, 700), it_("90001234", 120, 700), it_("NTE:", 72, 682), it_("$450.00", 118, 682)]);
    expect(out).toBe("Work Order: 90001234\nNTE: $450.00");
  });
  it("uses two spaces for a column-sized gap and none inside a word", () => {
    expect(joinPdfTextItems([it_("Priority:", 72, 700, 40), it_("Emergency", 300, 700)])).toBe("Priority:  Emergency");
    expect(joinPdfTextItems([it_("Emer", 72, 700, 20), it_("gency", 92, 700)])).toBe("Emergency");
  });
  it("honours hasEOL and ignores non-string items", () => {
    expect(joinPdfTextItems([it_("a", 0, 10, 5, true), { str: 5 }, it_("b", 0, 10)])).toBe("a\nb");
  });
  it("returns empty for no items", () => { expect(joinPdfTextItems([])).toBe(""); });
});
