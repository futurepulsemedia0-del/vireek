#!/usr/bin/env node
/**
 * Idempotent, additive JSON merge for locale files.
 *   node scripts/i18n-apply-patch.mjs                       apply every docs/i18n/patches/*.json
 *   node scripts/i18n-apply-patch.mjs path/to/patch.json    apply one
 * Patch format: { "file": "src/locales/es/dashboard.json", "merge": { ...nested keys... } }
 * Existing keys are NEVER overwritten (it only adds missing ones); key order of the file is kept;
 * output uses 2-space indent + trailing newline like the existing locale files.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = 'docs/i18n/patches';
const files = process.argv[2] ? [process.argv[2]] : fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
const add = (dst, src, trail, added) => {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object') { if (typeof dst[k] !== 'object' || dst[k] === null) { if (k in dst) throw new Error(`type clash at ${[...trail, k].join('.')}`); dst[k] = {}; } add(dst[k], v, [...trail, k], added); }
    else if (!(k in dst)) { dst[k] = v; added.push([...trail, k].join('.')); }
  }
};
for (const f of files) {
  const { file, merge } = JSON.parse(fs.readFileSync(f, 'utf8'));
  const target = JSON.parse(fs.readFileSync(file, 'utf8'));
  const added = [];
  add(target, merge, [], added);
  if (added.length) fs.writeFileSync(file, `${JSON.stringify(target, null, 2)}\n`);
  console.log(`${file}: +${added.length} key(s)`);
}
