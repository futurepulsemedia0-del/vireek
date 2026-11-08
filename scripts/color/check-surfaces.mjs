#!/usr/bin/env node
// scripts/color/check-surfaces.mjs — `npm run lint:surfaces` (CI gate).
// Measures the contrast of the colour classes that ACTUALLY co-occur in one class-string literal in src/**/*.tsx|ts
// — in every theme (light, dark, light-hc, dark-hc). check-colors.mjs bans wrong *tokens*; contrast.test.ts proves *token
// pairs*; this closes the gap in between: translucent tints (bg-accent/10 text-accent), gradients (from-accent to-accent-600
// text-white) and any opaque bg+text pair. Translucent backgrounds are blended over EVERY page surface (worst case wins).
//
//   node scripts/color/check-surfaces.mjs                    # gate: fail on a file with MORE failing literals than its baseline
//   node scripts/color/check-surfaces.mjs --report           # print every failing literal with its worst theme / ratio
//   node scripts/color/check-surfaces.mjs --update-baseline  # after REDUCING debt
// Deliberate exception: put `// surface-ok: <reason>` on the line.
// State-aware: base, hover:/focus:/active:/disabled:/aria-/data-/group- variants, responsive prefixes and dark: are all evaluated.
// Template literals are expanded over their ${…} branches, so `bg-accent text-on-accent` vs `text-text-secondary` ternaries and
// `base ${cond ? 'bg-X' : 'bg-Y'}` pairs are judged together. Icon-only containers (square, no text size/weight) need 3:1, text 4.5:1.
// Not analysed (listed in the summary, never guessed): arbitrary values (bg-[#…]), images/canvas, and elements whose text
// colour is inherited from a different element.
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXEMPT, parseLiteral, evaluate, fails, expandTemplate } from './surface-lib.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');
const BASELINE = join(ROOT, 'scripts', 'color', 'surface-baseline.json');
const argv = process.argv.slice(2);
const REPORT = argv.includes('--report');

const failures = []; const seen = new Set(); const perFile = {}; let analysed = 0, skipped = 0, templates = 0;
function check(rel, lineNo, cls) {
  if (!/(?:^|[\s:])(?:bg|from|via|to)-/.test(cls) || !/(?:^|[\s:])text-/.test(cls)) return;
  const p = parseLiteral(cls); skipped += p.skipped;
  const w = evaluate(p); if (!w) return;
  analysed++;
  if (!fails(w)) return;
  const key = `${rel}:${lineNo}:${w.fg}:${w.bg}:${w.scenario}`;
  if (seen.has(key)) return; seen.add(key);
  failures.push({ rel, line: lineNo, ...w, snippet: cls.trim().replace(/\s+/g, ' ').slice(0, 90) });
  perFile[rel] = (perFile[rel] ?? 0) + 1;
}
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { if (e !== 'node_modules') walk(full); continue; }
    if (!['.ts', '.tsx'].includes(extname(e)) || EXEMPT.test(full)) continue;
    const rel = relative(ROOT, full).split(sep).join('/');
    const text = readFileSync(full, 'utf8');
    const lines = text.split('\n');
    const ok = lines.map((l) => /surface-ok:/.test(l));
    // 1) every innermost class-string literal
    lines.forEach((line, i) => { if (!ok[i]) for (const s of line.split(/[`'"]|\$\{|\}/)) check(rel, i + 1, s); });
    // 2) template literals expanded over their ${…} branches (may span lines)
    for (const m of text.matchAll(/`(?:[^`\\]|\\.)*`/g)) {
      if (!m[0].includes('${')) continue;
      const lineNo = text.slice(0, m.index).split('\n').length;
      if (ok[lineNo - 1]) continue;
      templates++;
      for (const combo of expandTemplate(m[0].slice(1, -1))) check(rel, lineNo, combo);
    }
  }
})(SRC);

if (argv.includes('--update-baseline')) {
  writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(perFile).sort()), null, 2) + '\n');
  console.log(`Baseline rewritten: ${Object.keys(perFile).length} files, ${failures.length} failing literals.`);
  process.exit(0);
}
console.log(`ℹ analysed ${analysed} class combinations (${templates} template literals expanded, ${skipped} arbitrary-value classes not analysed) — ${failures.length} below threshold in some theme/state`);
if (REPORT) for (const f of failures.sort((a, b) => a.ratio - b.ratio)) console.log(`${f.ratio.toFixed(2)}/${f.min}  [${f.theme}/${f.kind}/${f.scenario}] ${f.fg} on ${f.bg}  ${f.rel}:${f.line}  "${f.snippet}"`);
const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const over_ = Object.entries(perFile).filter(([rel, n]) => n > (base[rel] ?? 0));
if (!over_.length) { console.log('✔ Surface-contrast check passed.'); process.exit(0); }
console.error(`✘ ${over_.length} file(s) gained failing class strings:`);
for (const [rel] of over_) for (const f of failures.filter((x) => x.rel === rel)) console.error(`  ${rel}:${f.line}  ${f.ratio.toFixed(2)}:1 (need ${f.min}) [${f.theme}/${f.kind}/${f.scenario}] ${f.fg} on ${f.bg}`);
console.error('\nFix with a token pair from docs/design/COLOR_TOKENS.md (text-on-<family> on solid fills; text-<family>-strong on bg-<family>/10 tints), or add `// surface-ok: reason`. Then: npm run lint:surfaces');
process.exit(1);
