// src/lib/xlsxReader.ts
//
// Dependency-free .xlsx reader for the goal-intake flow. Reads ONLY what a goals sheet needs — the first
// worksheet's cell values — and turns them into CSV so the same deterministic extractor handles every input.
//
// Safety: input is untrusted. Hard caps on file size, entry count and inflated size (zip-bomb defence);
// encrypted and ZIP64 archives are refused; XML is parsed with the browser's DOMParser (no external entities
// are ever resolved); formulas are never evaluated — only the cached value Excel stored is read.

const MAX_FILE_BYTES = 2_000_000;
const MAX_ENTRIES = 2_000;
const MAX_INFLATED_BYTES = 8_000_000;
const MAX_ROWS = 500;
const MAX_COLS = 50;

export type XlsxErrorCode = 'too_large' | 'not_xlsx' | 'encrypted' | 'unsupported' | 'inflate_unavailable' | 'no_sheet' | 'too_big_inflated';

export class XlsxError extends Error {
  code: XlsxErrorCode;
  constructor(code: XlsxErrorCode) {
    super(code);
    this.name = 'XlsxError';
    this.code = code;
  }
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  flags: number;
}

function readEntries(buf: Uint8Array): Map<string, ZipEntry> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End Of Central Directory record: scan backwards (it can be followed by a ≤64 KB comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxError('not_xlsx');
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new XlsxError('unsupported'); // ZIP64
  if (count > MAX_ENTRIES || cdOffset + cdSize > buf.length) throw new XlsxError('not_xlsx');

  const out = new Map<string, ZipEntry>();
  const dec = new TextDecoder();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw new XlsxError('not_xlsx');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const uncompressedSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { name, method, compressedSize, uncompressedSize, offset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new XlsxError('inflate_unavailable');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_INFLATED_BYTES) { await reader.cancel(); throw new XlsxError('too_big_inflated'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function readEntry(buf: Uint8Array, e: ZipEntry): Promise<string> {
  if (e.flags & 1) throw new XlsxError('encrypted');
  if (e.uncompressedSize > MAX_INFLATED_BYTES) throw new XlsxError('too_big_inflated');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (e.offset + 30 > buf.length || dv.getUint32(e.offset, true) !== 0x04034b50) throw new XlsxError('not_xlsx');
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  const raw = buf.subarray(start, start + e.compressedSize);
  if (raw.length !== e.compressedSize) throw new XlsxError('not_xlsx');
  let bytes: Uint8Array;
  if (e.method === 0) bytes = raw;
  else if (e.method === 8) bytes = await inflateRaw(raw);
  else throw new XlsxError('unsupported');
  return new TextDecoder().decode(bytes);
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new XlsxError('not_xlsx');
  return doc;
}

const byLocalName = (root: Document | Element, name: string): Element[] => Array.from(root.getElementsByTagNameNS('*', name));

function colIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const csvCell = (v: string) => (/[",\n\r\t;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Reads the first worksheet of an .xlsx and returns it as CSV, preserving row/column positions (A1 refs stay true). */
export async function readXlsxToCsv(data: ArrayBuffer): Promise<{ csv: string; sheetName: string }> {
  if (data.byteLength > MAX_FILE_BYTES) throw new XlsxError('too_large');
  const buf = new Uint8Array(data);
  const entries = readEntries(buf);
  const need = (name: string) => {
    const e = entries.get(name);
    if (!e) throw new XlsxError('not_xlsx');
    return e;
  };

  const workbook = parseXml(await readEntry(buf, need('xl/workbook.xml')));
  const firstSheet = byLocalName(workbook, 'sheet')[0];
  if (!firstSheet) throw new XlsxError('no_sheet');
  const sheetName = firstSheet.getAttribute('name') ?? 'Sheet1';
  const rid = firstSheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? firstSheet.getAttribute('r:id');

  let sheetPath = 'xl/worksheets/sheet1.xml';
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
  if (relsEntry && rid) {
    const rel = byLocalName(parseXml(await readEntry(buf, relsEntry)), 'Relationship').find((r) => r.getAttribute('Id') === rid);
    const target = rel?.getAttribute('Target');
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }

  const shared: string[] = [];
  const ssEntry = entries.get('xl/sharedStrings.xml');
  if (ssEntry) {
    for (const si of byLocalName(parseXml(await readEntry(buf, ssEntry)), 'si')) {
      shared.push(byLocalName(si, 't').map((t) => t.textContent ?? '').join(''));
    }
  }

  const sheet = parseXml(await readEntry(buf, need(sheetPath)));
  const grid: string[][] = [];
  let maxCol = 0;
  for (const row of byLocalName(sheet, 'row')) {
    const r = Number(row.getAttribute('r')) - 1;
    if (!Number.isInteger(r) || r < 0 || r >= MAX_ROWS) continue;
    for (const c of byLocalName(row, 'c')) {
      const ref = c.getAttribute('r') ?? '';
      const ci = colIndex(ref);
      if (ci < 0 || ci >= MAX_COLS) continue;
      const type = c.getAttribute('t');
      const v = byLocalName(c, 'v')[0]?.textContent ?? '';
      let text = '';
      if (type === 's') text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = byLocalName(c, 't').map((t) => t.textContent ?? '').join('');
      else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'e') text = ''; // error cell (#DIV/0!, …): never treat as a value
      else text = v; // numbers and cached formula results ("str" results are plain text too)
      if (text === '') continue;
      (grid[r] ??= [])[ci] = text;
      maxCol = Math.max(maxCol, ci + 1);
    }
  }

  const lines: string[] = [];
  for (let r = 0; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    lines.push(Array.from({ length: maxCol }, (_, i) => csvCell(cells[i] ?? '')).join(','));
  }
  return { csv: lines.join('\n'), sheetName };
}
