type CsvValue = string | number | boolean | null | undefined;

export interface CsvColumn<T> {
  header: string;
  accessor: (row: T) => CsvValue;
}

function escapeCsvCell(value: CsvValue): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Exports rows to a downloaded .csv file.
 * - Prefixes a UTF-8 BOM so Excel renders non-Latin scripts (Arabic,
 *   Farsi, Chinese, Hindi, Japanese) correctly instead of as garbled text.
 * - Escapes commas/quotes/newlines per RFC 4180.
 */
export function exportToCsv<T>(rows: T[], columns: CsvColumn<T>[], filename: string): void {
  const header = columns.map((c) => escapeCsvCell(c.header)).join(',');
  const lines = rows.map((row) => columns.map((c) => escapeCsvCell(c.accessor(row))).join(','));
  const csv = [header, ...lines].join('\r\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
