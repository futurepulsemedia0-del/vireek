// One-off codemod: replaces `window.location.origin` with `getPublicOrigin()` in src/
// (so shared links work from the native app) and adds the import. Safe to re-run.
// Usage: node scripts/codemod-app-origin.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src';
const SKIP = new Set(['src/lib/appOrigin.ts', 'src/lib/appOrigin.test.ts']);
const IMPORT_LINE = "import { getPublicOrigin } from '@/lib/appOrigin';\n";
const changed = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name).replaceAll('\\', '/');
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !SKIP.has(p)) patch(p);
  }
}

function patch(path) {
  const src = readFileSync(path, 'utf8');
  if (!src.includes('window.location.origin')) return;
  let out = src.replaceAll('window.location.origin', 'getPublicOrigin()');
  if (!out.includes("from '@/lib/appOrigin'")) {
    const m = out.match(/^import .*$/m);
    out = m ? out.slice(0, m.index) + IMPORT_LINE + out.slice(m.index) : IMPORT_LINE + out;
  }
  writeFileSync(path, out);
  changed.push(path);
}

walk(ROOT);
console.log(changed.length ? `Updated ${changed.length} file(s):\n${changed.join('\n')}` : 'Nothing to change.');
