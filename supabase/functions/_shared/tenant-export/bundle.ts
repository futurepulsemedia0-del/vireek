// supabase/functions/_shared/tenant-export/bundle.ts
//
// Portable tenant data bundle ("vireek-export/1"): a plain POSIX tar of
//   manifest.json            { format, version, exportedAt, tables:[{name,file,rows,sha256,truncated}] }
//   <table>.ndjson           one JSON object per line, rows sorted by id, keys sorted (deterministic)
// Open formats only (tar + NDJSON + JSON). user_id is stripped on export and re-assigned on import,
// so a bundle is tenant-neutral. Pure code: no Deno, no I/O -> unit-tested round trip.

export const BUNDLE_FORMAT = "vireek-export/1";
export const MAX_ROWS_PER_TABLE = 100_000;
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

/** Dependency order = import order (parents first). Columns are never named by clients. */
export const TABLES = ["customers", "price_book_items", "jobs", "invoices", "calls", "audit_log"] as const;
export type TableName = (typeof TABLES)[number];
const SECRETISH = /^(password|secret|token|access_token|refresh_token|api_key|signing_secret)$/i;

export type Row = Record<string, unknown>;

export function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Row).sort().map((k) => [k, canonical((v as Row)[k])]));
  return v;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toExportRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) if (k !== "user_id" && !SECRETISH.test(k)) out[k] = v;
  return canonical(out) as Row;
}

export interface Manifest {
  format: string; exportedAt: string;
  tables: { name: TableName; file: string; rows: number; sha256: string; truncated: boolean }[];
}

export async function buildBundle(rows: Partial<Record<TableName, Row[]>>, exportedAt: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const manifest: Manifest = { format: BUNDLE_FORMAT, exportedAt, tables: [] };
  for (const name of TABLES) {
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

export type ParseResult = { ok: true; rows: Record<TableName, Row[]>; manifest: Manifest } | { ok: false; error: string };

export async function parseBundle(files: ReadonlyMap<string, string>): Promise<ParseResult> {
  const mRaw = files.get("manifest.json");
  if (!mRaw) return { ok: false, error: "manifest_missing" };
  let manifest: Manifest;
  try { manifest = JSON.parse(mRaw); } catch { return { ok: false, error: "manifest_invalid" }; }
  if (manifest.format !== BUNDLE_FORMAT || !Array.isArray(manifest.tables)) return { ok: false, error: "unsupported_format" };
  const rows = Object.fromEntries(TABLES.map((t) => [t, [] as Row[]])) as Record<TableName, Row[]>;
  for (const t of manifest.tables) {
    if (!(TABLES as readonly string[]).includes(t.name)) return { ok: false, error: `unknown_table:${String(t.name).slice(0, 40)}` };
    if (t.file !== `${t.name}.ndjson`) return { ok: false, error: `bad_file_name:${t.name}` };
    const body = files.get(t.file);
    if (body === undefined) return { ok: false, error: `file_missing:${t.name}` };
    if ((await sha256Hex(body)) !== t.sha256) return { ok: false, error: `checksum_mismatch:${t.name}` };
    const seen = new Set<string>();
    const lines = body.split("\n").filter((l) => l.length > 0);
    if (lines.length !== t.rows) return { ok: false, error: `row_count_mismatch:${t.name}` };
    if (lines.length > MAX_ROWS_PER_TABLE) return { ok: false, error: `too_many_rows:${t.name}` };
    for (const line of lines) {
      let r: Row;
      try { r = JSON.parse(line); } catch { return { ok: false, error: `invalid_json:${t.name}` }; }
      if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, error: `invalid_row:${t.name}` };
      if (typeof r.id !== "string" || !/^[0-9a-f-]{36}$/i.test(r.id)) return { ok: false, error: `invalid_id:${t.name}` };
      if (seen.has(r.id)) return { ok: false, error: `duplicate_id:${t.name}` };
      seen.add(r.id);
      if ("user_id" in r) return { ok: false, error: `user_id_not_allowed:${t.name}` };
      rows[t.name].push(r);
    }
  }
  return { ok: true, rows, manifest };
}

// ---------------------------------------------------------------- minimal ustar tar (open format)
const enc = new TextEncoder(), dec = new TextDecoder();
function octal(n: number, len: number): string { return n.toString(8).padStart(len - 1, "0") + "\0"; }

export function tarPack(files: ReadonlyMap<string, string>, mtime = 0): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [name, content] of files) {
    if (!/^[a-z0-9_.-]{1,99}$/i.test(name)) throw new Error("bad_name");
    const body = enc.encode(content);
    const h = new Uint8Array(512);
    const put = (s: string, off: number) => h.set(enc.encode(s), off);
    put(name, 0); put(octal(0o644, 8), 100); put(octal(0, 8), 108); put(octal(0, 8), 116);
    put(octal(body.length, 12), 124); put(octal(mtime, 12), 136); put("        ", 148); put("0", 156); put("ustar\0" + "00", 257);
    let sum = 0; for (const b of h) sum += b;
    put(octal(sum, 7).slice(0, 6) + "\0 ", 148);
    chunks.push(h, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function tarUnpack(buf: Uint8Array): Map<string, string> | null {
  if (buf.length > MAX_IMPORT_BYTES) return null;
  const files = new Map<string, string>();
  let o = 0;
  while (o + 512 <= buf.length) {
    const h = buf.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const name = dec.decode(h.subarray(0, 100)).replace(/\0.*$/, "");
    const size = parseInt(dec.decode(h.subarray(124, 136)).replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(h[156]);
    if (!/^[a-z0-9_.-]{1,99}$/i.test(name) || !Number.isFinite(size) || size < 0 || (type !== "0" && type !== "\0")) return null; // no paths, no links
    o += 512;
    if (o + size > buf.length) return null;
    if (files.has(name)) return null;
    files.set(name, dec.decode(buf.subarray(o, o + size)));
    o += Math.ceil(size / 512) * 512;
  }
  return files;
}
