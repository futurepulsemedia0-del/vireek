#!/usr/bin/env node
// scripts/pricing/van-westendorp.mjs
//
// Van Westendorp Price Sensitivity Meter (PSM) analysis of a survey CSV. DESCRIPTIVE ONLY: it
// computes the four cumulative curves, their intersections and optional bootstrap intervals for the
// file you give it. It never recommends a price. Design, sampling and limits: docs/pricing/wtp-study.md
//
// Usage:
//   node scripts/pricing/van-westendorp.mjs <survey.csv> [--out-dir DIR] [--format text|json]
//        [--segment-column NAME] [--min-n 100] [--bootstrap 0] [--seed 1] [--strict-order]
//        [--exclude-straight-lining] [--currency EUR]
//
// Input : CSV with columns too_cheap, cheap, expensive, too_expensive (dot decimals, no currency
//         symbols) plus optional respondent_id and segment. Lines starting with '#' are comments;
//         a comment containing the word SYNTHETIC or FAKE marks the file as test data.
// Output: text summary on stdout (or JSON with --format json). With --out-dir it also writes
//         van-westendorp.report.json, van-westendorp.curves.csv and one SVG chart per group.
// Auth/network: none. Reads one local file; writes only inside --out-dir.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const SCHEMA = 'vireek.pricing.van-westendorp/1';
export const PRICE_COLUMNS = ['too_cheap', 'cheap', 'expensive', 'too_expensive'];
export const HARD_MIN_N = 10;
export const DEFAULT_MIN_N = 100;
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_PRICE = 1e9;
export const UNSPECIFIED_SEGMENT = '(unspecified)';
export const DISCLAIMER =
  'Descriptive output of the supplied file only. It is not a price recommendation, demand estimate ' +
  'or forecast. Survey prices are stated, hypothetical and depend entirely on who was sampled.';

const EPS = 1e-12;
const DETAIL_LIMIT = 50;
const COLUMN_ALIASES = { bargain: 'cheap', getting_expensive: 'expensive', id: 'respondent_id' };

const USAGE = `Usage: node scripts/pricing/van-westendorp.mjs <survey.csv> [options]

Options:
  --out-dir DIR          also write report.json, curves.csv and one SVG per group into DIR
  --format text|json     stdout format (default: text)
  --segment-column NAME  column that defines segments (default: "segment", optional)
  --min-n N              warn when a group has fewer than N valid respondents (default: ${DEFAULT_MIN_N})
  --bootstrap N          percentile-bootstrap resamples for 95% intervals, 0-10000 (default: 0 = off)
  --seed N               bootstrap seed, makes runs reproducible (default: 1)
  --strict-order         require too_cheap < cheap < expensive < too_expensive (default allows ties)
  --exclude-straight-lining  exclude respondents who gave the same price in all four fields
  --currency CODE        three-letter label for output only (no conversion is ever done)
  -h, --help             show this help
`;

// ---------------------------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------------------------

/** Minimal RFC-4180-style parser: quotes, escaped quotes, CRLF, BOM, '#' comment lines at column 0. */
export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  const comments = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let atRecordStart = true;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0].trim() === '')) rows.push(row);
    row = [];
    atRecordStart = true;
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (atRecordStart && ch === '#') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      comments.push(src.slice(i + 1, end).replace(/\r$/, '').trim());
      i = end + 1;
      continue;
    }
    atRecordStart = false;
    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endRow();
    } else if (ch !== '\r') {
      field += ch;
    }
    i += 1;
  }
  if (inQuotes) throw new Error('Unterminated quoted field in CSV');
  if (field !== '' || row.length > 0) endRow();
  return { rows, comments };
}

/** Strict price parser: plain non-negative decimal with a dot. Returns {value} or {error}. */
export function parsePrice(raw) {
  if (raw === undefined || raw === null) return { error: 'missing_value' };
  const t = String(raw).trim();
  if (t === '') return { error: 'missing_value' };
  if (/^-\d/.test(t)) return { error: 'negative_value' };
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(t)) return { error: 'non_numeric' };
  const value = Number(t);
  if (!Number.isFinite(value) || value > MAX_PRICE) return { error: 'out_of_range' };
  return { value };
}

