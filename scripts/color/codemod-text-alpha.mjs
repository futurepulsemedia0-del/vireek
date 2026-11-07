#!/usr/bin/env node
// scripts/color/codemod-text-alpha.mjs — Phase 2: replace alpha text (text-<color>/<alpha>) with VERIFIED text tokens.
// Dry-run by default. Usage:
//   node scripts/color/codemod-text-alpha.mjs [--write] [--only src/pages/Jobs] [--only src/components/jobs] [--top 25] [--aria-hidden]
//   --only <prefix>  repeatable path prefix (one batch = one or a few folders)     --top N  the N files with the most migratable edits
//   --aria-hidden    also add aria-hidden="true" to lucide icons that are re-coloured as decorative glyphs and carry no aria-*/title/role
// Rules (never lowers contrast; every choice is re-verified against the SAME surface the audit resolved):
//   meaningful text   neutral alpha  -> lowest verified token whose worst-case contrast >= max(4.5, current): text-muted -> text-secondary -> text-primary
//   decorative glyph  neutral alpha  -> text-graphic-muted (>=3:1) if not lower than current, else the text ladder
//   placeholder:      neutral alpha  -> text-placeholder (>=4.5)         disabled:  neutral alpha -> text-disabled (exempt)
//   status families   text-accent/danger/... + alpha -> alpha dropped (family text tokens are AA-verified)
//   NOT migrated (listed as exceptions): text-white/black, gradients/images, opacity-*, unresolved colours, `// contrast-ok:` lines.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES, TOK, contrast, listSourceFiles, relPath, resolveColor, scanFile } from '../lib/text-contrast-core.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const values = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const WRITE = flag('--write'), ARIA = flag('--aria-hidden'), only = values('--only'), top = Number(values('--top')[0] ?? 0);

const NEUTRAL = new Set(['text-text-primary', 'text-text-secondary', 'text-text-muted']);
const FAMILY = /^text-(accent|cta|success|danger|warning|info)$/;
const LADDER = {
  'meaningful text': [['text-text-muted', 'text-muted'], ['text-text-secondary', 'text-secondary'], ['text-text-primary', 'text-primary']],
  'decorative glyph': [['text-graphic-muted', 'graphic-muted'], ['text-text-muted', 'text-muted'], ['text-text-secondary', 'text-secondary'], ['text-text-primary', 'text-primary']],
  placeholder: [['text-text-placeholder', 'text-placeholder'], ['text-text-muted', 'text-muted'], ['text-text-secondary', 'text-secondary']],
};
const EPS = 1e-6;
const worstOn = (rec, rgbOf) => Math.min(...rec.modes.flatMap((md) => rec.sf[md].map((s) => contrast(rgbOf(md), s))));

/** @returns {{to:string}|{skip:string}} */
function decide(rec) {
  if (rec.ok) return { skip: 'contrast-ok comment' };
  if (rec.kind === 'opacity') return { skip: 'opacity-*: manual (restructure or use a token; not auto-migrated)' };
  if (rec.alpha === 0 || rec.cls === 'incidental') return { skip: 'incidental (alpha 0 / sr-only)' };
  if (rec.cls === 'disabled') return NEUTRAL.has(rec.util) ? { to: 'text-text-disabled' } : { skip: 'disabled, non-neutral colour' };
  if (rec.unverifiable) return { skip: `unverifiable: ${rec.unverifiable}` };
  if (rec.util === 'text-white' || rec.util === 'text-black') return { skip: 'white/black text: surface-dependent, manual' };
  if (rec.worst == null) return { skip: rec.fgNote || 'colour not resolvable' };
  if (rec.cls !== 'decorative glyph' && rec.alpha < 0.3) return { skip: 'alpha < 30% on text: ghost decoration, not readable content — remove it or make it a glyph (manual)' };
  if (FAMILY.test(rec.util)) {
    const ok = worstOn(rec, (md) => resolveColor(rec.util.slice(5), md, 'text')) >= rec.need - EPS;
    return ok ? { to: rec.util } : { skip: 'family text does not reach AA on this surface: manual' };
  }
  const ladder = LADDER[rec.cls];
  if (!NEUTRAL.has(rec.util) || !ladder) return { skip: `no mapping for ${rec.util} (${rec.cls})` };
  const floor = Math.max(rec.need, rec.worst);
  for (const [i, [cls, tok]] of ladder.entries()) {
    // glyphs may land on graphic-muted (3.3:1, WCAG 1.4.11) even when slightly below the old alpha result; text may never go lower
    const min = rec.cls === 'decorative glyph' && i === 0 ? Math.max(rec.need, Math.min(rec.worst, 3.3)) : floor;
    if (worstOn(rec, (md) => TOK[md][tok]) >= min - EPS) return { to: cls };
  }
  return { skip: 'no verified token reaches AA on this surface: manual' };
}

