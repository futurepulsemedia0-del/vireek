// Clipboard sanitizers + spreadsheet-style paste parsing. Pure functions.

import { cleanPasted, stripInvisible, toLatinDigits } from './text';

/** Phone: keeps digits and a leading "+", turns a leading "00" into "+". */
export function sanitizePhonePaste(text: string): string {
  const t = toLatinDigits(cleanPasted(text)).trim();
  const hasPlus = t.startsWith('+');
  const digits = t.replace(/\D/g, '');
  if (hasPlus) return `+${digits}`;
  return digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
}

/** One-time code: digits only, cut to `length`. Handles "123 456" and "123-456". */
export function sanitizeOtpPaste(text: string, length: number): string {
  return toLatinDigits(cleanPasted(text)).replace(/\D/g, '').slice(0, length);
}

/** Identifiers (license, policy, serial numbers): no whitespace or invisible chars, uppercased. */
export function sanitizeIdPaste(text: string): string {
  return stripInvisible(text.normalize('NFKC')).replace(/\s+/g, '').toUpperCase();
}

/** Parses TSV (Excel / Sheets) or CSV (comma or semicolon) clipboard text into a grid. */
export function parseTabular(text: string): string[][] {
  const src = text.replace(/\r\n?/g, '\n');
  const firstLine = src.split('\n', 1)[0] ?? '';
  let delimiter = ',';
  if (src.includes('\t')) delimiter = '\t';
  else if ((firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0)) delimiter = ';';

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (quoted) {
      if (ch === '"' && src.charAt(i + 1) === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

export interface CellPatch {
  row: number;
  col: number;
  value: string;
}

/**
 * Maps a pasted grid onto table cells starting at `start`.
 * Columns beyond `cols` are dropped; rows beyond `rows` are dropped unless `growRows` is set.
 * Returns [] for a single plain value so the caller can let the browser paste normally.
 */
export function tablePastePatches(
  grid: string[][],
  start: { row: number; col: number },
  bounds: { rows: number; cols: number; growRows?: boolean },
): CellPatch[] {
  const isSingle = grid.length === 1 && grid[0]?.length === 1;
  if (isSingle) return [];
  const patches: CellPatch[] = [];
  grid.forEach((cells, r) => {
    const row = start.row + r;
    if (!bounds.growRows && row >= bounds.rows) return;
    cells.forEach((value, c) => {
      const col = start.col + c;
      if (col < bounds.cols) patches.push({ row, col, value });
    });
  });
  return patches;
}