const normalizeHeader = (h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');

/**
 * Parse and validate survey rows. Invalid rows are excluded and counted, never silently repaired.
 * `row` in exclusions is the 1-based data record number (header excluded).
 */
export function loadSurvey(text, options = {}) {
  const { rows, comments } = parseCsv(text);
  if (rows.length === 0) throw new Error('CSV has no header row');

  const header = rows[0].map((h) => {
    const n = normalizeHeader(h);
    return COLUMN_ALIASES[n] ?? n;
  });
  const duplicate = header.find((h, idx) => h !== '' && header.indexOf(h) !== idx);
  if (duplicate) throw new Error(`Duplicate column: ${duplicate}`);
  const missing = PRICE_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) throw new Error(`Missing required column(s): ${missing.join(', ')}`);

  const segmentName = normalizeHeader(options.segmentColumn ?? 'segment');
  if (PRICE_COLUMNS.includes(segmentName)) {
    throw new Error(`Segment column cannot be a price column: ${segmentName}`);
  }
  const segIdx = header.indexOf(segmentName);
  if (options.segmentColumn != null && segIdx === -1) {
    throw new Error(`Segment column not found: ${options.segmentColumn}`);
  }
  const idIdx = header.indexOf('respondent_id');
  const col = Object.fromEntries(PRICE_COLUMNS.map((c) => [c, header.indexOf(c)]));

  const seenIds = new Set();
  const records = [];
  const exclusions = [];

  rows.slice(1).forEach((cells, k) => {
    const row = k + 1;
    const id = idIdx >= 0 ? (cells[idIdx] ?? '').trim() : '';
    const exclude = (reason) => exclusions.push({ row, respondent_id: id || null, reason });

    if (cells.length !== header.length) return exclude('malformed_row');
    const vals = {};
    for (const c of PRICE_COLUMNS) {
      const parsed = parsePrice(cells[col[c]]);
      if (parsed.error) return exclude(parsed.error);
      vals[c] = parsed.value;
    }
    if (id !== '') {
      if (seenIds.has(id)) return exclude('duplicate_respondent_id');
      seenIds.add(id);
    }
    const ordered = PRICE_COLUMNS.map((c) => vals[c]);
    if (options.excludeStraightLining && ordered.every((v) => v === ordered[0])) {
      return exclude('straight_lining');
    }
    const inOrder = ordered.every(
      (v, idx) => idx === 0 || (options.strictOrder ? ordered[idx - 1] < v : ordered[idx - 1] <= v),
    );
    if (!inOrder) return exclude('order_violation');

    records.push({
      row,
      id: id || null,
      segment: segIdx >= 0 ? (cells[segIdx] ?? '').trim() || UNSPECIFIED_SEGMENT : null,
      tooCheap: vals.too_cheap,
      cheap: vals.cheap,
      expensive: vals.expensive,
      tooExpensive: vals.too_expensive,
    });
  });

  return {
    records,
    exclusions,
    comments,
    synthetic: comments.some((c) => /\b(synthetic|fake)\b/i.test(c)),
    hasSegments: segIdx >= 0,
    totalRows: rows.length - 1,
  };
}

// ---------------------------------------------------------------------------------------------
// Curves and intersections
// ---------------------------------------------------------------------------------------------

