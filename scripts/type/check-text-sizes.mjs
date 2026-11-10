#!/usr/bin/env node
// scripts/type/check-text-sizes.mjs — `npm run lint:type` (CI gate; also run as Rule 6 of scripts/check-design-system.mjs).
//
// ZERO tolerance, no baseline. Fails when src/**/*.{ts,tsx,css} contains:
//   R1  an arbitrary Tailwind text size            text-[11px], md:text-[0.65rem], text-[0.9em] …   → use a type-scale token
//   R2  ANY text size below 12px, in any form      inline fontSize, SVG fontSize, CSS font-size (incl. clamp/min/max),
//                                                  font: shorthand, ctx.font                         → floor is 0.75rem
//   R3  a px font-size in CSS or an inline style   font-size: 14px, fontSize: 14                    → use rem (follows user text size)
//   R4  a literal SVG fontSize                     <text fontSize="12">                              → useSvgTextSize() (viewBox scaling)
//   R5  an allowlist entry whose invariant no longer holds (wallboard em system floor)
//
// The ONLY exceptions live in scripts/type/text-size-allowlist.json: per file, per kind, with a reason.
// The 12px floor (R2) applies to allowlisted files too — the allowlist can waive R1/R3/R4, never R2.
// Deliberate one-off on a line: `// type-ok: <reason>` (rare; reviewed).
//
//   node scripts/type/check-text-sizes.mjs            # check
//   node scripts/type/check-text-sizes.mjs --json     # machine-readable

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectSizes, lineOf } from './lib/detect.mjs';
import { MIN_REM, ROOT_PX } from './type-scale.mjs';

const FLOOR_PX = MIN_REM * ROOT_PX;
const DEFAULT_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const EXEMPT_FILE = /(\.test\.|\.spec\.|[\\/]test[\\/]|[\\/]node_modules[\\/])/;

const RULE_TEXT = {
  R1: 'Arbitrary text size → use a type-scale token (text-caption / text-small / text-body / text-lead / text-h1…h4 / text-display). Parent-relative text in prose → type-inline.',
  R2: `Text below ${FLOOR_PX}px is not allowed (WCAG-driven floor, 0.75rem). Use text-caption and fix layout (wrap, truncate + title/tooltip, column priority, scroll container) instead of shrinking.`,
  R3: 'px font-size → use rem so the size follows the user text-size setting and the OS font scale.',
  R4: 'Literal SVG fontSize renders at viewBox scale, not CSS px → use useSvgTextSize() from @/hooks/useSvgTextSize.',
  R5: 'Allowlist invariant violated.',
};

