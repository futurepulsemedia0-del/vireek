// supabase/functions/_shared/import-framework/adapters/csv.ts
//
// Reference SourceAdapter: one CSV text per entity (e.g. customers.csv, jobs.csv). Reuses the repo's
// dependency-free parser. Cursor = zero-based index of the next data row. `position` = spreadsheet row
// number (header = 1) counted over NON-EMPTY rows (the parser drops fully blank lines).

import { parseCsv } from "../../data-import/csv.ts";
import { fingerprint } from "../hash.ts";
import { ImportError } from "../types.ts";
import type { SourceAdapter, SourcePage } from "../types.ts";

export const CSV_ADAPTER_ID = "csv";
export const CSV_ADAPTER_VERSION = "1";
export const CSV_MAX_CHARS_PER_FILE = 12_000_000;
export const CSV_MAX_ROWS_PER_FILE = 200_000;

export function createCsvAdapter(files: Record<string, string>): SourceAdapter {
  const parsed = new Map<string, ReturnType<typeof parseCsv>>();
  const prints: string[] = [];
  for (const entity of Object.keys(files).sort()) {
    let textIn = files[entity];
    if (typeof textIn !== "string") throw new ImportError("SOURCE_INVALID", `CSV for "${entity}" must be text.`);
    if (textIn.length > CSV_MAX_CHARS_PER_FILE) throw new ImportError("SOURCE_INVALID", `CSV for "${entity}" is too large.`);
    if (textIn.charCodeAt(0) === 0xfeff) textIn = textIn.slice(1); // Excel "UTF-8 with BOM"
    const p = parseCsv(textIn);
    if (p.headers.length === 0) throw new ImportError("SOURCE_INVALID", `CSV for "${entity}" has no header row.`);
    if (new Set(p.headers).size !== p.headers.length) throw new ImportError("SOURCE_INVALID", `CSV for "${entity}" has duplicate column names.`);
    if (p.headers.some((h) => h === "")) throw new ImportError("SOURCE_INVALID", `CSV for "${entity}" has an unnamed column.`);
    if (p.rows.length > CSV_MAX_ROWS_PER_FILE) throw new ImportError("SOURCE_INVALID", `CSV for "${entity}" has more than ${CSV_MAX_ROWS_PER_FILE} rows.`);
    parsed.set(entity, p);
    prints.push(`${entity}:${p.rows.length}:${fingerprint(textIn)}`);
  }
  const snapshot = fingerprint(`${CSV_ADAPTER_ID}|${CSV_ADAPTER_VERSION}|${prints.join("|")}`);
  const get = (entity: string) => {
    const p = parsed.get(entity);
    if (!p) throw new ImportError("SOURCE_INVALID", `The source has no "${entity}" file.`);
    return p;
  };
  return {
    id: CSV_ADAPTER_ID,
    version: CSV_ADAPTER_VERSION,
    entities: () => [...parsed.keys()].sort(),
    columns: (entity) => get(entity).headers,
    fingerprint: () => snapshot,
    read(entity, cursor, limit): Promise<SourcePage> {
      const p = get(entity);
      let start = 0;
      if (cursor !== null) {
        if (!/^\d{1,9}$/.test(cursor)) throw new ImportError("SOURCE_INVALID", "Bad cursor.");
        start = Number(cursor);
        if (start > p.rows.length) throw new ImportError("SOURCE_INVALID", "Cursor is past the end of the file.");
      }
      const end = Math.min(start + Math.max(1, limit), p.rows.length);
      const records = p.rows.slice(start, end).map((data, i) => ({ position: start + i + 2, data }));
      return Promise.resolve({ records, nextCursor: end < p.rows.length ? String(end) : null });
    },
  };
}