const lowerBound = (a, x) => {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
const upperBound = (a, x) => {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
const sortedColumn = (records, key) => Float64Array.from(records, (r) => r[key]).sort();

/**
 * Cumulative curves on the grid of every observed price (fractions 0..1):
 *   tooCheap(p)     = share who said "too cheap" at a price >= p      (falling)
 *   cheap(p)        = share who said "bargain" at a price >= p        (falling)
 *   expensive(p)    = share who said "getting expensive" at <= p      (rising)
 *   tooExpensive(p) = share who said "too expensive" at <= p          (rising)
 *   notCheap = 1 - cheap (rising), notExpensive = 1 - expensive (falling)
 */
export function computeCurves(records) {
  const n = records.length;
  const empty = {
    price: [],
    tooCheap: [],
    cheap: [],
    notCheap: [],
    expensive: [],
    notExpensive: [],
    tooExpensive: [],
  };
  if (n === 0) return empty;

  const tc = sortedColumn(records, 'tooCheap');
  const ch = sortedColumn(records, 'cheap');
  const ex = sortedColumn(records, 'expensive');
  const te = sortedColumn(records, 'tooExpensive');
  const price = [
    ...new Set(records.flatMap((r) => [r.tooCheap, r.cheap, r.expensive, r.tooExpensive])),
  ].sort((a, b) => a - b);

  const tooCheap = price.map((p) => (n - lowerBound(tc, p)) / n);
  const cheap = price.map((p) => (n - lowerBound(ch, p)) / n);
  const expensive = price.map((p) => upperBound(ex, p) / n);
  const tooExpensive = price.map((p) => upperBound(te, p) / n);
  return {
    price,
    tooCheap,
    cheap,
    notCheap: cheap.map((v) => 1 - v),
    expensive,
    notExpensive: expensive.map((v) => 1 - v),
    tooExpensive,
  };
}

/**
 * Crossing of a non-increasing curve `desc` and a non-decreasing curve `asc` over `prices`.
 * Linear interpolation between grid points; if the curves coincide over an interval the midpoint of
 * that interval is returned. Returns {price, share} or null when they do not cross inside the grid.
 */
export function findCrossing(prices, desc, asc) {
  const n = prices.length;
  const d = (i) => desc[i] - asc[i];
  for (let i = 0; i < n; i += 1) {
    const di = d(i);
    if (di > EPS) continue;
    if (Math.abs(di) <= EPS) {
      let j = i;
      while (j + 1 < n && Math.abs(d(j + 1)) <= EPS) j += 1;
      return { price: (prices[i] + prices[j]) / 2, share: (desc[i] + desc[j]) / 2 };
    }
    if (i === 0) return null;
    const prev = d(i - 1);
    const t = prev / (prev - di);
    return {
      price: prices[i - 1] + t * (prices[i] - prices[i - 1]),
      share: desc[i - 1] + t * (desc[i] - desc[i - 1]),
    };
  }
  return null;
}

/**
 * PMC = too cheap x not cheap, OPP = too cheap x too expensive, IPP = cheap x expensive,
 * PME = not expensive x too expensive. Conventions differ between texts; see the study doc [VERIFY].
 */
export function computePoints(curves) {
  const { price } = curves;
  return {
    PMC: findCrossing(price, curves.tooCheap, curves.notCheap),
    OPP: findCrossing(price, curves.tooCheap, curves.tooExpensive),
    IPP: findCrossing(price, curves.cheap, curves.expensive),
    PME: findCrossing(price, curves.notExpensive, curves.tooExpensive),
  };
}

// ---------------------------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------------------------

/** Small seeded PRNG (mulberry32) so bootstrap output is reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated quantile of an ascending array; null for an empty array. */
export function quantile(sortedAsc, q) {
  if (sortedAsc.length === 0) return null;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

const round6 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e6) / 1e6);

/** Percentile bootstrap of the four intersection prices (resampling respondents with replacement). */
export function bootstrapPoints(records, { iterations, seed = 1, level = 0.95 }) {
  const rand = mulberry32(seed);
  const n = records.length;
  const prices = { PMC: [], OPP: [], IPP: [], PME: [] };
  for (let it = 0; it < iterations; it += 1) {
    const sample = new Array(n);
    for (let i = 0; i < n; i += 1) sample[i] = records[Math.floor(rand() * n)];
    const pts = computePoints(computeCurves(sample));
    for (const key of Object.keys(prices)) if (pts[key]) prices[key].push(pts[key].price);
  }
  const tail = (1 - level) / 2;
  const intervals = {};
  for (const [key, arr] of Object.entries(prices)) {
    arr.sort((a, b) => a - b);
    intervals[key] = {
      low: round6(quantile(arr, tail)),
      high: round6(quantile(arr, 1 - tail)),
      defined: arr.length,
    };
  }
  return { method: 'percentile', iterations, seed, level, intervals };
}

// ---------------------------------------------------------------------------------------------
// Groups and report
// ---------------------------------------------------------------------------------------------

const roundCurves = (curves) =>
  Object.fromEntries(Object.entries(curves).map(([k, arr]) => [k, arr.map(round6)]));
const roundPoint = (p) => (p ? { price: round6(p.price), share: round6(p.share) } : null);

export function analyzeGroup(
  name,
  records,
  { minN = DEFAULT_MIN_N, bootstrap = 0, seed = 1, kind = 'overall' } = {},
) {
  const n = records.length;
  if (n < HARD_MIN_N) {
    return {
      name,
      kind,
      n,
      status: 'insufficient_sample',
      warnings: [`n=${n} is below the hard minimum of ${HARD_MIN_N}; no curves were computed`],
      points: null,
      range: null,
      bootstrap: null,
      curves: null,
    };
  }
  const warnings = [];
  if (n < minN) {
    warnings.push(`n=${n} is below the recommended minimum of ${minN}; treat every number as unstable`);
  }
  const curves = computeCurves(records);
  const raw = computePoints(curves);
  for (const [key, point] of Object.entries(raw)) {
    if (!point) warnings.push(`${key} is undefined: its curves do not cross inside the observed price range`);
  }
  let range = null;
  if (raw.PMC && raw.PME) {
    if (raw.PMC.price > raw.PME.price) {
      warnings.push('PMC is above PME: the acceptable range is inverted, so the data give no usable range');
    } else {
      range = { low: round6(raw.PMC.price), high: round6(raw.PME.price) };
    }
  }
  return {
    name,
    kind,
    n,
    status: 'ok',
    warnings,
    points: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, roundPoint(v)])),
    range,
    bootstrap: bootstrap > 0 ? bootstrapPoints(records, { iterations: bootstrap, seed }) : null,
    curves: roundCurves(curves),
  };
}

