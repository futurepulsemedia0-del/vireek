/**
 * Spreadsheet-export primitives shared by every CSV/XLSX download.
 * Pure (no DOM) except `downloadBlob`.
 */

export type CsvValue = string | number | boolean | Date | null | undefined;

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * CSV/formula-injection guard (OWASP). A text cell that starts with = + - @ or
 * a control character is executed as a formula by Excel/Sheets, so it is
 * prefixed with an apostrophe. Real numbers are never touched — only strings —
 * so negative amounts stay numeric.
 */
export function neutralizeFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

export function csvCell(value: CsvValue, delimiter = ','): string {
  let s: string;
  if (value === null || value === undefined) s = '';
  else if (value instanceof Date) s = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  else if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') s = value ? 'true' : 'false';
  else s = neutralizeFormula(value);
  const needsQuote = s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(delimiter);
  return needsQuote ? `"${s.replace(/"/g, '""')}"` : s;
}

export const UTF8_BOM = '\uFEFF';

/** RFC 4180 CSV, CRLF line endings, UTF-8 BOM so Excel detects the encoding. */
export function buildCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvValue[])[],
  opts: { delimiter?: ',' | ';' | '\t'; bom?: boolean } = {},
): string {
  const d = opts.delimiter ?? ',';
  const lines = [headers.map((h) => csvCell(h, d)).join(d), ...rows.map((r) => r.map((c) => csvCell(c, d)).join(d))];
  return (opts.bom === false ? '' : UTF8_BOM) + lines.join('\r\n');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function slugify(input: string, max = 40): string {
  const s = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return WINDOWS_RESERVED.test(s) ? `${s}-file` : s;
}

/**
 * One naming scheme for every export: `{business}-{kind}-{YYYY-MM-DD}[-{detail}].{ext}`.
 * Safe on Windows/macOS/Linux (no separators, no reserved names, bounded length).
 */
export function exportFilename(opts: {
  kind: string;
  ext: 'csv' | 'xlsx' | 'pdf';
  business?: string | null;
  detail?: string | null;
  date?: Date;
}): string {
  const date = (opts.date ?? new Date()).toISOString().slice(0, 10);
  const parts = [slugify(opts.business ?? '') || 'vireek', slugify(opts.kind) || 'export', date];
  const detail = slugify(opts.detail ?? '', 30);
  if (detail) parts.push(detail);
  return `${parts.join('-')}.${opts.ext}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick: revoking synchronously cancels the download in some Safari versions.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
