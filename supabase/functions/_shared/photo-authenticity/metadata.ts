// supabase/functions/_shared/photo-authenticity/metadata.ts
//
// Dependency-free, bounds-checked reader for the metadata that matters for photo consistency checks.
// Runs on bytes the server has already downloaded and hash-verified. The input is UNTRUSTED: every read is
// range-checked, loops are capped, strings are sanitised, and a malformed file degrades to
// `parsedCompletely = false` with a stable note code instead of throwing.
//
// Deliberately NOT extracted (privacy): GPS coordinates, body/lens serial numbers, owner/artist names,
// user comments, maker-note contents, embedded thumbnails. GPS is reported as a boolean only.
//
// Formats: JPEG, PNG, WebP (EXIF + XMP + dimensions). HEIC is detected but its metadata is not parsed.

import type { ImageFormat, ImageMetadata, ParsedExifTime } from "./types.ts";

const MAX_SEGMENTS = 256;
const MAX_CHUNKS = 1024;
const MAX_IFD_ENTRIES = 512;
const MAX_IFDS = 8;
const MAX_XMP_BYTES = 128 * 1024;
const MAX_TEXT = 200;

/** PNG text-chunk keywords written by popular image generators (the CONTENT is never read). */
const GENERATOR_KEYWORDS = new Set([
  "parameters", "prompt", "workflow", "invokeai_metadata", "invokeai_graph", "sd-metadata", "dream", "generation_data",
]);

// ------------------------------------------------------------------ small helpers

class Bound extends Error {}

