/**
 * Minimal, dependency-free ZIP writer (STORE method, no compression).
 * Job photos are already compressed (JPEG/HEIC/WebP), so deflating them would
 * burn CPU for ~0% gain. Supports up to 65,535 entries and < 4 GB total
 * (no ZIP64) — the gallery caps bulk downloads far below that.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  modified?: Date;
}

let CRC_TABLE: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

export function crc32(data: Uint8Array): number {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Builds the ZIP archive bytes. Entry names are UTF-8 (flag bit 11). */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) throw new Error('Too many files for one ZIP archive.');
  const encoder = new TextEncoder();
  const prepared = entries.map((e) => {
    const name = encoder.encode(e.name);
    const { time, date } = dosDateTime(e.modified ?? new Date());
    return { name, data: e.data, crc: crc32(e.data), time, date };
  });

  let total = 22; // end-of-central-directory
  for (const p of prepared) total += 30 + p.name.length + p.data.length + 46 + p.name.length;
  if (total > 0xffffffff) throw new Error('Archive too large (4 GB limit).');

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  const offsets: number[] = [];

  for (const p of prepared) {
    offsets.push(offset);
    view.setUint32(offset, 0x04034b50, true); // local file header
    view.setUint16(offset + 4, 20, true); // version needed
    view.setUint16(offset + 6, 0x0800, true); // UTF-8 names
    view.setUint16(offset + 8, 0, true); // STORE
    view.setUint16(offset + 10, p.time, true);
    view.setUint16(offset + 12, p.date, true);
    view.setUint32(offset + 14, p.crc, true);
    view.setUint32(offset + 18, p.data.length, true);
    view.setUint32(offset + 22, p.data.length, true);
    view.setUint16(offset + 26, p.name.length, true);
    view.setUint16(offset + 28, 0, true);
    out.set(p.name, offset + 30);
    out.set(p.data, offset + 30 + p.name.length);
    offset += 30 + p.name.length + p.data.length;
  }

  const centralStart = offset;
  prepared.forEach((p, i) => {
    view.setUint32(offset, 0x02014b50, true); // central directory header
    view.setUint16(offset + 4, 20, true); // version made by
    view.setUint16(offset + 6, 20, true); // version needed
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, p.time, true);
    view.setUint16(offset + 14, p.date, true);
    view.setUint32(offset + 16, p.crc, true);
    view.setUint32(offset + 20, p.data.length, true);
    view.setUint32(offset + 24, p.data.length, true);
    view.setUint16(offset + 28, p.name.length, true);
    view.setUint32(offset + 42, offsets[i], true);
    out.set(p.name, offset + 46);
    offset += 46 + p.name.length;
  });

  view.setUint32(offset, 0x06054b50, true); // end of central directory
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  return out;
}

export function buildZipBlob(entries: ZipEntry[]): Blob {
  return new Blob([buildZip(entries) as BlobPart], { type: 'application/zip' });
}
