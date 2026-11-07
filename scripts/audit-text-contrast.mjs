#!/usr/bin/env node
// scripts/audit-text-contrast.mjs — Phase 0: MEASURE low-contrast "alpha text" in src/. Read-only.
// Usage: node scripts/audit-text-contrast.mjs [--out reports/text-contrast]
// Output: <out>/summary.md, <out>/by-file.md, <out>/records.csv (+ console summary). Scanner: scripts/lib/text-contrast-core.mjs
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toHex } from './color/oklch.mjs';
import { MODES, TOK, contrast, over, listSourceFiles, relPath, scanFile } from './lib/text-contrast-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argOut = process.argv.indexOf('--out');
const OUT = join(ROOT, argOut > 0 ? process.argv[argOut + 1] : 'reports/text-contrast');
const files = listSourceFiles(ROOT), records = [], unresolved = new Map();
for (const f of files) {
  const r = scanFile(readFileSync(f, 'utf8'), relPath(ROOT, f));
  records.push(...r.records);
  for (const [k, v] of r.unresolved) unresolved.set(k, (unresolved.get(k) ?? 0) + v);
}

// ---------- aggregate ----------
const bucket = (r) => (r.worst == null ? 'unverifiable' : r.worst < 3 ? '<3.0' : r.worst < 4.5 ? '3.0-4.5' : '>=4.5');
const fails = (r) => r.worst != null && r.worst < r.need;
const head = records.filter((r) => r.cls === 'meaningful text' && !r.lowConf);
const by = (arr, f) => arr.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
const r2 = (x) => (x == null ? '—' : x.toFixed(2));
const perFile = {};
for (const r of records) { const o = (perFile[r.file] ??= { n: 0, fail: 0, lt3: 0, mid: 0, ok: 0, unv: 0 }); o.n++; const b = bucket(r); if (fails(r)) o.fail++; if (b === '<3.0') o.lt3++; else if (b === '3.0-4.5') o.mid++; else if (b === '>=4.5') o.ok++; else o.unv++; }

const L = [], P = (s = '') => L.push(s);
const fmt = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · ');
P('# Vireek — text contrast audit (Phase 0)');
P(`Files scanned: ${files.length} · records: ${records.length} (text-alpha ${records.filter((r) => r.kind === 'text-alpha').length}, opacity-* ${records.filter((r) => r.kind === 'opacity').length})`);
P('', '## Headline (meaningful text, alpha text utilities + opacity with known colour)');
P(`- usages: ${head.length} · **failing (below 4.5, or 3.0 for large text): ${head.filter(fails).length}** · <3.0: ${head.filter((r) => bucket(r) === '<3.0').length} · 3.0–4.5: ${head.filter((r) => bucket(r) === '3.0-4.5').length} · ≥4.5: ${head.filter((r) => bucket(r) === '>=4.5').length} · unverifiable: ${head.filter((r) => r.worst == null).length}`);
P(`- by classification: ${fmt(by(records, (r) => r.cls))}`);
P(`- by kind: ${fmt(by(records, (r) => r.kind + (r.lowConf ? ' (inherited colour, low confidence)' : '')))}`);
P(`- meaningful text with known size ≤12px: ${head.filter((r) => r.px != null && r.px <= 12).length} · with known surface in same class string: ${head.filter((r) => r.surfaceKnown).length}`);
P(`- unverifiable (gradient/image or unknown surface for white/black text): ${records.filter((r) => r.unverifiable).length}`);
P('', '## text-text-secondary/N ratios on the CURRENT palette (zip) — compare with your measured numbers');
P('| N | light bg1 | light bg2 | light bg3 | dark bg1 | dark bg2 | dark bg3 | usages |', '|---|---|---|---|---|---|---|---|');
const sec = (r) => r.util === 'text-text-secondary' && r.kind === 'text-alpha';
for (const N of [30, 40, 50, 60, 70, 80, 100]) {
  const cells = MODES.flatMap((md) => ['bg-primary', 'bg-secondary', 'bg-tertiary'].map((k) => { const s = TOK[md][k]; return r2(contrast(over(TOK[md]['text-secondary'], N / 100, s), s)); }));
  P(`| /${N} | ${cells.join(' | ')} | ${records.filter((r) => sec(r) && Math.round(r.alpha * 100) === N).length} |`);
}
P('', '## Palette text tokens as built from palette.mjs');
P('| token | light hex | dark hex | light on bg1 | dark on bg1 |', '|---|---|---|---|---|');
for (const k of ['text-primary', 'text-secondary', 'text-muted', 'text-placeholder', 'graphic-muted', 'disabled-fg']) P(`| ${k} | ${TOK.light[k] ? toHex(TOK.light[k]) : '—'} | ${TOK.dark[k] ? toHex(TOK.dark[k]) : '—'} | ${TOK.light[k] ? r2(contrast(TOK.light[k], TOK.light['bg-primary'])) : '—'} | ${TOK.dark[k] ? r2(contrast(TOK.dark[k], TOK.dark['bg-primary'])) : '—'} |`);
P('', '## Alpha text by colour utility (all classifications)');
P(fmt(by(records.filter((r) => r.kind === 'text-alpha'), (r) => r.util)));
if (unresolved.size) P('', '## Unresolved colour names (no matching Tailwind colour → class likely emits NO CSS; check before migrating)', [...unresolved].map(([k, v]) => `- ${k}: ${v}`).join('\n'));
P('', '## Not covered by this static pass', '- Ancestor backgrounds, text over gradients/images/video, inline `style` opacity/rgba, `.css` files, `text-[color:…]` arbitrary colours, runtime-built class names → Phase 3 (axe + Playwright) must cover these.', '- Classification is heuristic (icon imports, aria-hidden, variants); Phase 2 reviews each batch manually.');
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'summary.md'), L.join('\n') + '\n');

const F = ['# Per-file counts (all classifications; bucket = worst ratio across light/dark)', '', '| file | total | failing | <3.0 | 3.0–4.5 | ≥4.5 | unverifiable |', '|---|---|---|---|---|---|---|'];
for (const [f, o] of Object.entries(perFile).sort((a, b) => b[1].fail - a[1].fail || b[1].n - a[1].n)) F.push(`| ${f} | ${o.n} | ${o.fail} | ${o.lt3} | ${o.mid} | ${o.ok} | ${o.unv} |`);
writeFileSync(join(OUT, 'by-file.md'), F.join('\n') + '\n');

const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
const csv = ['file,line,kind,class,classification,px,large,state,surface_known,ratio_light,ratio_dark,worst,needs,fails,unverifiable,note'];
for (const r of records) csv.push([q(r.file), r.line, r.kind, q(r.raw), r.cls, r.px ?? '', r.large, r.state, r.surfaceKnown, r2(r.ratio.light).replace('—', ''), r2(r.ratio.dark).replace('—', ''), r.worst == null ? '' : r.worst.toFixed(2), r.need, fails(r), q(r.unverifiable), q(r.fgNote)].join(','));
writeFileSync(join(OUT, 'records.csv'), csv.join('\n') + '\n');

console.log(L.slice(0, 22).join('\n'));
console.log(`\nTop files by failing usages:\n${Object.entries(perFile).sort((a, b) => b[1].fail - a[1].fail).slice(0, 15).map(([f, o]) => `  ${String(o.fail).padStart(3)} / ${String(o.n).padStart(3)}  ${f}`).join('\n')}`);
console.log(`\nReports written to ${relative(ROOT, OUT)}/ (summary.md, by-file.md, records.csv)`);
