#!/usr/bin/env node
// scripts/pricing/normalize-survey-export.mjs
//
// Turns a raw survey-tool export into the analysis-ready CSV that van-westendorp.mjs expects:
// keeps only the mapped columns (everything else, which may hold personal data, is dropped), renames
// them, and converts locale-formatted prices ("1.234,50", "EUR 12,5") to plain dot decimals.
// It never guesses: the decimal mark and thousands mark are declared on the command line, and a cell
// that does not match them exactly is left untouched so the analysis reports it as an exclusion.
// No row is ever dropped here. Comment lines (including a SYNTHETIC marker) are preserved.
//
// Usage:
//   node scripts/pricing/normalize-survey-export.mjs <export.csv> --map "Q1=too_cheap,Q2=cheap,Q3=expensive,Q4=too_expensive[,ID=respondent_id][,Group=segment]"
//        --decimal dot|comma [--thousands none|dot|comma|space|apostrophe] [--strip "EUR,€"]
//        [--out FILE [--force]]
//
// Input : CSV with a header row; '#' lines at column 0 are comments.
// Output: normalized CSV on stdout (or --out FILE); a change summary on stderr.
// Auth/network: none. Reads one local file; writes at most one file, never over the input.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MAX_INPUT_BYTES, PRICE_COLUMNS, parseCsv } from './van-westendorp.mjs';

export const TARGETS = ['respondent_id', 'segment', ...PRICE_COLUMNS];
const DECIMALS = { dot: '.', comma: ',' };
const THOUSANDS = { none: null, dot: '.', comma: ',', space: ' ', apostrophe: "'" };

const USAGE = `Usage: node scripts/pricing/normalize-survey-export.mjs <export.csv> --map "SRC=target,..." --decimal dot|comma [options]

Targets: ${TARGETS.join(', ')} (the four price targets are required)

Options:
  --map "SRC=target,..."   which export column becomes which target column (required)
  --decimal dot|comma      decimal mark used in the export's prices (required)
  --thousands MARK         none (default) | dot | comma | space | apostrophe
  --strip "TOK,TOK"        exact currency tokens to remove from price cells (e.g. "EUR,€"); none by default
  --out FILE               write the CSV to FILE instead of stdout (refuses to overwrite without --force)
  --force                  allow --out to replace an existing file
  -h, --help               show this help
`;

