// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { detectFormat, parseExifDate, parseImageMetadata, sanitizeText } from "./metadata.ts";
import { buildJpeg, buildPng, buildWebp, TINY_JPEG_HEIGHT, TINY_JPEG_WIDTH, tinyJpeg } from "./testkit.ts";

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

describe("parseExifDate", () => {
  it("parses valid dates and offsets", () => {
    const t = parseExifDate("2026:11:10 10:00:00", "+01:00")!;
    expect(t.local).toBe("2026-11-10T10:00:00");
    expect(t.offsetMinutes).toBe(60);
    expect(parseExifDate("2026:11:10 10:00:00", "-05:30")!.offsetMinutes).toBe(-330);
  });
  it("rejects impossible or implausible dates", () => {
    for (const bad of ["2026:02:30 10:00:00", "2026:13:01 00:00:00", "1970:01:01 00:00:00", "0000:00:00 00:00:00", "garbage", "2026:11:10 25:00:00"]) {
      expect(parseExifDate(bad, null)).toBeNull();
    }
    expect(parseExifDate("2026:11:10 10:00:00", "+99:00")!.offsetMinutes).toBeNull();
  });
});

describe("sanitizeText", () => {
  it("strips control, bidi and zero-width characters and bounds length", () => {
    expect(sanitizeText("Ab\u0000c\u202eevil\u200b  d")).toBe("Ab c evil d");
    expect(sanitizeText("x".repeat(500), 50)!.length).toBe(50);
    expect(sanitizeText("   ")).toBeNull();
  });
});

describe("JPEG", () => {
  it("reads a hand-built camera file (also decodable by Pillow, see fixtures README)", () => {
    const m = parseImageMetadata(fx("sample-camera-consistent.jpg"));
    expect(m.format).toBe("jpeg");
    expect(m.parsedCompletely).toBe(true);
    expect(m.hasExif).toBe(true);
    expect(m.make).toBe("TestCam");
    expect(m.model).toBe("TC-100");
    expect(m.width).toBe(TINY_JPEG_WIDTH);
    expect(m.height).toBe(TINY_JPEG_HEIGHT);
    expect(m.exifPixelWidth).toBe(16);
    expect(m.captureSettingCount).toBe(5);
    expect(m.hasMakerNote).toBe(true);
    expect(m.dateTimeOriginal?.offsetMinutes).toBe(60);
    expect(m.thumbnail).toEqual({ width: 160, height: 120 });
    expect(m.hasGps).toBe(false);
  });
  it("works for big-endian EXIF too", () => {
    const m = parseImageMetadata(buildJpeg({ exif: { littleEndian: false, make: "BE", model: "M", dateTimeOriginal: "2026:11:10 10:00:00" } }));
    expect(m.make).toBe("BE");
    expect(m.dateTimeOriginal?.local).toBe("2026-11-10T10:00:00");
  });
  it("reports GPS presence only, never coordinates", () => {
    const m = parseImageMetadata(buildJpeg({ exif: { make: "X", gps: true } }));
    expect(m.hasGps).toBe(true);
    expect(JSON.stringify(m)).not.toMatch(/latitude|longitude/i);
  });
  it("reads XMP tool, digital source type and edit history", () => {
    const m = parseImageMetadata(buildJpeg({ xmp: { creatorTool: "Adobe Photoshop 25.1", digitalSourceType: "trainedAlgorithmicMedia", history: true } }));
    expect(m.hasXmp).toBe(true);
    expect(m.creatorTool).toBe("Adobe Photoshop 25.1");
    expect(m.digitalSourceType).toBe("trainedAlgorithmicMedia");
    expect(m.hasEditHistory).toBe(true);
  });
  it("detects a JUMBF segment without validating it", () => {
    expect(parseImageMetadata(buildJpeg({ jumbf: true })).hasJumbf).toBe(true);
    expect(parseImageMetadata(fx("c2pa-valid-test-signer.jpg")).hasJumbf).toBe(true);
  });
  it("a plain JPEG has no metadata and is still 'complete'", () => {
    const m = parseImageMetadata(tinyJpeg());
    expect(m.hasExif).toBe(false);
    expect(m.hasXmp).toBe(false);
    expect(m.parsedCompletely).toBe(true);
  });
  it("never throws on truncated or corrupted input", () => {
    const good = fx("sample-camera-consistent.jpg");
    for (let cut = 0; cut < good.length; cut += 7) {
      expect(() => parseImageMetadata(good.subarray(0, cut))).not.toThrow();
    }
    const rnd = Uint8Array.from(good);
    let seed = 12345;
    for (let round = 0; round < 300; round++) {
      const c = Uint8Array.from(rnd);
      for (let k = 0; k < 6; k++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; c[seed % c.length] = seed & 255; }
      expect(() => parseImageMetadata(c)).not.toThrow();
    }
  });
  it("flags a truncated file as incomplete", () => {
    const good = fx("sample-camera-consistent.jpg");
    const m = parseImageMetadata(good.subarray(0, 60));
    expect(m.parsedCompletely).toBe(false);
    expect(m.parseNotes.length).toBeGreaterThan(0);
  });
  it("does not loop on a self-referencing IFD", () => {
    const j = buildJpeg({ exif: { make: "Loop", model: "M", dateTimeOriginal: "2026:11:10 10:00:00", thumbnail: { width: 4, height: 3 } } });
    const text = new TextDecoder("latin1").decode(j);
    const at = text.indexOf("Exif\u0000\u0000") + 6;
    const c = Uint8Array.from(j);
    // point IFD0's "next IFD" back at IFD0 itself (offset 8)
    const count = c[at + 8] | (c[at + 9] << 8);
    const nextAt = at + 8 + 2 + count * 12;
    c[nextAt] = 8; c[nextAt + 1] = 0; c[nextAt + 2] = 0; c[nextAt + 3] = 0;
    expect(() => parseImageMetadata(c)).not.toThrow();
  });
});