const all = listSourceFiles(ROOT).map((f) => ({ f, rel: relPath(ROOT, f) })).filter(({ rel }) => !only.length || only.some((p) => rel.startsWith(p)));
let plans = all.map(({ f, rel }) => {
  const src = readFileSync(f, 'utf8');
  const { records } = scanFile(src, rel);
  const edits = [], skips = [], ariaAt = new Map();
  for (const r of records) {
    const d = decide(r);
    if (d.skip) { skips.push({ r, why: d.skip }); continue; }
    edits.push({ start: r.start, end: r.end, to: d.to, from: r.raw.slice(r.pre.length).replace(/^!/, ''), r });
    if (ARIA && r.cls === 'decorative glyph' && r.tag?.isIcon && !r.tag.hasA11yAttr) ariaAt.set(r.tag.back + 1 + r.tag.name.length, rel + ':' + r.line);
  }
  return { f, rel, src, edits, skips, ariaAt };
}).filter((p) => p.edits.length || p.skips.length);
if (top) plans = plans.filter((p) => p.edits.length).sort((a, b) => b.edits.length - a.edits.length).slice(0, top);

let changed = 0;
for (const p of plans) {
  if (!p.edits.length) continue;
  const ops = [...p.edits.map((e) => ({ at: e.start, end: e.end, text: e.to })), ...[...p.ariaAt.keys()].map((at) => ({ at, end: at, text: ' aria-hidden="true"' }))].sort((a, b) => b.at - a.at);
  let out = p.src;
  for (const o of ops) out = out.slice(0, o.at) + o.text + out.slice(o.end);
  changed++;
  if (WRITE) writeFileSync(p.f, out);
}

// ---------- report ----------
const edits = plans.flatMap((p) => p.edits), skips = plans.flatMap((p) => p.skips);
const tally = (arr, key) => Object.entries(arr.reduce((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
const L = [`# text-alpha codemod — ${WRITE ? 'APPLIED' : 'DRY RUN'}`, '', `files with edits: ${changed} · edits: ${edits.length} · exceptions (not migrated): ${skips.length}${ARIA ? ` · aria-hidden insertions: ${plans.reduce((n, p) => n + p.ariaAt.size, 0)}` : ''}`, '', '## Mapping (from → to)', ...tally(edits, (e) => `${e.from} → ${e.to}`).map(([k, v]) => `- ${k}: ${v}`), '', '## Exceptions by reason', ...tally(skips, (s) => s.why).map(([k, v]) => `- ${k}: ${v}`), '', '## Edits per file', ...plans.filter((p) => p.edits.length).sort((a, b) => b.edits.length - a.edits.length).map((p) => `- ${p.rel}: ${p.edits.length}`), '', '## Exceptions (file:line raw — reason)', ...skips.filter((s) => s.r.cls !== 'disabled' && !/^opacity/.test(s.why)).map((s) => `- ${s.r.file}:${s.r.line} \`${s.r.raw}\` — ${s.why}`)];
mkdirSync(join(ROOT, 'reports/text-contrast'), { recursive: true });
const outFile = join(ROOT, 'reports/text-contrast', WRITE ? 'codemod-applied.md' : 'codemod-dry-run.md');
writeFileSync(outFile, L.join('\n') + '\n');
console.log(L.slice(0, 22).join('\n'));
console.log(`\n${WRITE ? 'Files rewritten.' : 'Nothing written (dry run). Re-run with --write.'} Full report: ${outFile.replace(ROOT + '/', '')}`);
