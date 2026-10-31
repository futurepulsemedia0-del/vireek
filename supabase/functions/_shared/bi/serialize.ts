// supabase/functions/_shared/bi/serialize.ts
//
// File formats for BI exports: RFC 4180 CSV and NDJSON, optional gzip, SHA-256 checksums.
// Pure: WebCrypto + CompressionStream (Deno, browsers, Node 20+).

import type { ColumnType } from "../data-platform/catalog.ts";

export interface FileColumn { name: string; type: ColumnType }
export type FileFormat = "csv" | "ndjson";
export const FILE_FORMATS: readonly FileFormat[] = ["csv", "ndjson"];

const enc = new TextEncoder();

/**
 * Spreadsheet formula-injection guard. A text cell that starts with = @ TAB CR, or with +/- followed by
 * anything other than a plain number or phone-like string, would be executed by Excel / Sheets.
 * Phone numbers such as "+15551234567" and negative numbers are left untouched.
 */
export function isFormulaLike(s: string): boolean {
  if (!s) return false;
  const c = s[0];
  if (c === "=" || c === "@" || c === "\t" || c === "\r") return true;
  if (c === "+" || c === "-") return !/^[+-][\d\s().,-]+$/.test(s);
  return false;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  let isText = false;
  if (typeof value === "string") {
    s = value;
    isText = true;
  } else if (typeof value === "object") {
    s = JSON.stringify(value);
    isText = true;
  } else s = String(value);
  if (isText && isFormulaLike(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: readonly FileColumn[], rows: readonly Record<string, unknown>[]): string {
  const lines = [columns.map((c) => csvCell(c.name)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c.name])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function toNdjson(columns: readonly FileColumn[], rows: readonly Record<string, unknown>[]): string {
  let out = "";
  for (const row of rows) {
    const o: Record<string, unknown> = {};
    for (const c of columns) o[c.name] = row[c.name] ?? null;
    out += JSON.stringify(o) + "\n";
  }
  return out;
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface EncodedFile { bytes: Uint8Array; contentType: string; extension: string }

export async function encodeFile(format: FileFormat, compress: boolean, columns: readonly FileColumn[], rows: readonly Record<string, unknown>[]): Promise<EncodedFile> {
  const text = format === "csv" ? toCsv(columns, rows) : toNdjson(columns, rows);
  const raw = enc.encode(text);
  const base = format === "csv" ? { contentType: "text/csv; charset=utf-8", extension: "csv" } : { contentType: "application/x-ndjson", extension: "ndjson" };
  return compress ? { bytes: await gzip(raw), contentType: "application/gzip", extension: `${base.extension}.gz` } : { bytes: raw, ...base };
}
