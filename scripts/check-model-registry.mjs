#!/usr/bin/env node
// CI gate: fails when a model-like string literal is not registered in
// supabase/functions/_shared/ai-models.ts, or when the registry is internally inconsistent.
//   node scripts/check-model-registry.mjs
// Change process: docs/runbooks/model-change.md
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  REGISTRY_PATH, parseRegisteredIds, checkRegistryIntegrity, parseModelKeys, parseEntries, checkLifecycle,
  scanSource, scanYaml, scanHardcodedRegistered, isExempt, isScannableSource, isScannableYaml,
} from './lib/modelRegistryScan.mjs';

const ROOTS = ['supabase/functions', 'src', 'scripts', '.github/workflows'];

function* walk(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const registryText = readFileSync(REGISTRY_PATH, 'utf8');
const registered = parseRegisteredIds(registryText);
const problems = checkRegistryIntegrity(registryText);
const idToKey = parseModelKeys(registryText);
const keys = new Map([...idToKey].map(([id, k]) => [k, id]));
// MODEL_REGISTRY_TODAY=YYYY-MM-DD is only for tests.
const today = process.env.MODEL_REGISTRY_TODAY ? new Date(process.env.MODEL_REGISTRY_TODAY) : new Date();
const lifecycle = checkLifecycle(parseEntries(registryText), keys, registered, today);
problems.push(...lifecycle.errors);
for (const w of lifecycle.warnings) console.warn(`warning: ${w}`);

const offenders = [];
const hardcoded = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = relative('.', file).split(sep).join('/');
    if (isExempt(rel)) continue;
    const text = readFileSync(file, 'utf8');
    if (isScannableSource(rel)) {
      offenders.push(...scanSource(text, rel, registered));
      hardcoded.push(...scanHardcodedRegistered(text, rel, idToKey));
    }
    else if (isScannableYaml(rel)) offenders.push(...scanYaml(text, rel, registered));
  }
}

if (problems.length || offenders.length || hardcoded.length) {
  for (const p of problems) console.error(`registry: ${p}`);
  if (offenders.length) {
    console.error('Unregistered model strings (register in supabase/functions/_shared/ai-models.ts and follow docs/runbooks/model-change.md):');
    for (const o of offenders) console.error(`  ${o.file}:${o.line}  "${o.model}"`);
  }
  if (hardcoded.length) {
    console.error('Registered model ids must come from the registry (MODELS.<KEY> in edge code, registryModelId("<KEY>") in scripts):');
    for (const o of hardcoded) console.error(`  ${o.file}:${o.line}  "${o.model}" -> ${o.key}`);
  }
  process.exit(1);
}
console.log(`ok: ${registered.size} registered models, 0 unregistered model strings.`);