export function buildReport(text, options = {}) {
  const {
    sourceName = 'input.csv',
    minN = DEFAULT_MIN_N,
    bootstrap = 0,
    seed = 1,
    strictOrder = false,
    excludeStraightLining = false,
    segmentColumn,
    currency = null,
  } = options;
  const survey = loadSurvey(text, { segmentColumn, strictOrder, excludeStraightLining });
  const groupOptions = { minN, bootstrap, seed };

  const groups = [analyzeGroup('overall', survey.records, { ...groupOptions, kind: 'overall' })];
  if (survey.hasSegments) {
    const bySegment = new Map();
    for (const r of survey.records) {
      if (!bySegment.has(r.segment)) bySegment.set(r.segment, []);
      bySegment.get(r.segment).push(r);
    }
    for (const name of [...bySegment.keys()].sort()) {
      groups.push(analyzeGroup(name, bySegment.get(name), { ...groupOptions, kind: 'segment' }));
    }
  }

  const byReason = {};
  for (const e of survey.exclusions) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;

  const warnings = [];
  if (survey.synthetic) {
    warnings.push('SYNTHETIC DATA: this file is marked as fake test data. Nothing here is evidence.');
  }
  if (survey.totalRows > 0 && survey.exclusions.length / survey.totalRows > 0.1) {
    warnings.push(
      `${survey.exclusions.length} of ${survey.totalRows} rows (>10%) were excluded; review the data collection before trusting any result`,
    );
  }

  return {
    schema: SCHEMA,
    disclaimer: DISCLAIMER,
    synthetic: survey.synthetic,
    currency,
    source: {
      name: path.basename(sourceName),
      sha256: createHash('sha256').update(text).digest('hex'),
      rows: survey.totalRows,
      valid: survey.records.length,
      excluded: {
        total: survey.exclusions.length,
        by_reason: byReason,
        details: survey.exclusions.slice(0, DETAIL_LIMIT),
        details_truncated: survey.exclusions.length > DETAIL_LIMIT,
      },
    },
    options: {
      min_n: minN,
      bootstrap,
      seed,
      strict_order: strictOrder,
      exclude_straight_lining: excludeStraightLining,
      segment_column: segmentColumn ?? null,
    },
    warnings,
    groups,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** CSV cell with quoting and a spreadsheet formula-injection guard for user-supplied labels. */
export function csvCell(value) {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCurvesCsv(report) {
  const lines = [
    'group,kind,price,too_cheap,cheap,not_cheap,expensive,not_expensive,too_expensive',
  ];
  for (const g of report.groups) {
    if (!g.curves) continue;
    const c = g.curves;
    c.price.forEach((p, i) => {
      lines.push(
        [
          csvCell(g.name),
          g.kind,
          p,
          c.tooCheap[i],
          c.cheap[i],
          c.notCheap[i],
          c.expensive[i],
          c.notExpensive[i],
          c.tooExpensive[i],
        ].join(','),
      );
    });
  }
  return `${lines.join('\n')}\n`;
}

const xmlEscape = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
const fmt = (v) => Number(v.toFixed(2)).toString();

const SERIES = [
  { key: 'tooCheap', label: 'too cheap', color: '#b45309', dash: '' },
  { key: 'notCheap', label: 'not cheap', color: '#b45309', dash: '6 4' },
  { key: 'cheap', label: 'cheap / bargain', color: '#15803d', dash: '2 3' },
  { key: 'expensive', label: 'getting expensive', color: '#1d4ed8', dash: '2 3' },
  { key: 'notExpensive', label: 'not expensive', color: '#7c3aed', dash: '6 4' },
  { key: 'tooExpensive', label: 'too expensive', color: '#b91c1c', dash: '' },
];

/** Self-contained SVG line chart of the curves with the four intersections marked. */
export function toSvg(group, { synthetic = false, currency = null } = {}) {
  const c = group.curves;
  if (!c || c.price.length === 0) return null;
  const W = 760;
  const H = 480;
  const m = { l: 56, r: 20, t: 44, b: 96 };
  const xmin = c.price[0];
  const xmax = c.price[c.price.length - 1];
  const span = xmax - xmin || 1;
  const x = (p) => m.l + ((p - xmin) / span) * (W - m.l - m.r);
  const y = (s) => H - m.b - s * (H - m.t - m.b);
  const unit = currency ? ` (${currency})` : '';

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" font-family="system-ui, sans-serif" font-size="12">`,
    `<title>Van Westendorp curves: ${xmlEscape(group.name)}</title>`,
    `<desc>Cumulative share of respondents by price for six curves, with PMC, OPP, IPP and PME marked. n=${group.n}.</desc>`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<text x="${m.l}" y="22" font-size="14" font-weight="600" fill="#111827">${xmlEscape(group.name)} (n=${group.n})</text>`,
  );
  if (synthetic) {
    out.push(
      `<text x="${W - m.r}" y="22" text-anchor="end" font-weight="700" fill="#b91c1c">SYNTHETIC DATA - NOT EVIDENCE</text>`,
    );
  }
  for (let i = 0; i <= 4; i += 1) {
    const s = i / 4;
    out.push(
      `<line x1="${m.l}" x2="${W - m.r}" y1="${y(s).toFixed(1)}" y2="${y(s).toFixed(1)}" stroke="#e5e7eb"/>`,
      `<text x="${m.l - 8}" y="${(y(s) + 4).toFixed(1)}" text-anchor="end" fill="#374151">${i * 25}%</text>`,
    );
    const p = xmin + span * s;
    out.push(
      `<text x="${x(p).toFixed(1)}" y="${H - m.b + 18}" text-anchor="middle" fill="#374151">${fmt(p)}</text>`,
    );
  }
  out.push(
    `<line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${H - m.b}" stroke="#6b7280"/>`,
    `<line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="#6b7280"/>`,
    `<text x="${(m.l + W - m.r) / 2}" y="${H - m.b + 38}" text-anchor="middle" fill="#374151">Price${xmlEscape(unit)}</text>`,
  );
  for (const s of SERIES) {
    const pts = c.price.map((p, i) => `${x(p).toFixed(1)},${y(c[s.key][i]).toFixed(1)}`).join(' ');
    const dash = s.dash ? ` stroke-dasharray="${s.dash}"` : '';
    out.push(`<polyline fill="none" stroke="${s.color}" stroke-width="2"${dash} points="${pts}"/>`);
  }
  for (const [name, pt] of Object.entries(group.points ?? {})) {
    if (!pt) continue;
    out.push(
      `<circle cx="${x(pt.price).toFixed(1)}" cy="${y(pt.share).toFixed(1)}" r="4" fill="#111827"/>`,
      `<text x="${(x(pt.price) + 6).toFixed(1)}" y="${(y(pt.share) - 6).toFixed(1)}" font-weight="600" fill="#111827">${name} ${fmt(pt.price)}</text>`,
    );
  }
  SERIES.forEach((s, i) => {
    const lx = m.l + (i % 3) * 220;
    const ly = H - 30 + Math.floor(i / 3) * 18;
    const dash = s.dash ? ` stroke-dasharray="${s.dash}"` : '';
    out.push(
      `<line x1="${lx}" x2="${lx + 28}" y1="${ly - 4}" y2="${ly - 4}" stroke="${s.color}" stroke-width="2"${dash}/>`,
      `<text x="${lx + 34}" y="${ly}" fill="#374151">${xmlEscape(s.label)}</text>`,
    );
  });
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

export function toText(report) {
  const unit = report.currency ? ` ${report.currency}` : '';
  const money = (v) => `${v.toFixed(2)}${unit}`;
  const lines = ['Van Westendorp price sensitivity (descriptive output)'];
  if (report.synthetic) {
    lines.push('*** SYNTHETIC / FAKE DATA - FOR TESTING ONLY - NOT EVIDENCE ***');
  }
  const ex = report.source.excluded;
  lines.push(
    `Source: ${report.source.name} (sha256 ${report.source.sha256.slice(0, 12)})`,
    `Rows: ${report.source.rows}, valid: ${report.source.valid}, excluded: ${ex.total}` +
      (ex.total > 0
        ? ` (${Object.entries(ex.by_reason)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')})`
        : ''),
    '',
  );
  for (const g of report.groups) {
    lines.push(`[${g.kind === 'overall' ? 'overall' : `segment: ${g.name}`}] n=${g.n}`);
    if (g.status !== 'ok') {
      lines.push('  not analysed');
    } else {
      for (const [name, pt] of Object.entries(g.points)) {
        const ci = g.bootstrap?.intervals[name];
        const ciText =
          ci && ci.low !== null
            ? `  ${g.bootstrap.level * 100}% bootstrap interval ${money(ci.low)} to ${money(ci.high)} (${ci.defined}/${g.bootstrap.iterations} resamples defined)`
            : '';
        lines.push(
          pt
            ? `  ${name}  ${money(pt.price)}  (${(pt.share * 100).toFixed(1)}% of respondents)${ciText}`
            : `  ${name}  undefined`,
        );
      }
      lines.push(
        g.range
          ? `  Range PMC to PME: ${money(g.range.low)} to ${money(g.range.high)}`
          : '  Range PMC to PME: not available',
      );
    }
    for (const w of g.warnings) lines.push(`  warning: ${w}`);
    lines.push('');
  }
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  lines.push(report.disclaimer, '');
  return lines.join('\n');
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'group';

/** Write report.json, curves.csv and one SVG per group into outDir. Returns the written paths. */
export function writeOutputs(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  const put = (name, content) => {
    const file = path.join(outDir, name);
    writeFileSync(file, content);
    written.push(file);
  };
  put('van-westendorp.report.json', `${JSON.stringify(report, null, 2)}\n`);
  put('van-westendorp.curves.csv', toCurvesCsv(report));
  let segmentIndex = 0;
  for (const g of report.groups) {
    const svg = toSvg(g, { synthetic: report.synthetic, currency: report.currency });
    if (!svg) continue;
    if (g.kind === 'overall') {
      put('van-westendorp.overall.svg', svg);
    } else {
      segmentIndex += 1;
      put(`van-westendorp.segment-${String(segmentIndex).padStart(2, '0')}-${slug(g.name)}.svg`, svg);
    }
  }
  return written;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const intOption = (raw, name, min, max, fallback) => {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return Number(raw);
};

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'out-dir': { type: 'string' },
        format: { type: 'string', default: 'text' },
        'segment-column': { type: 'string' },
        'min-n': { type: 'string' },
        bootstrap: { type: 'string' },
        seed: { type: 'string' },
        'strict-order': { type: 'boolean', default: false },
        'exclude-straight-lining': { type: 'boolean', default: false },
        currency: { type: 'string' },
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
    if (values.format !== 'text' && values.format !== 'json') {
      throw new Error('--format must be "text" or "json"');
    }
    if (values.currency !== undefined && !/^[A-Za-z]{3}$/.test(values.currency)) {
      throw new Error('--currency must be a three-letter code');
    }
    const options = {
      minN: intOption(values['min-n'], 'min-n', 1, 1_000_000, DEFAULT_MIN_N),
      bootstrap: intOption(values.bootstrap, 'bootstrap', 0, 10_000, 0),
      seed: intOption(values.seed, 'seed', 0, 4_294_967_295, 1),
      strictOrder: values['strict-order'],
      excludeStraightLining: values['exclude-straight-lining'],
      segmentColumn: values['segment-column'],
      currency: values.currency ? values.currency.toUpperCase() : null,
      sourceName: positionals[0],
    };
    const file = positionals[0];
    if (statSync(file).size > MAX_INPUT_BYTES) {
      throw new Error(`Input is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB`);
    }
    const report = buildReport(readFileSync(file, 'utf8'), options);
    io.out(values.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : toText(report));
    if (values['out-dir']) {
      for (const f of writeOutputs(report, values['out-dir'])) io.err(`wrote ${f}\n`);
    }
    return 0;
  } catch (e) {
    io.err(`Error: ${e.code === 'ENOENT' ? `file not found: ${positionals[0]}` : e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
