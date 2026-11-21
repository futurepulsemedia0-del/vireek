#!/usr/bin/env node
// scripts/color/check-palette.mjs — `npm run lint:palette`
// Fails the build if ANY colour literal (#rgb / #rrggbb / #rrggbbaa, also URL-encoded %23…) in product code is not a member of the
// live palette: every token of every theme, every 50–950 scale step, or an exact published brand seed. This is the gate that
// stops a stray "#FF5722" (or an old brand colour) coming back after the palette is changed.
//
// Test files, docs, generated files and tooling are out of scope (they legitimately contain fixtures and banned-colour lists).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, buildTheme, FAMILY_NAMES, FAMILY_DEFS, buildScale, NEUTRAL_SCALE } from './palette.mjs';
import { toHex } from './oklch.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

// Exact published brand seeds (see the header of palette.mjs) + neutral black/white + Google's "G" (third-party mark).
const BRAND_SEEDS = ['#141413', '#FAF9F5', '#E8E6DC', '#B0AEA5', '#F0EEE6', '#D97757', '#6A9BCC', '#788C5D', '#0071E3', '#0091FF', '#34C759', '#30D158', '#FF383C', '#FF4245', '#FF2D55', '#FF375F', '#FFCC00', '#FFD600', '#533AFD', '#76B900', '#882A8B', '#6C32A9', '#046C7A', '#FF911E', '#F25022', '#FFFFFF', '#000000', '#4285F4', '#EA4335', '#FBBC05', '#34A853'];
// Documentary examples that are not colours (e.g. a comment explaining hex shorthand expansion).
const IGNORE = new Set(['#AABBCC', '#0C2238']);

const ALLOWED = new Set(BRAND_SEEDS);
for (const t of THEMES) for (const v of Object.values(buildTheme(t).tok)) if (Array.isArray(v) && v.length === 3) ALLOWED.add(toHex(v));
for (const n of FAMILY_NAMES) for (const v of Object.values(buildScale({ ...FAMILY_DEFS[n] }))) ALLOWED.add(v.toUpperCase());
for (const v of Object.values(NEUTRAL_SCALE)) ALLOWED.add(v.toUpperCase());

const EXT = new Set(['.py', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.css', '.html', '.svg', '.json', '.webmanifest', '.xml', '.plist', '.swift', '.kt', '.java', '.gradle']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build']);
const SKIP_ROOT = new Set(['docs', 'patches', 'reports', 'e2e', 'eval', 'load', 'evidence', 'rc', 'vireek-a11y', 'vireek-docs-phase1', 'ops', 'locales']);
const SKIP_PATH = new Set(['scripts/color', 'scripts/brand-audit', 'scripts/pricing']); // pricing = synthetic-data chart tooling, not product colour
const SKIP_REL = new Set(['scripts/brand/check-pwa.mjs']); // lists the BANNED legacy colours on purpose
const SKIP_FILE = /(tokens\.generated|brand-colors\.ts$|package-lock\.json$|\.min\.|\.test\.|\.spec\.|_test\.)/;
const RE = /(?:#|%23)([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g;
const norm = (b) => { b = b.toUpperCase(); if (b.length === 8) b = b.slice(0, 6); return '#' + (b.length === 3 ? [...b].map((c) => c + c).join('') : b); };

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e); const rel = relative(ROOT, f).split(sep).join('/');
    if (statSync(f).isDirectory()) { if (SKIP_DIR.has(e) || (dir === ROOT && SKIP_ROOT.has(e)) || SKIP_PATH.has(rel)) continue; yield* walk(f); continue; }
    if (!EXT.has(extname(e)) || SKIP_FILE.test(e) || SKIP_REL.has(rel)) continue;
    yield [f, rel];
  }
}

const bad = [];
for (const [f, rel] of walk(ROOT)) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(RE)) {
    if (/[\w&]/.test(text[m.index - 1] || '')) continue; // part of an identifier / HTML entity
    const ls = text.lastIndexOf('\n', m.index) + 1; const le = text.indexOf('\n', m.index);
    if (/color-ok/.test(text.slice(ls, le < 0 ? undefined : le))) continue; // project escape hatch: official third-party artwork
    const h = norm(m[1]);
    if (!ALLOWED.has(h) && !IGNORE.has(h)) bad.push(`${h}  ${rel}:${text.slice(0, m.index).split('\n').length}`);
  }
}
if (bad.length) {
  console.error(`✘ ${bad.length} colour literal(s) outside the palette (scripts/color/palette.mjs):`);
  for (const b of bad.slice(0, 60)) console.error('  ' + b);
  console.error('\nUse a semantic token (bg-accent, text-on-accent, …). If the colour is genuinely new, add it to palette.mjs first.');
  process.exit(1);
}
console.log(`✔ palette purity: every colour literal in product code belongs to the palette (${ALLOWED.size} allowed values)`);
