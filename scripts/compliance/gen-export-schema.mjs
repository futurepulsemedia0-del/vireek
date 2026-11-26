#!/usr/bin/env node
// scripts/compliance/gen-export-schema.mjs
// Generates the public schema documentation of the tenant export from the SAME lists the export reads
// (TABLES in bundle.ts, SUPPLEMENTARY_TABLES in coverage.ts) and the column definitions in supabase/migrations:
//
//   docs/data-portability/SCHEMA.md            human-readable reference
//   public/data-promise/export-schema.json     machine-readable (linked from /data-promise)
//
//   node scripts/compliance/gen-export-schema.mjs --write   # regenerate both files
//   node scripts/compliance/gen-export-schema.mjs --check   # CI: fail if either file is out of date
//
// Limits (static, like export-coverage.mjs): columns come from CREATE TABLE bodies (one column per line) and single-line
// `ALTER TABLE ... ADD/DROP COLUMN` statements in migration order. Columns created by dynamic SQL or several per line are
// not seen. This documents what the MIGRATIONS define, not what a live database holds. [VERIFY against a real schema dump]
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, parseLists } from './export-coverage.mjs';

const MIG = 'supabase/migrations';
export const OUT_MD = 'docs/data-portability/SCHEMA.md';
export const OUT_JSON = 'public/data-promise/export-schema.json';
/** Same rule as toExportRow() in bundle.ts. Keep in step (asserted by portability.test.ts). */
export const SECRET_KEY_RE = /^(password|secret|token|access_token|refresh_token|api_key|signing_secret)$/i;

const NON_COLUMN = /^(primary|constraint|unique|check|foreign|exclude|like)\b/i;
const TYPE_STOP = /\b(not\s+null|null|default|references|check|primary|unique|generated|collate|constraint)\b/i;

/** Postgres type -> how the value appears in NDJSON. Documented in SCHEMA.md. */
export function jsonTypeFor(pg) {
  const t = pg.toLowerCase().replace(/\s+/g, ' ').trim();
  if (t.endsWith('[]')) return 'array';
  if (/^(uuid)$/.test(t)) return 'string (uuid)';
  if (/^(timestamptz|timestamp( with(out)? time zone)?)$/.test(t)) return 'string (ISO 8601)';
  if (/^date$/.test(t)) return 'string (YYYY-MM-DD)';
  if (/^(time|timetz)/.test(t)) return 'string (time)';
  if (/^(int|integer|smallint|bigint|serial|bigserial|int2|int4|int8)$/.test(t)) return 'number';
  if (/^(numeric|decimal|real|double precision|float\d?|money)/.test(t)) return 'number';
  if (/^(bool|boolean)$/.test(t)) return 'boolean';
  if (/^(jsonb?)$/.test(t)) return 'any JSON value';
  if (/^(text|varchar|char|character|citext)/.test(t)) return 'string';
  return 'string';
}

function parseColumnLine(line) {
  const l = line.replace(/--.*$/, '').trim().replace(/,$/, '');
  if (!l || NON_COLUMN.test(l)) return null;
  const m = /^"?([a-z_][a-z0-9_]*)"?\s+(.+)$/i.exec(l);
  if (!m) return null;
  const rest = m[2];
  const stop = TYPE_STOP.exec(rest);
  const type = (stop ? rest.slice(0, stop.index) : rest).trim().replace(/\s+/g, ' ');
  if (!type) return null;
  return { name: m[1].toLowerCase(), type, nullable: !/\bnot\s+null\b/i.test(rest) && !/\bprimary\s+key\b/i.test(rest) };
}

/** table -> Map(column -> {name,type,nullable}) in migration order. */
export function scanColumns(root = ROOT) {
  const dir = join(root, MIG);
  const tables = new Map();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql') && /^\d/.test(n)).sort()) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const events = [];
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\)\s*;/gi)) events.push({ at: m.index, kind: 'create', name: m[1].toLowerCase(), body: m[2] });
    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi)) events.push({ at: m.index, kind: 'drop', name: m[1].toLowerCase() });
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?(\w+)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([^;\n]+)/gi)) events.push({ at: m.index, kind: 'add', name: m[1].toLowerCase(), line: m[2] });
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?(\w+)"?\s+drop\s+column\s+(?:if\s+exists\s+)?"?(\w+)"?/gi)) events.push({ at: m.index, kind: 'dropcol', name: m[1].toLowerCase(), col: m[2].toLowerCase() });
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.kind === 'drop') { tables.delete(e.name); continue; }
      const cols = tables.get(e.name) ?? new Map();
      if (e.kind === 'create') {
        for (const line of e.body.split('\n')) { const c = parseColumnLine(line); if (c && !cols.has(c.name)) cols.set(c.name, c); }
        tables.set(e.name, cols);
      } else if (e.kind === 'add' && tables.has(e.name)) {
        const c = parseColumnLine(e.line); if (c) cols.set(c.name, c);
      } else if (e.kind === 'dropcol' && tables.has(e.name)) cols.delete(e.col);
    }
  }
  return tables;
}

