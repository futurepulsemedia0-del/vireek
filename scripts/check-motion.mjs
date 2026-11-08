#!/usr/bin/env node
// scripts/check-motion.mjs — motion policy guard (CI: `npm run lint:motion`).
//   node scripts/check-motion.mjs            check against the ratchet baseline (fails on any NEW violation)
//   node scripts/check-motion.mjs --write    lower the baseline to the current counts (refuses to raise it)
//   node scripts/check-motion.mjs --report   print the audit table (counts per rule / per animate-* class)
// Policy: docs/design/MOTION_POLICY.md. The CSS layer (src/styles/motion.css) neutralises animate-* globally,
// so the guard targets what CSS cannot fix: transition-all, JS smooth scroll, unpausable loops, framer loops.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const BASELINE = join(ROOT, 'scripts/motion/baseline.json');
const args = new Set(process.argv.slice(2));

// Live user-started media (camera preview, video call, live copilot) is essential, not decorative: exempt from the autoplay rule.
const ESSENTIAL_MEDIA = ['src/components/quotes/QuoteVideoCapture.tsx', 'src/components/video/VideoCallRoom.tsx', 'src/components/video/VideoLobby.tsx', 'src/pages/LiveCopilotPage.tsx'];
const GUARD = /useMotionLoop|usePrefersReducedMotion|useReducedMotion|MotionPauseButton|data-motion-essential|motion-reduce:/;
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules') walk(p); } else files.push(p);
  }
})(SRC);

const isCode = (f) => ['.ts', '.tsx'].includes(extname(f)) && !/\.test\.tsx?$/.test(f);
/** @type {Record<string, number>} key "rule|file" -> count */
const found = {};
const add = (rule, file, n = 1) => { if (n > 0) found[`${rule}|${relative(ROOT, file)}`] = (found[`${rule}|${relative(ROOT, file)}`] ?? 0) + n; };
const count = (re, s) => (s.match(re) ?? []).length;
const classCounts = {};
let framerFiles = 0, rmFiles = 0, animateTotal = 0;

for (const f of files) {
  const ext = extname(f);
  if (!['.ts', '.tsx', '.css'].includes(ext)) continue;
  const s = readFileSync(f, 'utf8');
  if (isCode(f)) {
    for (const m of s.matchAll(/animate-[a-z0-9-]+/g)) { classCounts[m[0]] = (classCounts[m[0]] ?? 0) + 1; animateTotal++; }
    if (/framer-motion/.test(s)) framerFiles++;
    if (/prefers-reduced-motion|useReducedMotion|usePrefersReducedMotion|motion-reduce:|useMotionLoop/.test(s)) rmFiles++;
    if (!/src\/lib\/motionPolicy\.ts$/.test(f)) {
      add('transition-all', f, count(/(^|[^\w-])transition-all(?![\w-])/g, s));
      add('js-smooth-scroll', f, count(/behavior\s*:\s*['"]smooth['"]/g, s));
    }
    if (/animate-marquee/.test(s) && !/useMotionLoop|MotionPauseButton/.test(s)) add('marquee-without-pause-control', f);
    if (/repeat\s*:\s*Infinity/.test(s) && !GUARD.test(s)) add('framer-infinite-without-reduced-path', f);
    if (/reducedMotion\s*=\s*["{']never/.test(s)) add('motionconfig-never', f);
    if (/<video[^>]*\bautoPlay\b/.test(s) && !GUARD.test(s) && !ESSENTIAL_MEDIA.includes(relative(ROOT, f))) add('autoplay-video-without-reduced-path', f);
  }
}

// Policy integrity (never baselined)
const policy = [];
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);
const motionCss = read('src/styles/motion.css');
if (!motionCss) policy.push('src/styles/motion.css is missing');
else if (!motionCss.includes("[data-motion='reduce']")) policy.push("motion.css must key off html[data-motion='reduce']");
for (const p of ['src/index.css', 'src/styles/a11y.css']) {
  const c = read(p);
  if (c && /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*|\.a11y-reduce-motion \*/.test(c)) policy.push(`${p}: duplicate blanket reduced-motion rule — keep the policy only in motion.css`);
}
const ctx = read('src/contexts/AccessibilityContext.tsx');
if (!ctx || !/<MotionConfig reducedMotion=/.test(ctx)) policy.push('AccessibilityContext must wrap the app in <MotionConfig reducedMotion=...>');

const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const byRule = {};
for (const [k, n] of Object.entries(found)) { const r = k.split('|')[0]; byRule[r] = (byRule[r] ?? 0) + n; }

if (args.has('--report')) {
  console.log('| Metric | Count |\n|---|---|');
  console.log(`| animate-* utilities | ${animateTotal} |`);
  for (const [c, n] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) console.log(`| ${c} | ${n} |`);
  console.log(`| files using framer-motion | ${framerFiles} |`);
  console.log(`| files with any reduced-motion path | ${rmFiles} |`);
  for (const [r, n] of Object.entries(byRule)) console.log(`| violation: ${r} | ${n} |`);
  console.log(`| policy integrity problems | ${policy.length} |`);
  process.exit(0);
}

if (args.has('--write')) {
  const raised = Object.entries(found).filter(([k, n]) => n > (base[k] ?? 0));
  if (raised.length && existsSync(BASELINE)) { console.error('Refusing to raise the baseline:\n' + raised.map(([k]) => '  ' + k).join('\n')); process.exit(1); }
  writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(found).sort()), null, 2) + '\n');
  console.log(`baseline written: ${Object.keys(found).length} entries, ${Object.values(found).reduce((a, b) => a + b, 0)} violations`);
  process.exit(0);
}

const fresh = Object.entries(found).filter(([k, n]) => n > (base[k] ?? 0));
for (const [k, n] of fresh) { const [r, f] = k.split('|'); console.error(`✗ ${f}: ${r} (${n}${base[k] ? `, baseline ${base[k]}` : ''})`); }
for (const p of policy) console.error(`✗ policy: ${p}`);
if (fresh.length || policy.length) { console.error('\nSee docs/design/MOTION_POLICY.md. Fix, or (for a justified legacy case) never raise the baseline.'); process.exit(1); }
console.log(`motion guard OK — ${Object.values(found).reduce((a, b) => a + b, 0)} baselined violations remain (ratchet only goes down).`);