export function sanitizeText(raw: string | null | undefined, max = MAX_TEXT): string | null {
  if (!raw) return null;
  // Drop control characters, bidi overrides and zero-width characters; collapse whitespace.
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function latin1(b: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

function asciiAt(b: Uint8Array, at: number, text: string): boolean {
  if (at < 0 || at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

export function detectFormat(b: Uint8Array): ImageFormat {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && asciiAt(b, 1, "PNG") && b[0] === 0x89 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 12 && asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WEBP")) return "webp";
  if (b.length >= 12 && asciiAt(b, 4, "ftyp")) {
    const brand = latin1(b, 8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return "unknown";
}

const be16 = (b: Uint8Array, o: number): number => {
  if (o < 0 || o + 2 > b.length) throw new Bound();
  return (b[o] << 8) | b[o + 1];
};
const be32 = (b: Uint8Array, o: number): number => {
  if (o < 0 || o + 4 > b.length) throw new Bound();
  return ((b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
};
const le32 = (b: Uint8Array, o: number): number => {
  if (o < 0 || o + 4 > b.length) throw new Bound();
  return ((b[o + 3] * 0x1000000) + ((b[o + 2] << 16) | (b[o + 1] << 8) | b[o])) >>> 0;
};
const le24 = (b: Uint8Array, o: number): number => {
  if (o < 0 || o + 3 > b.length) throw new Bound();
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
};

// ------------------------------------------------------------------ result accumulator

function emptyMetadata(format: ImageFormat): ImageMetadata {
  return {
    format, parsedCompletely: true, parseNotes: [], width: null, height: null,
    hasExif: false, hasXmp: false, hasJumbf: false,
    make: null, model: null, software: null, creatorTool: null, digitalSourceType: null,
    dateTimeOriginal: null, dateTimeDigitized: null, dateTimeModified: null,
    orientation: null, exifPixelWidth: null, exifPixelHeight: null,
    captureSettingCount: 0, hasMakerNote: false, hasGps: false, thumbnail: null,
    hasEditHistory: false, generatorChunkKeywords: [],
  };
}

function note(m: ImageMetadata, code: string, incomplete = true): void {
  if (!m.parseNotes.includes(code) && m.parseNotes.length < 20) m.parseNotes.push(code);
  if (incomplete) m.parsedCompletely = false;
}

// ------------------------------------------------------------------ EXIF date/offset

export function parseExifDate(text: string | null, offsetText: string | null): ParsedExifTime | null {
  if (!text) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null; // e.g. Feb 30
  let offsetMinutes: number | null = null;
  if (offsetText) {
    const o = /^([+-])(\d{2}):(\d{2})$/.exec(offsetText.trim());
    if (o) {
      const total = Number(o[2]) * 60 + Number(o[3]);
      if (total <= 14 * 60 && Number(o[3]) < 60) offsetMinutes = o[1] === "-" ? -total : total;
    }
  }
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return { local: `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`, localAsUtcMs: ms, offsetMinutes };
}

// ------------------------------------------------------------------ TIFF / EXIF

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

interface IfdEntry { tag: number; type: number; count: number; valueAt: number }

const CAPTURE_SETTING_TAGS = new Set([0x829a, 0x829d, 0x8827, 0x920a, 0xa434]);

function parseTiff(b: Uint8Array, start: number, end: number, m: ImageMetadata): void {
  if (end - start < 8) { note(m, "exif_too_short"); return; }
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  const bigEndian = b[start] === 0x4d && b[start + 1] === 0x4d;
  if (!le && !bigEndian) { note(m, "exif_bad_byte_order"); return; }
  const r16 = (o: number): number => {
    if (o < start || o + 2 > end) throw new Bound();
    return le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
  };
  const r32 = (o: number): number => {
    if (o < start || o + 4 > end) throw new Bound();
    return le
      ? ((b[o + 3] * 0x1000000) + ((b[o + 2] << 16) | (b[o + 1] << 8) | b[o])) >>> 0
      : ((b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
  };
  if (r16(start + 2) !== 42) { note(m, "exif_bad_magic"); return; }

  const visited = new Set<number>();
  const readIfd = (rel: number): { entries: IfdEntry[]; next: number } | null => {
    const at = start + rel;
    if (rel < 8 || visited.has(at) || visited.size >= MAX_IFDS) return null;
    visited.add(at);
    let count: number;
    try { count = r16(at); } catch { note(m, "exif_ifd_out_of_range"); return null; }
    if (count > MAX_IFD_ENTRIES) { note(m, "exif_ifd_too_large"); count = MAX_IFD_ENTRIES; }
    const entries: IfdEntry[] = [];
    for (let i = 0; i < count; i++) {
      const eo = at + 2 + i * 12;
      try {
        const tag = r16(eo);
        const type = r16(eo + 2);
        const cnt = r32(eo + 4);
        const unit = TYPE_SIZE[type];
        if (!unit) continue;
        const size = unit * cnt;
        if (!Number.isFinite(size) || size > 0x7fffffff) { note(m, "exif_value_out_of_range"); continue; }
        const valueAt = size <= 4 ? eo + 8 : start + r32(eo + 8);
        if (valueAt < start || valueAt + size > end) { note(m, "exif_value_out_of_range"); continue; }
        entries.push({ tag, type, count: cnt, valueAt });
      } catch { note(m, "exif_entry_out_of_range"); break; }
    }
    let next = 0;
    try { next = r32(at + 2 + count * 12); } catch { /* no next pointer: fine */ }
    return { entries, next };
  };

  const text = (e: IfdEntry, max = MAX_TEXT): string | null => {
    if (e.type !== 2) return null;
    const n = Math.min(e.count, 512);
    let s = "";
    for (let i = 0; i < n; i++) {
      const c = b[e.valueAt + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return sanitizeText(s, max);
  };
  const num = (e: IfdEntry): number | null => {
    try {
      if (e.type === 3) return r16(e.valueAt);
      if (e.type === 4) return r32(e.valueAt);
    } catch { /* fall through */ }
    return null;
  };
  const rawText = (e: IfdEntry): string | null => text(e, 40);

  // ---- IFD0
  const ifd0 = readIfd(r32(start + 4));
  if (!ifd0) { note(m, "exif_ifd0_unreadable"); return; }
  m.hasExif = true;
  let exifPtr = 0;
  let gpsPtr = 0;
  let dateModified: string | null = null;
  let offsetModified: string | null = null; // not a standard IFD0 tag; kept for symmetry
  for (const e of ifd0.entries) {
    switch (e.tag) {
      case 0x010f: m.make = text(e, 64); break;
      case 0x0110: m.model = text(e, 64); break;
      case 0x0112: m.orientation = num(e); break;
      case 0x0131: m.software = text(e, 100); break;
      case 0x0132: dateModified = rawText(e); break;
      case 0x8769: exifPtr = num(e) ?? 0; break;
      case 0x8825: gpsPtr = num(e) ?? 0; break;
      default: break;
    }
  }

  // ---- Exif sub-IFD
  let dto: string | null = null;
  let dtd: string | null = null;
  let offO: string | null = null;
  let offD: string | null = null;
  const settings = new Set<number>();
  if (exifPtr) {
    const sub = readIfd(exifPtr);
    if (sub) {
      for (const e of sub.entries) {
        if (CAPTURE_SETTING_TAGS.has(e.tag)) settings.add(e.tag);
        switch (e.tag) {
          case 0x9003: dto = rawText(e); break;
          case 0x9004: dtd = rawText(e); break;
          case 0x9011: offO = rawText(e); break;
          case 0x9012: offD = rawText(e); break;
          case 0x9010: offsetModified = rawText(e); break;
          case 0xa002: m.exifPixelWidth = num(e); break;
          case 0xa003: m.exifPixelHeight = num(e); break;
          case 0x927c: m.hasMakerNote = true; break;
          default: break;
        }
      }
    }
  }
  m.captureSettingCount = settings.size;
  m.dateTimeOriginal = parseExifDate(dto, offO);
  m.dateTimeDigitized = parseExifDate(dtd, offD);
  m.dateTimeModified = parseExifDate(dateModified, offsetModified);

  // ---- GPS sub-IFD: presence only
  if (gpsPtr) {
    const gps = readIfd(gpsPtr);
    if (gps && gps.entries.some((e) => e.tag === 0x0002 || e.tag === 0x0004)) m.hasGps = true;
  }

  // ---- IFD1: embedded thumbnail dimensions (the thumbnail itself is not stored)
  if (ifd0.next) {
    const ifd1 = readIfd(ifd0.next);
    if (ifd1) {
      const off = ifd1.entries.find((e) => e.tag === 0x0201);
      const len = ifd1.entries.find((e) => e.tag === 0x0202);
      const o = off ? num(off) : null;
      const l = len ? num(len) : null;
      if (o !== null && l !== null && l > 4 && start + o + l <= end) {
        const dims = jpegDimensions(b, start + o, start + o + l);
        if (dims) m.thumbnail = dims;
      }
    }
  }
}

// ------------------------------------------------------------------ JPEG

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const XMP_NS = "http://ns.adobe.com/xap/1.0/\u0000";

/** Width/height from the first SOF marker inside [start, end). Used for the main image and for EXIF thumbnails. */
export function jpegDimensions(b: Uint8Array, start: number, end: number): { width: number; height: number } | null {
  try {
    if (b[start] !== 0xff || b[start + 1] !== 0xd8) return null;
    let i = start + 2;
    for (let n = 0; n < MAX_SEGMENTS && i + 4 <= end; n++) {
      if (b[i] !== 0xff) return null;
      while (i < end && b[i] === 0xff) i++;
      const marker = b[i];
      i++;
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      const len = be16(b, i);
      if (len < 2) return null;
      if (SOF_MARKERS.has(marker)) {
        const height = be16(b, i + 3);
        const width = be16(b, i + 5);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      i += len;
    }
  } catch { /* malformed thumbnail: ignore */ }
  return null;
}

function parseJpeg(b: Uint8Array, m: ImageMetadata): void {
  let i = 2;
  let sawExif = false;
  let segments = 0;
  while (i + 4 <= b.length) {
    if (++segments > MAX_SEGMENTS) { note(m, "jpeg_too_many_segments"); return; }
    if (b[i] !== 0xff) { note(m, "jpeg_bad_marker"); return; }
    while (i < b.length && b[i] === 0xff) i++;
    const marker = b[i];
    i++;
    if (marker === 0xd9) return;                                     // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // standalone markers
    let len: number;
    try { len = be16(b, i); } catch { note(m, "jpeg_truncated"); return; }
    if (len < 2) { note(m, "jpeg_bad_segment_length"); return; }
    const segStart = i + 2;
    const segEnd = i + len;
    if (segEnd > b.length) { note(m, "jpeg_truncated"); return; }

    if (marker === 0xe1) {
      if (!sawExif && asciiAt(b, segStart, "Exif\u0000\u0000")) {
        sawExif = true;
        try { parseTiff(b, segStart + 6, segEnd, m); } catch { note(m, "exif_unreadable"); }
      } else if (asciiAt(b, segStart, XMP_NS)) {
        m.hasXmp = true;
        readXmp(b, segStart + XMP_NS.length, segEnd, m);
      }
    } else if (marker === 0xeb && b[segStart] === 0x4a && b[segStart + 1] === 0x50) {
      m.hasJumbf = true; // "JP" common identifier of JUMBF in APP11
    } else if (SOF_MARKERS.has(marker) && m.width === null) {
      try {
        m.height = be16(b, segStart + 1);
        m.width = be16(b, segStart + 3);
        if (!m.width || !m.height) { m.width = null; m.height = null; }
      } catch { note(m, "jpeg_truncated"); return; }
    } else if (marker === 0xda) {
      return; // start of scan: all metadata segments precede it
    }
    i = segEnd;
  }
}

// ------------------------------------------------------------------ PNG

function parsePng(b: Uint8Array, m: ImageMetadata): void {
  let i = 8;
  let chunks = 0;
  while (i + 12 <= b.length) {
    if (++chunks > MAX_CHUNKS) { note(m, "png_too_many_chunks"); return; }
    let length: number;
    try { length = be32(b, i); } catch { note(m, "png_truncated"); return; }
    const type = latin1(b, i + 4, i + 8);
    const dataStart = i + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > b.length) { note(m, "png_truncated"); return; }

    if (type === "IHDR" && length >= 8) {
      m.width = be32(b, dataStart);
      m.height = be32(b, dataStart + 4);
    } else if (type === "eXIf") {
      try { parseTiff(b, dataStart, dataEnd, m); } catch { note(m, "exif_unreadable"); }
    } else if (type === "caBX") {
      m.hasJumbf = true;
    } else if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      let k = dataStart;
      while (k < dataEnd && k - dataStart < 80 && b[k] !== 0) k++;
      const keyword = latin1(b, dataStart, k);
      const lower = keyword.toLowerCase();
      if (GENERATOR_KEYWORDS.has(lower) && !m.generatorChunkKeywords.includes(lower) && m.generatorChunkKeywords.length < 8) {
        m.generatorChunkKeywords.push(lower);
      }
      if (type === "tEXt" && lower === "software") {
        m.software = sanitizeText(latin1(b, k + 1, Math.min(dataEnd, k + 1 + 100)), 100);
      } else if (type === "iTXt" && keyword === "XML:com.adobe.xmp" && b[k + 1] === 0) {
        // compression flag 0 (uncompressed): skip flag, method, language tag and translated keyword (both NUL-terminated)
        let p = k + 3;
        for (let z = 0; z < 2 && p < dataEnd; z++) { while (p < dataEnd && b[p] !== 0) p++; p++; }
        m.hasXmp = true;
        readXmp(b, p, dataEnd, m);
      }
    } else if (type === "IEND") {
      return;
    }
    i = dataEnd + 4;
  }
}

// ------------------------------------------------------------------ WebP

function parseWebp(b: Uint8Array, m: ImageMetadata): void {
  let i = 12;
  let chunks = 0;
  while (i + 8 <= b.length) {
    if (++chunks > MAX_CHUNKS) { note(m, "webp_too_many_chunks"); return; }
    const fourcc = latin1(b, i, i + 4);
    let size: number;
    try { size = le32(b, i + 4); } catch { note(m, "webp_truncated"); return; }
    const dataStart = i + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > b.length) { note(m, "webp_truncated"); return; }
    try {
      if (fourcc === "VP8X" && size >= 10) {
        m.width = 1 + le24(b, dataStart + 4);
        m.height = 1 + le24(b, dataStart + 7);
      } else if (fourcc === "VP8 " && size >= 10 && m.width === null && b[dataStart + 3] === 0x9d && b[dataStart + 4] === 0x01 && b[dataStart + 5] === 0x2a) {
        m.width = (b[dataStart + 6] | (b[dataStart + 7] << 8)) & 0x3fff;
        m.height = (b[dataStart + 8] | (b[dataStart + 9] << 8)) & 0x3fff;
      } else if (fourcc === "VP8L" && size >= 5 && m.width === null && b[dataStart] === 0x2f) {
        const bits = le32(b, dataStart + 1);
        m.width = (bits & 0x3fff) + 1;
        m.height = ((bits >>> 14) & 0x3fff) + 1;
      } else if (fourcc === "EXIF") {
        const s = asciiAt(b, dataStart, "Exif\u0000\u0000") ? dataStart + 6 : dataStart;
        parseTiff(b, s, dataEnd, m);
      } else if (fourcc === "XMP ") {
        m.hasXmp = true;
        readXmp(b, dataStart, dataEnd, m);
      } else if (fourcc === "C2PA") {
        m.hasJumbf = true;
      }
    } catch { note(m, "webp_chunk_unreadable"); }
    i = dataEnd + (size % 2);
  }
}

// ------------------------------------------------------------------ XMP (presence + three scalar fields)

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, n: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[n] as string));
}

function readXmp(b: Uint8Array, start: number, end: number, m: ImageMetadata): void {
  const to = Math.min(end, start + MAX_XMP_BYTES);
  if (to <= start) return;
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(start, to));
  // Attribute or element form; patterns are anchored on literal names and bounded, so they are linear-time.
  const pick = (name: string): string | null => {
    const attr = new RegExp(`${name}="([^"]{1,300})"`).exec(xml);
    if (attr) return decodeEntities(attr[1]);
    const el = new RegExp(`<${name}>([^<]{1,300})</${name}>`).exec(xml);
    return el ? decodeEntities(el[1]) : null;
  };
  const tool = sanitizeText(pick("xmp:CreatorTool"), 100);
  if (tool && !m.creatorTool) m.creatorTool = tool;
  const dst = pick("Iptc4xmpExt:DigitalSourceType");
  if (dst && !m.digitalSourceType) {
    const token = dst.trim().split("/").pop() ?? "";
    if (/^[A-Za-z0-9_-]{1,60}$/.test(token)) m.digitalSourceType = token;
  }
  if (/<xmpMM:History>|<photoshop:History>|stEvt:action="/.test(xml)) m.hasEditHistory = true;
}

// ------------------------------------------------------------------ entry point

export function parseImageMetadata(bytes: Uint8Array): ImageMetadata {
  const format = detectFormat(bytes);
  const m = emptyMetadata(format);
  try {
    if (format === "jpeg") parseJpeg(bytes, m);
    else if (format === "png") parsePng(bytes, m);
    else if (format === "webp") parseWebp(bytes, m);
    else if (format === "heic") note(m, "heic_metadata_not_parsed");
    else note(m, "unrecognised_format");
  } catch {
    note(m, "metadata_unreadable");
  }
  return m;
}
