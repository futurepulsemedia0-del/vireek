#!/usr/bin/env node
// scripts/design/ai-tells.mjs
//
// "AI-tell" scorecard. Counts the visual/copy habits that make a UI read as
// generated, for (a) the whole src/ tree and (b) the dashboard scope.
//
//   node scripts/design/ai-tells.mjs            # print table
//   node scripts/design/ai-tells.mjs --json     # machine-readable
//   node scripts/design/ai-tells.mjs --check    # fail if DASHBOARD scope exceeds thresholds
//   node scripts/design/ai-tells.mjs --update   # lower the ratchet baseline (never raises it)
//
// Thresholds live in scripts/design/ai-tells.baseline.json. The check is a
// ratchet: a count may go down, never up. Dashboard-scope targets for
// gradients / backdrop-blur / sparkle icons are 0 and are enforced as such
// once a file is migrated (list it in `migrated` in the baseline).

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const BASELINE = join(ROOT, 'scripts/design/ai-tells.baseline.json');

/** Paths (relative to repo root, prefix match) that make up "the dashboard". */
export const DASHBOARD_SCOPE = [
  'src/pages/DashboardPage.tsx',
  'src/components/overview/',
  'src/pages/CallsPage.tsx',
  'src/pages/LiveCallsPage.tsx',
  'src/pages/JobsPage.tsx',
  'src/pages/CustomersPage.tsx',
  'src/pages/AnalyticsPage.tsx',
  'src/pages/BillingPage.tsx',
  'src/pages/SettingsPage.tsx',
  'src/components/DashboardNav.tsx',
];

const ICON_NAMES = '(?:Sparkles|Sparkle|Bot|Brain|BrainCircuit|Wand2|WandSparkles)';
export const TELLS = {
  decorativeAiIcons: { re: new RegExp(`\\b${ICON_NAMES}\\b`, 'g'), label: 'Sparkles/Bot/Brain icon refs' },
  gradients: { re: /bg-gradient-|\b(?:from|via|to)-(?:accent|cta|bg|text|success|warning|danger|brand)[\w/-]*|linear-gradient|radial-gradient/g, label: 'gradients' },
  backdropBlur: { re: /backdrop-blur/g, label: 'backdrop-blur' },
  glow: { re: /shadow-glow-[\w-]+|\bblur-(?:sm|md|lg|xl|2xl|3xl)\b/g, label: 'glow / blur effects' },
  largeRadii: { re: /rounded-(?:2xl|3xl)\b/g, label: 'rounded-2xl/3xl' },
  blanketBold: { re: /font-(?:bold|extrabold|black)\b/g, label: 'font-bold/extrabold/black' },
  skeletonPulse: { re: /animate-pulse/g, label: 'animate-pulse' },
  hypeCopy: { re: /\b(?:Unlock|Supercharge|Supercharged|AI-powered|Revolutioni[sz]e|Seamless(?:ly)?)\b/g, label: 'hype copy' },
  exclamations: { re: />\s*[A-Z][^<>{}\n]{3,60}!\s*</g, label: 'exclamation-mark JSX copy' },
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules') continue;
    const full = join(dir, e);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (extname(e) === '.tsx' && !/\.(test|spec)\.tsx$/.test(e)) out.push(full);
  }
  return out;
}

const inScope = (rel) => DASHBOARD_SCOPE.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));

export function scan() {
  const all = {};
  const dash = {};
  const perFile = {};
  for (const k of Object.keys(TELLS)) { all[k] = { uses: 0, files: new Set() }; dash[k] = { uses: 0, files: new Set() }; }
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');
    for (const [k, { re }] of Object.entries(TELLS)) {
      const n = (text.match(re) ?? []).length;
      if (!n) continue;
      all[k].uses += n; all[k].files.add(rel);
      if (inScope(rel)) { dash[k].uses += n; dash[k].files.add(rel); (perFile[rel] ??= {})[k] = n; }
    }
  }
  const flat = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { uses: v.uses, files: v.files.size }]));
  return { repo: flat(all), dashboard: flat(dash), perFile };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const result = scan();
  if (args.has('--json')) { console.log(JSON.stringify(result, null, 2)); return; }

  const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('tell', 34)}${pad('repo uses', 12)}${pad('repo files', 12)}${pad('dash uses', 12)}dash files`);
  for (const [k, { label }] of Object.entries(TELLS)) {
    console.log(`${pad(label, 34)}${pad(result.repo[k].uses, 12)}${pad(result.repo[k].files, 12)}${pad(result.dashboard[k].uses, 12)}${result.dashboard[k].files}`);
  }

  if (args.has('--update')) {
    const next = { dashboard: {}, migrated: base?.migrated ?? [] };
    for (const k of Object.keys(TELLS)) next.dashboard[k] = Math.min(result.dashboard[k].uses, base?.dashboard?.[k] ?? Infinity);
    writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n');
    console.log(`\nBaseline written (ratchet only lowers): ${relative(ROOT, BASELINE)}`);
    return;
  }

  if (args.has('--check')) {
    if (!base) { console.error('\nNo baseline. Run with --update once.'); process.exit(1); }
    const bad = [];
    for (const k of Object.keys(TELLS)) {
      if (result.dashboard[k].uses > (base.dashboard[k] ?? 0)) bad.push(`${k}: ${result.dashboard[k].uses} > baseline ${base.dashboard[k] ?? 0}`);
    }
    // Migrated files must be at zero for the hard tells.
    for (const f of base.migrated ?? []) {
      const pf = result.perFile[f] ?? {};
      for (const k of ['decorativeAiIcons', 'gradients', 'backdropBlur', 'glow', 'largeRadii']) {
        if (pf[k]) bad.push(`${f}: ${k} = ${pf[k]} (migrated files must be 0)`);
      }
    }
    if (bad.length) { console.error('\nAI-tell scorecard FAILED:\n - ' + bad.join('\n - ')); process.exit(1); }
    console.log('\nAI-tell scorecard OK.');
  }
}

if (process.argv[1] && process.argv[1].endsWith('ai-tells.mjs')) main();
