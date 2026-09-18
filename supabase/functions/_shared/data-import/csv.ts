// supabase/functions/_shared/data-import/csv.ts
//
// Small, dependency-free CSV parser (RFC 4180-ish): handles quoted
// fields, commas/newlines inside quotes, and escaped "" quotes. No npm
// package needed — every competitor export is plain CSV, and pulling in
// a dependency for this would be overkill for an edge function.

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): ParsedCsv {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const records: string[][] = [];
  let field = "";
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

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      records.push(record);
      field = "";
      record = [];
    } else {
      field += char;
    }
  }

  // Flush the last field/record if the file doesn't end with a newline.
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = nonEmpty[0].map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => {
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (r[idx] ?? "").trim();
    });
    return row;
  });

  return { headers, rows };
}
