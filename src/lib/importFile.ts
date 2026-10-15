// src/lib/importFile.ts
//
// Reads a CSV / TSV / XLSX file in the browser into one normalized table, and
// serializes it back to canonical comma-separated CSV for the server. Handles
// what real competitor exports throw at us: UTF-8 BOMs, Windows-1252 and
// UTF-16 text, semicolon/tab delimiters, quoted newlines, duplicate or blank
// headers, trailing empty columns/rows, Excel dates and multi-sheet workbooks.
// All user-facing failures are ImportFileError with a plain-language message.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_COLUMNS = 120;

export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFileError';
  }
}

export interface ParsedTable {
  fileName: string;
  fileType: 'csv' | 'xlsx';
  headers: string[];
  rows: string[][];
  sheetNames: string[];
  sheet: string | null;
}

// ---------------------------------------------------------------- text → matrix

export function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes); // Excel's "CSV (Comma delimited)" on Windows
  }
}

export function detectDelimiter(text: string): string {
  const candidates = [',', ';', '\t', '|'];
  const counts = new Map(candidates.map((c) => [c, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length && i < 20000; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === '\n') break;
    else if (!inQuotes && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best = ',';
  for (const c of candidates) if ((counts.get(c) ?? 0) > (counts.get(best) ?? 0)) best = c;
  return best;
}

export function parseDelimited(text: string, delimiter: string): string[][] {
  const input = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true;
    else if (ch === delimiter) { record.push(field); field = ''; }
    else if (ch === '\n') { record.push(field); records.push(record); field = ''; record = []; }
    else field += ch;
  }
  if (field.length > 0 || record.length > 0) { record.push(field); records.push(record); }
  return records;
}

// ---------------------------------------------------------------- matrix → table

/** "Name","Name","" → "Name","Name (2)","Column 3" — the server keys rows by header, so they must be unique. */
export function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    // read-excel-file returns spreadsheet wall-clock times as UTC fields.
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    const hasTime = value.getUTCHours() + value.getUTCMinutes() + value.getUTCSeconds() > 0;
    return hasTime ? `${date} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}` : date;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).trim();
}

export function matrixToTable(matrix: string[][]): { headers: string[]; rows: string[][] } {
  const nonEmpty = matrix.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) throw new ImportFileError('This file is empty.');

  const headerRow = nonEmpty[0].map((h) => h.trim());
  let width = headerRow.length;
  while (width > 0 && headerRow[width - 1] === '') width--; // trailing blank header columns
  if (width === 0) throw new ImportFileError('The first row has no column headers.');
  if (width > MAX_IMPORT_COLUMNS) throw new ImportFileError(`This file has ${width} columns — the limit is ${MAX_IMPORT_COLUMNS}.`);

  const headers = uniqueHeaders(headerRow.slice(0, width));
  const rows = nonEmpty.slice(1).map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').trim()));
  if (rows.length === 0) throw new ImportFileError('This file has a header row but no data rows.');
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ImportFileError(`This file has ${rows.length.toLocaleString()} rows. The limit is ${MAX_IMPORT_ROWS.toLocaleString()} per import — split it into smaller files (they can all be imported, one after another).`);
  }
  return { headers, rows };
}

export function tableToCsv(headers: string[], rows: string[][]): string {
  const quote = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers, ...rows].map((r) => r.map(quote).join(',')).join('\n');
}

// ---------------------------------------------------------------- files

export function fileKind(name: string): 'csv' | 'xlsx' | 'xls' | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'xls') return 'xls';
  return null;
}

function readBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => { // older browsers / test environments
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

export async function readImportFile(file: File, options: { sheet?: string } = {}): Promise<ParsedTable> {
  const kind = fileKind(file.name);
  if (kind === 'xls') throw new ImportFileError('Old .xls files aren’t supported. In Excel choose File → Save As → “Excel Workbook (.xlsx)” or “CSV”, then upload that.');
  if (!kind) throw new ImportFileError('Upload a .csv, .tsv or .xlsx file.');
  if (file.size === 0) throw new ImportFileError('This file is empty.');
  if (file.size > MAX_FILE_BYTES) throw new ImportFileError(`This file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`);

  const buffer = await readBuffer(file);

  if (kind === 'csv') {
    const text = decodeText(buffer);
    const { headers, rows } = matrixToTable(parseDelimited(text, detectDelimiter(text)));
    return { fileName: file.name, fileType: 'csv', headers, rows, sheetNames: [], sheet: null };
  }

  try {
    const { default: readXlsxFile, readSheetNames } = await import('read-excel-file');
    const sheetNames = await readSheetNames(buffer);
    if (sheetNames.length === 0) throw new ImportFileError('This workbook has no sheets.');
    const sheet = options.sheet && sheetNames.includes(options.sheet) ? options.sheet : sheetNames[0];
    const raw = (await readXlsxFile(buffer, { sheet })) as unknown as unknown[][];
    const { headers, rows } = matrixToTable(raw.map((r) => r.map(cellToString)));
    return { fileName: file.name, fileType: 'xlsx', headers, rows, sheetNames, sheet };
  } catch (e) {
    if (e instanceof ImportFileError) throw e;
    throw new ImportFileError('Couldn’t read this Excel file. It may be password-protected or damaged — try saving it again as .xlsx or CSV.');
  }
}

// ---------------------------------------------------------------- export of failed rows

/** Prevents spreadsheet formula injection when users reopen the exported rows in Excel. */
const safeCell = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const quote = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** CSV of the rows that failed — same columns as the original file plus the reason, ready to fix and re-upload. */
export function rowErrorsToCsv(errors: { row_number: number; raw_row: Record<string, string>; error_message: string }[]): string {
  const columns: string[] = [];
  for (const e of errors) for (const key of Object.keys(e.raw_row ?? {})) if (!columns.includes(key) && columns.length < 120) columns.push(key);
  const header = [...columns, 'Import error', 'Original row'];
  const lines = errors.map((e) => [...columns.map((c) => safeCell(String(e.raw_row?.[c] ?? ''))), e.error_message, String(e.row_number)]);
  return [header, ...lines].map((r) => r.map(quote).join(',')).join('\n');
}

export function downloadTextFile(fileName: string, text: string, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
