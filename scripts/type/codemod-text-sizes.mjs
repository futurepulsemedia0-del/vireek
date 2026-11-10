#!/usr/bin/env node
// scripts/type/codemod-text-sizes.mjs
//
// Phase 2 codemod: rewrites Tailwind arbitrary text sizes (text-[11px], md:text-[0.65rem], !text-[10px] …)
// to the NEAREST token of the type scale. Everything below 12px lands on `caption` (12px) — the floor.
//
//   node scripts/type/codemod-text-sizes.mjs              # dry run, prints a summary
//   node scripts/type/codemod-text-sizes.mjs --write      # apply
//   node scripts/type/codemod-text-sizes.mjs --write --log docs/design/type-audit/codemod-log.json
//   node scripts/type/codemod-text-sizes.mjs --files src/pages/A.tsx,src/pages/B.tsx   # batch by file
//
// Rules
//   • px / rem / pt (absolute): nearest token by pixel value at a 16px root; ties round UP (readability wins).
//   • below 12px: always `text-caption`.
//   • em (parent-relative): NEVER guessed. In files listed in the allowlist they are left alone; values in
//     [0.75, 1) elsewhere become `type-inline` (parent-relative, floored at 12px); anything else is reported.
//   • Variant prefixes (sm:, dark:, hover:, …) and the important modifier (!) are preserved.
//   • Only text-[<number><unit>] is touched; text-[#hex], text-[color:…] and text-[length:var(--x)] are not matched.
//   • Idempotent: a second run changes nothing.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, resolve } from 'node:path';
import { TYPE_SCALE, toPx, MIN_REM, ROOT_PX } from './type-scale.mjs';

// Stock Tailwind sizes above the semantic scale, used only when the source size is genuinely larger than `display-lg`.
const BIG_STOCK = [
  { cls: 'text-7xl', px: 72 },
  { cls: 'text-8xl', px: 96 },
  { cls: 'text-9xl', px: 128 },
];

/** Class for a semantic token. ≥18px uses the stock alias (text-lg…) so non-heading text isn't tagged `h3`. */
function classFor(t) {
  if (['caption', 'small', 'body', 'display', 'display-lg'].includes(t.name)) return `text-${t.name}`;
  return `text-${t.alias}`;
}
const CANDIDATES = [
  ...TYPE_SCALE.filter((t) => t.name !== 'eyebrow').map((t) => ({ cls: classFor(t), px: toPx(t.rem) })),
  ...BIG_STOCK,
].sort((a, b) => a.px - b.px);

/** @returns {string} the token class nearest to `px` (ties round up; <12px → caption). */
export function nearestTokenClass(px) {
  if (!(px > 0)) throw new Error(`bad size ${px}`);
  if (px <= ROOT_PX * MIN_REM) return 'text-caption';
  let best = CANDIDATES[0];
  let bestD = Infinity;
  for (const c of CANDIDATES) {
    const d = Math.abs(c.px - px);
    if (d < bestD || (d === bestD && c.px > best.px)) {
      best = c;
      bestD = d;
    }
  }
  return best.cls;
}

export function toPxValue(value, unit) {
  const n = parseFloat(value);
  if (unit === 'px') return n;
  if (unit === 'rem') return n * ROOT_PX;
  if (unit === 'pt') return (n * 96) / 72;
  return NaN; // em handled separately
}

const RE_TW = /(?<![\w-])((?:[\w-]+:)*)(!?)text-\[(-?[0-9]*\.?[0-9]+)(px|rem|em|pt)\]/g;

/**
 * Transform one file's text. Returns the new text plus a change list and anything left for manual review.
 * @param {string} text
 * @param {{ file?: string, emAllowed?: boolean }} [opts]
 */
export function transformText(text, opts = {}) {
  const changes = [];
  const manual = [];
  const out = text.replace(RE_TW, (match, variants, bang, value, unit, offset) => {
    const line = text.slice(0, offset).split('\n').length;
    if (unit === 'em') {
      if (opts.emAllowed) return match;
      const v = parseFloat(value);
      if (v >= MIN_REM && v < 1 && !variants && !bang) {
        const to = 'type-inline';
        changes.push({ line, from: match, to });
        return to;
      }
      manual.push({ line, raw: match, reason: 'parent-relative em: needs a human decision' });
      return match;
    }
    const px = toPxValue(value, unit);
    const to = `${variants}${bang}${nearestTokenClass(px)}`;
    changes.push({ line, from: match, to });
    return to;
  });
  return { text: out, changes, manual };
}

// ----------------------------------------------------------------------------------------------- CLI
const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const ROOT = new URL('../..', import.meta.url).pathname;
  const argv = process.argv.slice(2);
  const arg = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const WRITE = argv.includes('--write');
  const LOG = arg('--log');
  const only = arg('--files')?.split(',').map((f) => join(ROOT, f));
  const allowlist = JSON.parse(readFileSync(join(ROOT, 'scripts/type/text-size-allowlist.json'), 'utf8'));
  const emFiles = new Set(Object.entries(allowlist.files ?? {}).filter(([, v]) => v.allow?.includes('em')).map(([k]) => k));

  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules') continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (['.ts', '.tsx'].includes(extname(e))) out.push(full);
    }
    return out;
  };
  const files = only ?? walk(join(ROOT, 'src'));
  const log = [];
  const manualAll = [];
  let touched = 0;
  const tally = {};
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const rel = relative(ROOT, f);
    const { text, changes, manual } = transformText(src, { file: rel, emAllowed: emFiles.has(rel) });
    manual.forEach((m) => manualAll.push({ file: rel, ...m }));
    if (!changes.length) continue;
    touched++;
    changes.forEach((c) => {
      log.push({ file: rel, ...c });
      const k = `${c.from.replace(/^.*?text-/, 'text-')} -> ${c.to.replace(/^.*?(text-|type-)/, '$1')}`;
      tally[k] = (tally[k] ?? 0) + 1;
    });
    if (WRITE) writeFileSync(f, text);
  }
  console.log(`${WRITE ? 'APPLIED' : 'DRY RUN'}: ${log.length} replacements in ${touched} files`);
  console.log('Mapping tally (top 20):');
  Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));
  if (manualAll.length) {
    console.log(`\nNEEDS MANUAL REVIEW (${manualAll.length}):`);
    manualAll.forEach((m) => console.log(`  ${m.file}:${m.line}  ${m.raw}  — ${m.reason}`));
  }
  if (LOG) writeFileSync(resolve(ROOT, LOG), JSON.stringify({ applied: WRITE, replacements: log, manual: manualAll }, null, 2));
}
