export interface ParsedCsvPreview {
  headers: string[];
  previewRows: Record<string, string>[];
  totalRowCount: number;
}

/** Same quoting rules as the edge function's parser — kept in sync intentionally so the preview matches what the server will actually do. */
export function parseCsv(text: string, maxPreviewRows = 5): ParsedCsvPreview {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field);
      records.push(record);
      field = '';
      record = [];
    } else field += char;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => r.some((cell) => cell.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], previewRows: [], totalRowCount: 0 };

  const headers = nonEmpty[0].map((h) => h.trim());
  const dataRecords = nonEmpty.slice(1);
  const previewRows = dataRecords.slice(0, maxPreviewRows).map((r) => {
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => (row[h] = (r[idx] ?? '').trim()));
    return row;
  });

  return { headers, previewRows, totalRowCount: dataRecords.length };
}
