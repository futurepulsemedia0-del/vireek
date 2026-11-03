#!/usr/bin/env node
// scripts/check-claims.mjs — fails CI when public copy asserts a claim that the registry
// (src/lib/trust/claims.ts) does not mark as 'verified', or when the registry is inconsistent.
// Usage: npm run claims:check      (exit 1 on any problem)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'src/lib/trust/claims.ts';

// Public-facing sources. Tests and the registry itself are excluded.
const SCAN_DIRS = ['src/pages', 'src/components/sections', 'src/components/trust', 'src/lib', 'public', 'index.html'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.txt', '.html', '.md', '.xml']);
const SKIP = [/\.test\.tsx?$/, /\.built\.test\./, /src\/lib\/trust\/claims\.ts$/, /public\/sitemap[^/]*\.xml$/, /openapi\.json$/];

async function loadRegistry() {
  try {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
      entryPoints: [path.join(ROOT, REGISTRY)],
      bundle: true,
      format: 'esm',
      write: false,
      platform: 'node',
    });
    const dataUrl = 'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64');
    return await import(dataUrl);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    // esbuild unavailable: rely on Node's native TypeScript stripping (Node >= 22.18).
    return import(pathToFileURL(path.join(ROOT, REGISTRY)).href);
  }
}

function* walk(rel) {
  const abs = path.join(ROOT, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return;
  }
  if (st.isFile()) {
    yield rel;
    return;
  }
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name.startsWith('.git')) continue;
    yield* walk(path.posix.join(rel.split(path.sep).join('/'), name));
  }
}

const { CLAIMS, validateClaims, findClaimViolations } = await loadRegistry();
let failed = false;

for (const e of validateClaims(CLAIMS)) {
  console.error(`REGISTRY  ${e}`);
  failed = true;
}

let scanned = 0;
for (const dir of SCAN_DIRS) {
  for (const rel of walk(dir)) {
    if (!EXTENSIONS.has(path.extname(rel)) || SKIP.some((r) => r.test(rel))) continue;
    scanned += 1;
    for (const v of findClaimViolations(readFileSync(path.join(ROOT, rel), 'utf8'), CLAIMS)) {
      console.error(`CLAIM     ${rel}:${v.line}  [${v.claimId}] ${v.text}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('\nclaims:check FAILED — fix the copy, or update the claim in src/lib/trust/claims.ts with real evidence.');
  process.exit(1);
}
console.log(`claims:check OK — ${CLAIMS.length} claims, ${scanned} files scanned.`);
