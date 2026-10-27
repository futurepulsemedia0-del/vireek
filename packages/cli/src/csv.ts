/** Cells that spreadsheets would interpret as formulas (OWASP "CSV injection"). */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
/** Plain numbers such as "+15551234567" are safe even with a leading sign. */
const NUMERIC = /^[-+]?\d+([.,]\d+)?$/;

export function cellToString(value: unknown, guard: boolean): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    return guard && FORMULA_TRIGGER.test(value) && !NUMERIC.test(value) ? `'${value}` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

export function escapeCsv(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** One RFC 4180 record, CRLF-terminated. */
export function csvRecord(values: readonly unknown[], guard = true): string {
  return `${values.map((value) => escapeCsv(cellToString(value, guard))).join(',')}\r\n`;
}