export function buildSchema(root = ROOT) {
  const { core, supplement } = parseLists(root);
  const cols = scanColumns(root);
  const describe = (name, part) => {
    const c = cols.get(name);
    const columns = c ? [...c.values()] : [];
    return {
      name, part, importable: part === 'core', file: part === 'core' ? `${name}.ndjson` : `${name}.ndjson`,
      definedInMigrations: Boolean(c),
      columns: columns.filter((x) => x.name !== 'user_id' && !SECRET_KEY_RE.test(x.name)).map((x) => ({ name: x.name, type: x.type, json: jsonTypeFor(x.type), nullable: x.nullable })),
      omitted: columns.filter((x) => x.name === 'user_id' || SECRET_KEY_RE.test(x.name)).map((x) => x.name),
    };
  };
  return {
    note: 'Generated by scripts/compliance/gen-export-schema.mjs from supabase/migrations. Documents what the migrations define; it is not a dump of a live database.',
    formats: {
      core: { name: 'vireek-export/2', importable: true, layout: 'tar archive: manifest.json + one <table>.<seq>.ndjson per chunk' },
      supplement: { name: 'vireek-export-supplement/1', importable: false, layout: 'tar archive: manifest.json + one <table>.ndjson per table' },
    },
    tables: [...core.map((n) => describe(n, 'core')), ...supplement.map((n) => describe(n, 'supplement'))],
  };
}

export function renderMarkdown(schema) {
  const L = [
    '# Export schema reference', '',
    '> Generated file. Do not edit. Regenerate with `node scripts/compliance/gen-export-schema.mjs --write`.',
    `> ${schema.note}`, '',
    '## Formats', '',
    `- **Core** (\`${schema.formats.core.name}\`): ${schema.formats.core.layout}. Importable.`,
    `- **Supplement** (\`${schema.formats.supplement.name}\`): ${schema.formats.supplement.layout}. Export only, never accepted by import.`,
    '', 'Every file is UTF-8 NDJSON (one JSON object per line), rows sorted by `id`, object keys sorted alphabetically.',
    'The manifest lists each file with its row count and SHA-256. `user_id` and credential-like keys are removed from every row.', '',
    '## How values appear', '',
    '| Postgres type | JSON value |', '|---|---|',
    '| uuid | string |', '| timestamptz, timestamp | string, ISO 8601 |', '| date | string, YYYY-MM-DD |', '| integer, bigint, numeric, real | number |',
    '| boolean | boolean |', '| jsonb | any JSON value |', '| text, varchar | string |', '| arrays | JSON array |', '| NULL | null |', '',
    `## Tables (${schema.tables.length})`, '',
  ];
  for (const t of schema.tables) {
    L.push(`### ${t.name}`, '', `Part: ${t.part}${t.importable ? ' (importable)' : ' (export only)'} · file \`${t.file}\``, '');
    if (!t.definedInMigrations) { L.push('_No CREATE TABLE found in the migrations: columns unknown here._', ''); continue; }
    L.push('| Column | Type | JSON | Nullable |', '|---|---|---|---|');
    for (const c of t.columns) L.push(`| ${c.name} | ${c.type} | ${c.json} | ${c.nullable ? 'yes' : 'no'} |`);
    if (t.omitted.length) L.push('', `Not exported: ${t.omitted.join(', ')}`);
    L.push('');
  }
  return L.join('\n');
}

const outputs = (root) => { const s = buildSchema(root); return { md: renderMarkdown(s) + '\n', json: JSON.stringify(s, null, 2) + '\n' }; };

function main() {
  const args = new Set(process.argv.slice(2));
  const o = outputs(ROOT);
  if (args.has('--write')) {
    for (const [p, c] of [[OUT_MD, o.md], [OUT_JSON, o.json]]) { mkdirSync(dirname(join(ROOT, p)), { recursive: true }); writeFileSync(join(ROOT, p), c); }
    console.log(`wrote ${OUT_MD} and ${OUT_JSON}`);
    return;
  }
  const stale = [[OUT_MD, o.md], [OUT_JSON, o.json]].filter(([p, c]) => !existsSync(join(ROOT, p)) || readFileSync(join(ROOT, p), 'utf8') !== c).map(([p]) => p);
  if (stale.length) { console.error(`Out of date: ${stale.join(', ')}. Run: node scripts/compliance/gen-export-schema.mjs --write`); process.exit(1); }
  console.log('OK');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
