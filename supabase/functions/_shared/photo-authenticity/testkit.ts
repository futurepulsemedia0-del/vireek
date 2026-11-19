// supabase/functions/_shared/photo-authenticity/testkit.ts
//
// TEST-ONLY. Builds small sample images with exactly the metadata a test needs, so the parser and heuristics
// are exercised on real byte layouts (not on mocks of the parser). Never imported by production code.
//
// The pixel data is a real, decodable 16x12 baseline JPEG (generated once with Pillow, 677 bytes); metadata
// segments are spliced in after its JFIF header.

const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAMABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDZtbZJoyzFgQccVHdRLDIFUkgjPNRrI6jCuwHsaGZmOWYk+5q4Ua6rubnePYwc4OHKlr3P/9k=";

export const TINY_JPEG_WIDTH = 16;
export const TINY_JPEG_HEIGHT = 12;

export function tinyJpeg(): Uint8Array {
  return Uint8Array.from(atob(TINY_JPEG_B64), (c) => c.charCodeAt(0));
}

const enc = new TextEncoder();
const ascii = (s: string): number[] => Array.from(enc.encode(s));
const u16 = (n: number, le: boolean): number[] => (le ? [n & 255, (n >> 8) & 255] : [(n >> 8) & 255, n & 255]);
const u32 = (n: number, le: boolean): number[] =>
  le ? [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255] : [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

export interface ExifSpec {
  littleEndian?: boolean;
  make?: string;
  model?: string;
  software?: string;
  orientation?: number;
  /** "YYYY:MM:DD HH:MM:SS" */
  dateTimeOriginal?: string;
  dateTimeDigitized?: string;
  dateTimeModified?: string;
  /** "+02:00" */
  offsetTimeOriginal?: string;
  pixelWidth?: number;
  pixelHeight?: number;
  /** Number of capture-setting tags to include (0-5). */
  captureSettings?: number;
  makerNote?: boolean;
  gps?: boolean;
  /** Dimensions of an embedded JPEG thumbnail stub in IFD1. */
  thumbnail?: { width: number; height: number };
}

interface RawEntry { tag: number; type: number; count: number; data: number[] }

function asciiEntry(tag: number, s: string): RawEntry {
  const bytes = [...ascii(s), 0];
  return { tag, type: 2, count: bytes.length, data: bytes };
}
function shortEntry(tag: number, n: number, le: boolean): RawEntry { return { tag, type: 3, count: 1, data: u16(n, le) }; }
function longEntry(tag: number, n: number, le: boolean): RawEntry { return { tag, type: 4, count: 1, data: u32(n, le) }; }
function rationalEntry(tag: number, num: number, den: number, le: boolean): RawEntry {
  return { tag, type: 5, count: 1, data: [...u32(num, le), ...u32(den, le)] };
}

/** Lays an IFD out at `base` (offset inside the TIFF block); returns the IFD bytes and the out-of-line data. */
function layoutIfd(entries: RawEntry[], base: number, nextIfd: number, le: boolean): number[] {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const tableSize = 2 + sorted.length * 12 + 4;
  const out: number[] = [...u16(sorted.length, le)];
  const extra: number[] = [];
  for (const e of sorted) {
    out.push(...u16(e.tag, le), ...u16(e.type, le), ...u32(e.count, le));
    if (e.data.length <= 4) {
      out.push(...e.data, ...new Array(4 - e.data.length).fill(0));
    } else {
      out.push(...u32(base + tableSize + extra.length, le));
      extra.push(...e.data);
      if (extra.length % 2) extra.push(0);
    }
  }
  out.push(...u32(nextIfd, le), ...extra);
  return out;
}

export function buildTiff(spec: ExifSpec, thumbBytes?: number[]): number[] {
  const le = spec.littleEndian ?? true;
  const ifd0: RawEntry[] = [];
  if (spec.make) ifd0.push(asciiEntry(0x010f, spec.make));
  if (spec.model) ifd0.push(asciiEntry(0x0110, spec.model));
  if (spec.orientation) ifd0.push(shortEntry(0x0112, spec.orientation, le));
  if (spec.software) ifd0.push(asciiEntry(0x0131, spec.software));
  if (spec.dateTimeModified) ifd0.push(asciiEntry(0x0132, spec.dateTimeModified));

  const exif: RawEntry[] = [];
  if (spec.dateTimeOriginal) exif.push(asciiEntry(0x9003, spec.dateTimeOriginal));
  if (spec.dateTimeDigitized) exif.push(asciiEntry(0x9004, spec.dateTimeDigitized));
  if (spec.offsetTimeOriginal) exif.push(asciiEntry(0x9011, spec.offsetTimeOriginal));
  if (spec.pixelWidth) exif.push(longEntry(0xa002, spec.pixelWidth, le));
  if (spec.pixelHeight) exif.push(longEntry(0xa003, spec.pixelHeight, le));
  const settings: RawEntry[] = [
    rationalEntry(0x829a, 1, 250, le), rationalEntry(0x829d, 18, 10, le), shortEntry(0x8827, 100, le),
    rationalEntry(0x920a, 60, 10, le), asciiEntry(0xa434, "Test Lens 4.2mm"),
  ];
  exif.push(...settings.slice(0, spec.captureSettings ?? 0));
  if (spec.makerNote) exif.push({ tag: 0x927c, type: 7, count: 8, data: [1, 2, 3, 4, 5, 6, 7, 8] });

  const gps: RawEntry[] = spec.gps
    ? [asciiEntry(0x0001, "N"), { tag: 0x0002, type: 5, count: 3, data: [...u32(49, le), ...u32(1, le), ...u32(26, le), ...u32(1, le), ...u32(0, le), ...u32(1, le)] }]
    : [];

  // Two passes: sizes do not depend on the pointer values, so lay out with placeholders first.
  const withPointers = (exifOff: number, gpsOff: number, nextOff: number, thumbOff: number) => {
    const e0 = [...ifd0];
    if (exif.length) e0.push(longEntry(0x8769, exifOff, le));
    if (gps.length) e0.push(longEntry(0x8825, gpsOff, le));
    const ifd0Bytes = layoutIfd(e0, 8, nextOff, le);
    const exifBytes = exif.length ? layoutIfd(exif, exifOff, 0, le) : [];
    const gpsBytes = gps.length ? layoutIfd(gps, gpsOff, 0, le) : [];
    let ifd1Bytes: number[] = [];
    if (spec.thumbnail && thumbBytes) {
      ifd1Bytes = layoutIfd([longEntry(0x0201, thumbOff, le), longEntry(0x0202, thumbBytes.length, le)], nextOff, 0, le);
    }
    return { ifd0Bytes, exifBytes, gpsBytes, ifd1Bytes };
  };
  const probe = withPointers(0, 0, 0, 0);
  const exifOff = 8 + probe.ifd0Bytes.length;
  const gpsOff = exifOff + probe.exifBytes.length;
  const nextOff = spec.thumbnail && thumbBytes ? gpsOff + probe.gpsBytes.length : 0;
  const ifd1Len = probe.ifd1Bytes.length;
  const thumbOff = nextOff + ifd1Len;
  const real = withPointers(exifOff, gpsOff, nextOff, thumbOff);
  return [
    ...(le ? ascii("II") : ascii("MM")), ...u16(42, le), ...u32(8, le),
    ...real.ifd0Bytes, ...real.exifBytes, ...real.gpsBytes, ...real.ifd1Bytes, ...(thumbBytes ?? []),
  ];
}

/** A JPEG stub that only has what the thumbnail reader needs: SOI + SOF0 with the given size. */
export function jpegStub(width: number, height: number): number[] {
  return [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, ...u16(height, false), ...u16(width, false), 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9];
}

function segment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...u16(payload.length + 2, false), ...payload];
}

