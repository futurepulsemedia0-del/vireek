// scripts/a11y/mobile-debt.mjs — static mobile-debt counter (no browser needed).
// Usage: node scripts/a11y/mobile-debt.mjs [--json]
// Prints counts that can be compared before/after a mobile pass. Static only: it does NOT measure rendered layout.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = 'src';
const EXT = new Set(['.tsx', '.ts', '.css']);
const SKIP = /(\.test\.|\.spec\.|[\\/]test[\\/]|[\\/]locales[\\/])/;

const RULES = {
  'vh-units (min-h-screen/h-screen/100vh)': /\b(?:min-h-screen|h-screen|max-h-screen)\b|\b100vh\b/g,
  'arbitrary-vh (e.g. max-h-[90vh])': /\[(?:\d+)vh\]/g,
  'dvh/svh/lvh': /\b\d*(?:dvh|svh|lvh)\b/g,
  'safe-area-inset': /safe-area-inset/g,
  'tiny-text text-[9..11px]': /text-\[(?:9|10|11)px\]/g,
  'touch-target 44/48px (min-h/min-w/h-11/h-12)': /\b(?:min-[hw]-\[(?:44|48)px\]|min-[hw]-(?:11|12)|h-11|h-12)\b/g,
  'overflow-x-auto': /overflow-x-auto/g,
  'hover: classes': /(?<![\w-])hover:/g,
  'hover media guard': /@media\s*\(\s*hover\s*:\s*hover\s*\)/g,
  'visualViewport usage': /visualViewport/g,
};

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (EXT.has(extname(p)) && !SKIP.test(p)) yield p;
  }
}

const totals = Object.fromEntries(Object.keys(RULES).map((k) => [k, 0]));
const perFile = {};
let files = 0;
for (const f of walk(ROOT)) {
  files++;
  const src = readFileSync(f, 'utf8');
  for (const [k, re] of Object.entries(RULES)) {
    const n = (src.match(re) ?? []).length;
    if (n) {
      totals[k] += n;
      if (k.startsWith('tiny-text')) perFile[f] = n;
    }
  }
}
const top = Object.entries(perFile).sort((a, b) => b[1] - a[1]).slice(0, 10);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ files, totals, topTinyText: top }, null, 2));
} else {
  console.log(`files scanned: ${files}`);
  for (const [k, v] of Object.entries(totals)) console.log(String(v).padStart(7), ' ', k);
  console.log('\nTop tiny-text files:');
  for (const [f, n] of top) console.log(String(n).padStart(5), ' ', f);
}
