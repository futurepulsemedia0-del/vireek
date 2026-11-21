#!/usr/bin/env node
// scripts/claims-gate/check-claims-gate.mjs   (npm run claims:gate)
//
// CI gate: every NUMERIC or COMPARATIVE claim in public copy and AI marketing outputs must map to an entry in
// docs/claims-register.json that has an evidence link, an owner and an expiry date that has not passed.
// Fails (exit 1) on: a claim with no entry · an entry whose evidence is incomplete or expired · a broken register.
//
//   node scripts/claims-gate/check-claims-gate.mjs [--now YYYY-MM-DD] [--json] [--list-sources]
//
// This gate complements `npm run claims:check` (src/lib/trust/claims.ts: certification / SLA / uptime wording).
// It does NOT verify that evidence is true: a human owner does that. See docs/compliance/claims-gate.md.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanText } from './detect.mjs';
import { evaluateDetections, validateRegister } from './register.mjs';
import {
  AI_OUTPUT_DIRS, AI_OUTPUT_FILES, BLOG_DIR, DATA_MODULES, MARKETING_DIRS, PUBLIC_TEXT_FILES, SCANNED_EXTS, SKIP,
  discoverPublicPageFiles,
} from './sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTER = 'docs/claims-register.json';
const posix = (p) => p.split(path.sep).join('/');
const abs = (rel) => path.join(ROOT, rel);

function* walk(rel) {
  if (!existsSync(abs(rel))) return;
  for (const e of readdirSync(abs(rel), { withFileTypes: true })) {
    const child = posix(path.join(rel, e.name));
    if (e.isDirectory()) { if (!['node_modules', 'dist', '.git'].includes(e.name)) yield* walk(child); } else yield child;
  }
}

function parseArgs(argv) {
  const a = { now: new Date(), json: false, listSources: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--now') {
      const v = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new Error('--now needs YYYY-MM-DD');
      a.now = new Date(`${v}T00:00:00Z`);
    } else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--list-sources') a.listSources = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return a;
}

async function collectSources() {
  const routes = await import('../seo/routes.mjs'); // single definition of which URLs are public
  const publicPaths = [...routes.STATIC_PUBLIC_PATHS, ...routes.DATA_ROUTE_PATTERNS, ...routes.PUBLIC_DYNAMIC_PATTERNS];
  const resolve = (mod) => ['.tsx', '.ts', '/index.tsx'].map((x) => `src/${mod}${x}`).find((f) => existsSync(abs(f))) ?? null;
  const pages = discoverPublicPageFiles({ appSrc: readFileSync(abs('src/App.tsx'), 'utf8'), publicPaths, resolve });

  const group = { public: new Set(pages.files), ai: new Set() };
  for (const d of MARKETING_DIRS) for (const f of walk(d)) group.public.add(f);
  for (const f of DATA_MODULES) if (existsSync(abs(f))) group.public.add(f);
  for (const f of PUBLIC_TEXT_FILES) if (existsSync(abs(f))) group.public.add(f);
  for (const f of walk(BLOG_DIR)) if (f.endsWith('.md')) group.public.add(f);
  for (const d of AI_OUTPUT_DIRS) for (const f of walk(d)) group.ai.add(f);
  for (const f of AI_OUTPUT_FILES) if (existsSync(abs(f))) group.ai.add(f);

  const keep = (f) => SCANNED_EXTS.includes(path.extname(f)) && !SKIP.some((r) => r.test(f));
  return {
    public: [...group.public].filter(keep).sort(),
    ai: [...group.ai].filter(keep).sort(),
    unresolvedPublicPaths: pages.unresolved,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = await collectSources();
  if (args.listSources) {
    console.log(JSON.stringify(src, null, 2));
    return;
  }

  let register;
  try {
    register = JSON.parse(readFileSync(abs(REGISTER), 'utf8'));
  } catch (e) {
    console.error(`[claims:gate] ${REGISTER} is missing or not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const reg = validateRegister(register, args.now);

  const detections = [];
  for (const [set, files] of [['public', src.public], ['ai', src.ai]]) {
    for (const file of files) {
      const text = readFileSync(abs(file), 'utf8');
      for (const h of scanText(text, path.extname(file))) detections.push({ ...h, file, set });
    }
  }
  const result = evaluateDetections(detections, register, args.now);

  if (args.json) {
    console.log(JSON.stringify({ registerErrors: reg.errors, warnings: reg.warnings, ...result, usedIds: [...result.usedIds] }, null, 2));
  } else {
    for (const e of reg.errors) console.error(`REGISTER  ${e}`);
    for (const v of result.violations) console.error(`CLAIM     ${v.file}:${v.line}  [${v.code}] ${v.message}`);
    for (const w of reg.warnings) console.warn(`warning   ${w}`);
    for (const id of result.unused) console.warn(`warning   register entry "${id}" matches no copy (remove it, or the wording changed)`);
    if (src.unresolvedPublicPaths.length) {
      console.warn(`note      ${src.unresolvedPublicPaths.length} public route(s) have no page file the gate could resolve (lazy/wrapper routes): ${src.unresolvedPublicPaths.slice(0, 8).join(', ')}${src.unresolvedPublicPaths.length > 8 ? ', …' : ''}`);
    }
    console.log(`[claims:gate] ${src.public.length} public + ${src.ai.length} AI-output file(s) scanned · ${detections.length} claim(s) detected · ${result.covered.length} covered, ${result.exempt.length} exempt, ${result.violations.length} violation(s), ${reg.errors.length} register error(s).`);
  }
  if (reg.errors.length || result.violations.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