export function spliceAfterJfif(jpeg: Uint8Array, extra: number[]): Uint8Array {
  // SOI (2) + APP0 (marker 2 + length field covers itself)
  const app0Len = (jpeg[4] << 8) | jpeg[5];
  const at = 4 + app0Len;
  const out = new Uint8Array(jpeg.length + extra.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(extra, at);
  out.set(jpeg.subarray(at), at + extra.length);
  return out;
}

export function xmpPacket(fields: { creatorTool?: string; digitalSourceType?: string; history?: boolean }): string {
  const attrs = [
    fields.creatorTool ? ` xmp:CreatorTool="${fields.creatorTool}"` : "",
    fields.digitalSourceType ? ` Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitaltype/${fields.digitalSourceType}"` : "",
  ].join("");
  const history = fields.history
    ? `<xmpMM:History><rdf:Seq><rdf:li stEvt:action="saved" stEvt:softwareAgent="Test Editor"/></rdf:Seq></xmpMM:History>`
    : "";
  return `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""${attrs}>${history}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

export interface JpegSpec {
  exif?: ExifSpec;
  xmp?: { creatorTool?: string; digitalSourceType?: string; history?: boolean };
  /** Adds an APP11 "JP" (JUMBF) segment so `hasJumbf` is set. */
  jumbf?: boolean;
}

export function buildJpeg(spec: JpegSpec = {}): Uint8Array {
  const extra: number[] = [];
  if (spec.exif) {
    const thumb = spec.exif.thumbnail ? jpegStub(spec.exif.thumbnail.width, spec.exif.thumbnail.height) : undefined;
    extra.push(...segment(0xe1, [...ascii("Exif"), 0, 0, ...buildTiff(spec.exif, thumb)]));
  }
  if (spec.xmp) extra.push(...segment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0, ...ascii(xmpPacket(spec.xmp))]));
  if (spec.jumbf) extra.push(...segment(0xeb, [0x4a, 0x50, 0, 0, 0, 1, ...ascii("jumb")]));
  return extra.length ? spliceAfterJfif(tinyJpeg(), extra) : tinyJpeg();
}

// ---------------------------------------------------------------- PNG / WebP

function pngChunk(type: string, data: number[]): number[] {
  return [...u32(data.length, false), ...ascii(type), ...data, 0, 0, 0, 0]; // CRC not validated by the reader
}

export function buildPng(opts: { width?: number; height?: number; text?: Array<[string, string]>; exif?: ExifSpec; xmp?: { creatorTool?: string } } = {}): Uint8Array {
  const w = opts.width ?? 32;
  const h = opts.height ?? 24;
  const out: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  out.push(...pngChunk("IHDR", [...u32(w, false), ...u32(h, false), 8, 2, 0, 0, 0]));
  for (const [k, v] of opts.text ?? []) out.push(...pngChunk("tEXt", [...ascii(k), 0, ...ascii(v)]));
  if (opts.exif) out.push(...pngChunk("eXIf", buildTiff(opts.exif)));
  if (opts.xmp) out.push(...pngChunk("iTXt", [...ascii("XML:com.adobe.xmp"), 0, 0, 0, 0, 0, ...ascii(xmpPacket(opts.xmp))]));
  out.push(...pngChunk("IEND", []));
  return Uint8Array.from(out);
}

export function buildWebp(opts: { width?: number; height?: number; exif?: ExifSpec } = {}): Uint8Array {
  const w = opts.width ?? 32;
  const h = opts.height ?? 24;
  const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
  const chunk = (cc: string, data: number[]) => [...ascii(cc), ...u32(data.length, true), ...data, ...(data.length % 2 ? [0] : [])];
  const body: number[] = [
    ...ascii("WEBP"),
    ...chunk("VP8X", [opts.exif ? 0x08 : 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]),
  ];
  if (opts.exif) body.push(...chunk("EXIF", [...ascii("Exif"), 0, 0, ...buildTiff(opts.exif)]));
  return Uint8Array.from([...ascii("RIFF"), ...u32(body.length, true), ...body]);
}
