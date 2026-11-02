// scripts/brand-audit/checks/tokens.mjs
//
// Design-token compliance. Counts raw colors / arbitrary sizes / Tailwind default-palette classes in
// src/**/*.{ts,tsx}. Score = % of in-scope files with ZERO violations (strict: 100 means "zero raw
// colors/px"). A per-file ratchet baseline (baselines/tokens.json) stops the count from growing.
//
// Escape hatch (reviewed in PRs): `// brand-audit-allow <rule[,rule]>: <reason>` on the same or the
// previous line. A missing reason is NOT honored and is itself reported.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, walk, stripComments, finding, pct, round1, combine } from '../lib/util.mjs';
import { TOKEN_EXEMPT } from '../config.mjs';

const BASELINE = join(ROOT, 'scripts/brand-audit/baselines/tokens.json');

const PALETTES = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const UTILS = 'bg|text|border|ring|from|to|via|fill|stroke|divide|outline|decoration|accent|shadow|placeholder|caret';
const ANCHOR_CTX = /(?:href|\bto|\bid|htmlFor|aria-[a-z]+|data-[a-z-]+|querySelector(?:All)?\(|getElementById\(|url\(|\.hash\s*={1,3}|hash:)\s*=?\s*\{?\s*[`'"]?$/;

export const RULES = {
  'raw-hex': {
    title: 'Raw hex color', severity: 'medium',
    fix: 'Use a semantic token (bg-bg-secondary, text-text-primary, text-accent …) or a CSS variable from src/index.css.',
    find(line) {
      const out = [];
      const re = /(?<![\w&/#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g;
      for (let m; (m = re.exec(line)); ) if (!ANCHOR_CTX.test(line.slice(0, m.index))) out.push(m[0]);
      return out;
    },
  },
  'raw-rgb': {
    title: 'Raw rgb()/hsl() color', severity: 'medium',
    fix: 'Use rgb(var(--token) / alpha) or a Tailwind token class.',
    find: (line) => [...line.matchAll(/\b(?:rgba?|hsla?)\(\s*(?!var\()/g)].map((m) => m[0]),
  },
  'arbitrary-px': {
    title: 'Arbitrary px size (not on the spacing/size scale)', severity: 'low',
    fix: 'Use a scale step (w-64, gap-3 …); 44px touch targets are min-h-11/min-w-11. Add a named value to tailwind.config.js if the scale truly lacks it. 0/1/2px hairlines are allowed.',
    find(line) {
      const out = [];
      for (const m of line.matchAll(/\b((?:[a-z]+:)*)([a-z]+(?:-[a-z]+)*)-\[(-?\d*\.?\d+)px\]/g)) {
        if (m[2] === 'text' || m[2] === 'leading') continue; // handled by arbitrary-type-size
        if (Math.abs(Number(m[3])) <= 2) continue;
        out.push(m[0]);
      }
      for (const m of line.matchAll(/:\s*['"`](-?\d*\.?\d+)px['"`]/g)) if (Math.abs(Number(m[1])) > 2) out.push(m[0]);
      return out;
    },
  },
  'arbitrary-type-size': {
    title: 'Arbitrary font size/leading (bypasses the type scale)', severity: 'low',
    fix: 'Use text-xs … text-4xl or text-eyebrow; add a named size to tailwind.config.js if one is missing.',
    find: (line) => [...line.matchAll(/\b(?:[a-z]+:)*(?:text|leading)-\[-?\d*\.?\d+(?:px|rem|em)\]/g)].map((m) => m[0]),
  },
  'palette-class': {
    title: 'Tailwind default-palette color (bypasses brand tokens)', severity: 'medium',
    fix: 'Use semantic classes: text-text-secondary, bg-bg-tertiary, border-border, text-success/danger/warning-500.',
    find: (line) => [...line.matchAll(new RegExp(`\\b(?:[a-z-]+:)*(?:${UTILS})-(?:${PALETTES})-(?:50|[1-9]00|950)(?:/\\d+)?\\b`, 'g'))].map((m) => m[0]),
  },
};

const ALLOW_RE = /brand-audit-allow\s+([\w,-]+)\s*:\s*(\S.*)$/;

export function exempt(file) {
  return TOKEN_EXEMPT.find((e) => file === e.prefix || file.startsWith(e.prefix)) ?? null;
}

/** Pure: analyse one file's source. Returns { hits: [{rule,line,text}], badAllows: [line] }. */
export function analyzeSource(src) {
  const orig = src.split('\n');
  const lines = stripComments(src).split('\n');
  const allows = new Map(); // line index -> Set(rule)
  const badAllows = [];
  orig.forEach((l, i) => {
    const m = ALLOW_RE.exec(l);
    if (!m) { if (/brand-audit-allow/.test(l)) badAllows.push(i + 1); return; }
    const set = new Set(m[1].split(','));
    for (const idx of [i, i + 1]) allows.set(idx, new Set([...(allows.get(idx) ?? []), ...set]));
  });
  const hits = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    for (const [rule, def] of Object.entries(RULES)) {
      if (allows.get(i)?.has(rule)) continue;
      for (const text of def.find(line)) hits.push({ rule, line: i + 1, text });
    }
  });
  return { hits, badAllows };
}

