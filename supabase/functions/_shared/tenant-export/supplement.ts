// supabase/functions/_shared/tenant-export/supplement.ts
//
// "vireek-export-supplement/1": the export-only second part of a tenant export (see coverage.ts).
// Same open layout as the core bundle (tar of manifest.json + <table>.ndjson, sorted ids and keys,
// user_id and secret-looking columns stripped, per-file sha256), with two differences that keep it safe:
//   * a distinct format string, so tenant-import / parseBundle reject it;
//   * `importable: false` and a `skipped` list for tables not present in a given deployment.
// Pure code: no Deno, no I/O.

import { MAX_ROWS_PER_TABLE, sha256Hex, toExportRow, type Row } from "./bundle.ts";
import { SUPPLEMENTARY_TABLES, type SupplementaryTable } from "./coverage.ts";

export const SUPPLEMENT_FORMAT = "vireek-export-supplement/1";

export interface SupplementManifest {
  format: typeof SUPPLEMENT_FORMAT;
  importable: false;
  exportedAt: string;
  tables: { name: SupplementaryTable; file: string; rows: number; sha256: string; truncated: boolean }[];
  skipped: { name: SupplementaryTable; reason: "table_missing" }[];
}

export async function buildSupplementBundle(
  rows: Partial<Record<SupplementaryTable, Row[]>>,
  exportedAt: string,
  skipped: ReadonlyArray<SupplementaryTable> = [],
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const skip = new Set<SupplementaryTable>(skipped);
  const manifest: SupplementManifest = { format: SUPPLEMENT_FORMAT, importable: false, exportedAt, tables: [], skipped: [] };
  for (const name of SUPPLEMENTARY_TABLES) {
    if (skip.has(name)) { manifest.skipped.push({ name, reason: "table_missing" }); continue; }
    const all = (rows[name] ?? []).map(toExportRow).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const truncated = all.length > MAX_ROWS_PER_TABLE;
    const kept = truncated ? all.slice(0, MAX_ROWS_PER_TABLE) : all;
    const body = kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : "");
    files.set(`${name}.ndjson`, body);
    manifest.tables.push({ name, file: `${name}.ndjson`, rows: kept.length, sha256: await sha256Hex(body), truncated });
  }
  files.set("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return files;
}

/** True when an error means "this table does not exist here" (migration not applied) rather than a real failure. */
export function isMissingTableError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "42P01" || err.code === "PGRST205" || /does not exist|could not find the table/i.test(err.message ?? "");
}