export function loadAllowlist(root = DEFAULT_ROOT) {
  const p = join(root, 'scripts', 'type', 'text-size-allowlist.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).files ?? {} : {};
}

/** Pure: returns violations for one file's text. Exposed for tests. */
export function checkText(text, ext, rel, allow = {}) {
  const allowed = new Set(allow[rel]?.allow ?? []);
  const lines = text.split('\n');
  const out = [];
  for (const h of detectSizes(text, ext)) {
    const line = lineOf(text, h.index);
    if (/type-ok:/.test(lines[line - 1] ?? '')) continue;
    const push = (rule) => out.push({ rule, file: rel, line, snippet: h.raw.slice(0, 80), px: h.px, kind: h.kind });

    // R2 — the floor. Relative em is resolved against its (allowlisted, invariant-checked) root, so it is skipped here.
    if (!h.relative && h.px < FLOOR_PX) push('R2');

    if (h.kind === 'tailwind-arbitrary') {
      if (h.unit === 'em' && allowed.has('em')) continue;
      push('R1');
    } else if (h.kind === 'svg-attr') {
      if (!allowed.has('svg')) push('R4');
    } else if ((h.kind === 'css' || h.kind === 'inline-style' || h.kind === 'font-shorthand') && h.unit === 'px' && !allowed.has('px')) {
      // inline-style numbers are px by React convention
      push('R3');
    }
  }
  return out;
}

/**
 * R5 — wallboard invariant: (root font-size minimum, in px at a 16px root) × (smallest em multiplier used) ≥ floor.
 * Parses src/pages/WallboardPage.tsx (WALLBOARD_ROOT_FONT_SIZE = 'clamp(<min>rem, …)') and every text-[Nem] in the
 * em-allowlisted files. Exposed for tests.
 */
export function checkEmInvariants(root = DEFAULT_ROOT, allow = loadAllowlist(root)) {
  const out = [];
  const emFiles = Object.entries(allow).filter(([, v]) => v.allow?.includes('em')).map(([k]) => k);
  if (!emFiles.length) return out;
  const page = join(root, 'src/pages/WallboardPage.tsx');
  const rootSrc = existsSync(page) ? readFileSync(page, 'utf8') : '';
  const m = rootSrc.match(/WALLBOARD_ROOT_FONT_SIZE\s*=\s*['"`]clamp\(\s*([0-9.]+)rem/);
  if (!m) {
    out.push({ rule: 'R5', file: 'src/pages/WallboardPage.tsx', line: 1, snippet: 'WALLBOARD_ROOT_FONT_SIZE must be a rem-based clamp(<min>rem, …) so the em floor can be proven', px: 0, kind: 'invariant' });
    return out;
  }
  const rootMinPx = parseFloat(m[1]) * ROOT_PX;
  for (const rel of emFiles) {
    const f = join(root, rel);
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    for (const h of detectSizes(text, extname(f))) {
      if (h.kind === 'tailwind-arbitrary' && h.unit === 'em') {
        const mult = h.px / ROOT_PX;
        if (rootMinPx * mult < FLOOR_PX - 1e-9) {
          out.push({ rule: 'R5', file: rel, line: lineOf(text, h.index), snippet: `${h.raw}: ${rootMinPx}px root × ${mult} = ${(rootMinPx * mult).toFixed(2)}px < ${FLOOR_PX}px`, px: rootMinPx * mult, kind: 'invariant' });
        }
      }
    }
  }
  return out;
}

export function checkRepo(root = DEFAULT_ROOT) {
  const allow = loadAllowlist(root);
  const violations = [];
  let scanned = 0;
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules') walk(full);
        continue;
      }
      const ext = extname(entry);
      if (!['.ts', '.tsx', '.css'].includes(ext) || EXEMPT_FILE.test(full)) continue;
      scanned++;
      const rel = relative(root, full).split(sep).join('/');
      violations.push(...checkText(readFileSync(full, 'utf8'), ext, rel, allow));
    }
  })(join(root, 'src'));
  // An allowlist entry for a file that no longer needs it is itself debt: fail so it gets deleted.
  for (const rel of Object.keys(allow)) {
    if (!existsSync(join(root, rel))) violations.push({ rule: 'R5', file: rel, line: 1, snippet: 'allowlisted file no longer exists — remove the entry', px: 0, kind: 'allowlist' });
  }
  violations.push(...checkEmInvariants(root, allow));
  return { scanned, violations };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { scanned, violations } = checkRepo();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ scanned, violations }, null, 2));
    process.exit(violations.length ? 1 : 0);
  }
  if (!violations.length) {
    console.log(`✔ Text-size check passed — ${scanned} files, zero arbitrary text sizes, nothing below ${FLOOR_PX}px.`);
    process.exit(0);
  }
  console.error(`✘ Text-size check found ${violations.length} violation(s) in ${scanned} files:\n`);
  const by = {};
  violations.forEach((v) => (by[v.rule] ??= []).push(v));
  for (const [rule, items] of Object.entries(by)) {
    console.error(`${rule} (${items.length}) — ${RULE_TEXT[rule]}`);
    items.slice(0, 40).forEach((v) => console.error(`  ${v.file}:${v.line}  ${v.snippet}`));
    if (items.length > 40) console.error(`  … and ${items.length - 40} more`);
    console.error('');
  }
  process.exit(1);
}