export function scan() {
  const perFile = {}; // file -> { rule: count }
  const hitsByFile = {};
  const badAllows = [];
  let files = 0;
  let exemptFiles = 0;
  for (const file of walk('src', { exts: ['.ts', '.tsx'], skipTests: true })) {
    if (file.startsWith('src/locales/')) continue;
    if (exempt(file)) { exemptFiles++; continue; }
    files++;
    const { hits, badAllows: bad } = analyzeSource(readFileSync(join(ROOT, file), 'utf8'));
    bad.forEach((l) => badAllows.push({ file, line: l }));
    if (!hits.length) continue;
    hitsByFile[file] = hits;
    perFile[file] = {};
    for (const h of hits) perFile[file][h.rule] = (perFile[file][h.rule] ?? 0) + 1;
  }
  return { perFile, hitsByFile, files, exemptFiles, badAllows };
}

export const loadBaseline = () => (existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null);

/** Pure ratchet: which (file, rule) pairs grew vs the baseline? */
export function ratchet(perFile, baseline) {
  const grown = [];
  for (const [file, rules] of Object.entries(perFile)) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowed = baseline?.files?.[file]?.[rule] ?? 0;
      if (count > allowed) grown.push({ file, rule, count, allowed });
    }
  }
  return grown;
}

export function writeBaseline(perFile, { force = false } = {}) {
  const old = loadBaseline();
  const next = { version: 1, note: 'Per-file raw-token counts. May only go DOWN (node scripts/brand-audit/lint-tokens.mjs --write-baseline).', files: {} };
  for (const [file, rules] of Object.entries(perFile)) {
    next.files[file] = {};
    for (const [rule, count] of Object.entries(rules)) {
      const prev = old?.files?.[file]?.[rule];
      next.files[file][rule] = force || prev === undefined ? count : Math.min(prev, count);
    }
  }
  const sorted = Object.fromEntries(Object.keys(next.files).sort().map((k) => [k, next.files[k]]));
  writeFileSync(BASELINE, `${JSON.stringify({ ...next, files: sorted }, null, 1)}\n`);
  return Object.keys(sorted).length;
}

export async function run() {
  const { perFile, hitsByFile, files, exemptFiles, badAllows } = scan();
  const filesWith = (rules) => Object.values(perFile).filter((r) => rules.some((x) => r[x])).length;
  const total = (rule) => Object.values(perFile).reduce((a, r) => a + (r[rule] ?? 0), 0);
  const colorFiles = filesWith(['raw-hex', 'raw-rgb', 'palette-class']);
  const sizeFiles = filesWith(['arbitrary-px', 'arbitrary-type-size']);
  const components = [
    { name: 'Colors: files with no raw hex/rgb/palette classes', weight: 60, score: round1(pct(files - colorFiles, files)), detail: `${colorFiles}/${files} files violate` },
    { name: 'Sizes: files with no arbitrary px / type sizes', weight: 40, score: round1(pct(files - sizeFiles, files)), detail: `${sizeFiles}/${files} files violate` },
  ];
  const findings = [];
  for (const [rule, def] of Object.entries(RULES)) {
    const refs = Object.entries(hitsByFile).flatMap(([file, hs]) => hs.filter((h) => h.rule === rule).map((h) => ({ file, line: h.line, text: h.text })));
    if (!refs.length) continue;
    findings.push(finding({ id: `tokens/${rule}`, category: 'tokens', severity: def.severity, title: `${def.title}: ${refs.length} occurrence(s) in ${new Set(refs.map((r) => r.file)).size} file(s)`, detail: def.fix, refs: refs.slice(0, 200), count: refs.length }));
  }
  if (badAllows.length) findings.push(finding({ id: 'tokens/allow-without-reason', category: 'tokens', severity: 'low', title: `${badAllows.length} brand-audit-allow comment(s) have no reason and are ignored`, refs: badAllows, count: badAllows.length }));
  const grown = ratchet(perFile, loadBaseline());
  return {
    category: 'tokens',
    components,
    metrics: { filesScanned: files, exemptFiles, rawHex: total('raw-hex'), rawRgb: total('raw-rgb'), arbitraryPx: total('arbitrary-px'), arbitraryTypeSize: total('arbitrary-type-size'), paletteClass: total('palette-class'), ratchetGrowth: grown.length, ratchetBaseline: loadBaseline() ? 'present' : 'missing' },
    findings,
    ratchet: grown,
  };
}
export { combine };