describe("PNG and WebP", () => {
  it("reads PNG size, software text and generator keywords (keyword only)", () => {
    const m = parseImageMetadata(buildPng({ width: 64, height: 48, text: [["Software", "Midjourney"], ["parameters", "secret prompt text"]] }));
    expect(m.format).toBe("png");
    expect([m.width, m.height]).toEqual([64, 48]);
    expect(m.software).toBe("Midjourney");
    expect(m.generatorChunkKeywords).toEqual(["parameters"]);
    expect(JSON.stringify(m)).not.toContain("secret prompt");
  });
  it("reads EXIF and XMP inside PNG", () => {
    const m = parseImageMetadata(buildPng({ exif: { make: "PngCam", model: "P1" }, xmp: { creatorTool: "Tool X" } }));
    expect(m.make).toBe("PngCam");
    expect(m.creatorTool).toBe("Tool X");
  });
  it("reads WebP canvas size and EXIF", () => {
    const m = parseImageMetadata(buildWebp({ width: 300, height: 200, exif: { make: "WebCam", model: "W1", dateTimeOriginal: "2026:11:10 10:00:00" } }));
    expect(m.format).toBe("webp");
    expect([m.width, m.height]).toEqual([300, 200]);
    expect(m.make).toBe("WebCam");
  });
  it("detects formats and degrades gracefully for HEIC and unknown data", () => {
    expect(detectFormat(new Uint8Array([0x00, 0x00, 0x00, 0x18, ...new TextEncoder().encode("ftypheic")]))).toBe("heic");
    const heic = parseImageMetadata(new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 0, 0, 0, 0]));
    expect(heic.parsedCompletely).toBe(false);
    expect(heic.parseNotes).toContain("heic_metadata_not_parsed");
    expect(parseImageMetadata(new Uint8Array([1, 2, 3])).format).toBe("unknown");
  });
});
