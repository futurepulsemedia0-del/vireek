// scripts/design/layout-guard.mjs
// Ratchet guard for layout tokens. Imported by scripts/check-design-system.mjs.
//   node scripts/design/layout-guard.mjs --update-baseline   # record current remaining violations (can only shrink afterwards)
// Escape hatch for a single line: add `ds-allow: <reason>` in a comment on that line or the line above.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { ARB_RE, Z_ARB_RE, SHADOW_RE, SHADOW_ARB_RE, isAllowedArbitraryValue } from './layout-tokens.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const BASELINE = join(ROOT, 'scripts/design/layout-guard.baseline.json');
const Z_ANY = /(?<![\w\[\]-])(?:[a-z0-9-]+:)*-?z-(?:0|10|20|30|40|50)(?![\w\[-])/g;
const INLINE_Z = /\bzIndex\s*:\s*['"]?\d/g;
const STYLE_ONE_LINE = /style=\{\{([^{}\n]*)\}\}/g;
const STATIC_VALUE = /^\s*(?:'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?)\s*$/;

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { if (!['node_modules', 'locales', 'test'].includes(e)) yield* walk(full); }
    else if (['.ts', '.tsx'].includes(extname(e)) && !/\.(test|spec|d)\.(ts|tsx)$/.test(e)) yield full;
  }
}

export function scanSource(text) {
  /** @type {{rule:string, line:number, snippet:string}[]} */
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (/ds-allow:/.test(line) || /ds-allow:/.test(lines[i - 1] ?? '')) return;
    const add = (rule) => out.push({ rule, line: i + 1, snippet: line.trim().slice(0, 110) });
    for (const m of line.matchAll(new RegExp(ARB_RE.source, 'g'))) if (!isAllowedArbitraryValue(m[4])) add('no-arbitrary-layout');
    if (new RegExp(Z_ARB_RE.source).test(line) || new RegExp(Z_ANY.source).test(line) || new RegExp(INLINE_Z.source).test(line)) add('no-numeric-z');
    if (new RegExp(SHADOW_RE.source).test(line) || new RegExp(SHADOW_ARB_RE.source).test(line) || /boxShadow\s*:\s*['"`](?!var\()/.test(line)) add('no-raw-shadow');
    for (const m of line.matchAll(new RegExp(STYLE_ONE_LINE.source, 'g'))) {
      const entries = m[1].split(/,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean);
      if (entries.length && entries.every((e) => { const [k, ...v] = e.split(':'); return v.length && !k.trim().startsWith('...') && !k.trim().startsWith("'--") && STATIC_VALUE.test(v.join(':')); })) add('no-static-inline-style');
    }
  });
  return out;
}

export function collectLayoutViolations(pushViolation) {
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
  const current = {};
  const items = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file);
    for (const v of scanSource(readFileSync(file, 'utf8'))) {
      const key = `${rel}|${v.rule}`;
      current[key] = (current[key] ?? 0) + 1;
      items.push({ ...v, file: rel, key });
    }
  }
  const seen = {};
  for (const it of items) {
    seen[it.key] = (seen[it.key] ?? 0) + 1;
    if (seen[it.key] > (baseline[it.key] ?? 0)) pushViolation({ rule: it.rule, file: it.file, line: it.line, snippet: it.snippet });
  }
  return current;
}

if (process.argv[1] === new URL(import.meta.url).pathname && process.argv.includes('--update-baseline')) {
  const current = collectLayoutViolations(() => {});
  writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(current).sort()), null, 2) + '\n');
  console.log(`Baseline written: ${Object.values(current).reduce((a, b) => a + b, 0)} tolerated violations in ${Object.keys(current).length} file/rule pairs.`);
}