/** Parse "SRC=target,SRC2=target2" into [{source, target}], validating targets and duplicates. */
export function parseMapping(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') throw new Error('--map is required');
  const pairs = spec.split(',').map((part) => {
    const at = part.lastIndexOf('=');
    if (at <= 0) throw new Error(`Bad --map entry "${part}"; expected SOURCE=target`);
    return { source: part.slice(0, at).trim(), target: part.slice(at + 1).trim() };
  });
  for (const { source, target } of pairs) {
    if (source === '') throw new Error('--map has an empty source column name');
    if (!TARGETS.includes(target)) {
      throw new Error(`Unknown target "${target}"; allowed: ${TARGETS.join(', ')}`);
    }
  }
  const dupTarget = pairs.find((p, i) => pairs.findIndex((q) => q.target === p.target) !== i);
  if (dupTarget) throw new Error(`Target mapped twice: ${dupTarget.target}`);
  const dupSource = pairs.find((p, i) => pairs.findIndex((q) => q.source === p.source) !== i);
  if (dupSource) throw new Error(`Source column mapped twice: ${dupSource.source}`);
  const missing = PRICE_COLUMNS.filter((c) => !pairs.some((p) => p.target === c));
  if (missing.length > 0) throw new Error(`--map must cover: ${missing.join(', ')}`);
  return pairs;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normalize one price cell. Returns {value, status}: 'unchanged' (already plain), 'changed'
 * (converted), or 'unparsed' (does not match the declared format; value is returned as given).
 */
export function normalizeNumber(raw, { decimal, thousands = 'none', strip = [] }) {
  const original = String(raw);
  let t = original;
  for (const token of strip) t = t.split(token).join('');
  t = t.trim();
  if (t === '') return { value: original, status: 'unchanged' };

  const decimalChar = DECIMALS[decimal];
  const sepChar = THOUSANDS[thousands];
  const sepRe = thousands === 'space' ? '[ \\u00A0\\u202F]' : sepChar ? escapeRe(sepChar) : null;
  const intPart = sepRe ? `(?:\\d{1,3}(?:${sepRe}\\d{3})+|\\d+)` : '\\d+';
  const match = new RegExp(`^(-?)(${intPart})(?:${escapeRe(decimalChar)}(\\d+))?$`).exec(t);
  if (!match) return { value: original, status: 'unparsed' };

  const [, sign, int, frac] = match;
  const digits = sepRe ? int.replace(new RegExp(sepRe, 'g'), '') : int;
  const value = `${sign}${digits}${frac !== undefined ? `.${frac}` : ''}`;
  return { value, status: value === original ? 'unchanged' : 'changed' };
}

/** CSV cell quoting for machine consumption (no formula guard: values must stay numeric). */
const quote = (v) => {
  const s = String(v);
  return /[",\n\r]/.test(s) || s.startsWith('#') || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Normalize a whole export. Returns {csv, summary}. Throws on unusable input or mapping. */
export function normalizeTable(text, options) {
  const { mapping, decimal, thousands = 'none', strip = [] } = options;
  if (!(decimal in DECIMALS)) throw new Error('--decimal must be "dot" or "comma"');
  if (!(thousands in THOUSANDS)) {
    throw new Error('--thousands must be none, dot, comma, space or apostrophe');
  }
  if (THOUSANDS[thousands] === DECIMALS[decimal]) {
    throw new Error('--thousands and --decimal cannot be the same mark');
  }
  for (const token of strip) {
    if (token === '' || /[\d.,\-']/.test(token)) {
      throw new Error(`--strip token "${token}" must be non-empty and contain no digits or separators`);
    }
  }

  const { rows, comments } = parseCsv(text);
  if (rows.length === 0) throw new Error('CSV has no header row');
  const header = rows[0].map((h) => h.trim());
  const index = new Map();
  for (const { source, target } of mapping) {
    const i = header.indexOf(source);
    if (i === -1) throw new Error(`Source column not found: ${source}`);
    index.set(target, i);
  }
  const outTargets = TARGETS.filter((t) => index.has(t));
  const mappedSources = new Set(mapping.map((m) => m.source));
  const dropped = header.filter((h) => !mappedSources.has(h));

  const perColumn = Object.fromEntries(PRICE_COLUMNS.map((c) => [c, { changed: 0, unparsed: 0 }]));
  let malformed = 0;
  const lines = [`# normalized by scripts/pricing/normalize-survey-export.mjs (decimal=${decimal}, thousands=${thousands})`];
  for (const c of comments) lines.push(`# ${c}`);
  lines.push(outTargets.map(quote).join(','));

  for (const cells of rows.slice(1)) {
    const out = outTargets.map((target) => {
      const raw = cells[index.get(target)] ?? '';
      if (!PRICE_COLUMNS.includes(target)) return raw.trim();
      const res = normalizeNumber(raw, { decimal, thousands, strip });
      if (res.status === 'changed') perColumn[target].changed += 1;
      if (res.status === 'unparsed') perColumn[target].unparsed += 1;
      return res.value;
    });
    if (cells.length !== header.length) {
      // Keep the row but make its width wrong on purpose, so the analysis reports it as malformed_row.
      malformed += 1;
      out.push('');
    }
    lines.push(out.map(quote).join(','));
  }

  return {
    csv: `${lines.join('\n')}\n`,
    summary: { rows: rows.length - 1, malformed_rows: malformed, dropped_columns: dropped, columns: perColumn },
  };
}

const summaryText = (s) =>
  [
    `rows: ${s.rows}${s.malformed_rows ? ` (${s.malformed_rows} with the wrong number of cells, kept as malformed)` : ''}`,
    `dropped columns: ${s.dropped_columns.length ? s.dropped_columns.join(', ') : '(none)'}`,
    ...Object.entries(s.columns).map(
      ([c, v]) => `${c}: converted ${v.changed}, left unparsed ${v.unparsed}${v.unparsed ? ' (will be excluded by the analysis)' : ''}`,
    ),
  ]
    .map((l) => `${l}\n`)
    .join('');

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        map: { type: 'string' },
        decimal: { type: 'string' },
        thousands: { type: 'string', default: 'none' },
        strip: { type: 'string' },
        out: { type: 'string' },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.err(`Error: ${e.message}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    io.err(`Error: expected exactly one CSV file path\n\n${USAGE}`);
    return 1;
  }
  try {
    if (values.decimal === undefined) throw new Error('--decimal is required (dot or comma)');
    const input = positionals[0];
    if (values.out && path.resolve(values.out) === path.resolve(input)) {
      throw new Error('--out must not be the input file');
    }
    if (values.out && existsSync(values.out) && !values.force) {
      throw new Error(`${values.out} already exists; pass --force to replace it`);
    }
    if (statSync(input).size > MAX_INPUT_BYTES) {
      throw new Error(`Input is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB`);
    }
    const { csv, summary } = normalizeTable(readFileSync(input, 'utf8'), {
      mapping: parseMapping(values.map),
      decimal: values.decimal,
      thousands: values.thousands,
      strip: values.strip ? values.strip.split(',').map((t) => t.trim()) : [],
    });
    if (values.out) writeFileSync(values.out, csv);
    else io.out(csv);
    io.err(summaryText(summary));
    if (values.out) io.err(`wrote ${values.out}\n`);
    return 0;
  } catch (e) {
    io.err(`Error: ${e.code === 'ENOENT' ? `file not found: ${positionals[0]}` : e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
