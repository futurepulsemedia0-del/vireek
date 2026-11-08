#!/usr/bin/env node
/**
 * Translation freshness: detects translations whose English source changed after they were
 * last accepted. State lives in docs/i18n/translation-state.json ({lang:{"ns:key": sourceHash}}).
 *
 *   node scripts/i18n-freshness.mjs                 report; exit 1 if a stale key sits on a surface
 *                                                   the language covers AND the language is tier A
 *   node scripts/i18n-freshness.mjs --strict        exit 1 on ANY stale key in any covered surface
 *   node scripts/i18n-freshness.mjs --init          baseline: record current English hashes for all
 *                                                   existing translations (ASSUMES they are in sync)
 *   node scripts/i18n-freshness.mjs --accept es     after a reviewer updated `es`, record current hashes
 * Node >= 18.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadTs } from './lib/load-ts.mjs';

const root = process.cwd();
const { LOCALES, LOCALE_CODES, requiredNamespaces } = await loadTs(path.join(root, 'src/i18n/locales.config.ts'));
const dir = path.join(root, 'src/locales');
const stateFile = path.join(root, 'docs/i18n/translation-state.json');
const args = process.argv.slice(2);
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
const hash = (v) => crypto.createHash('sha1').update(String(v)).digest('hex').slice(0, 8);
const read = (l, ns) => {
  const f = path.join(dir, l, `${ns}.json`);
  return fs.existsSync(f) ? new Map(flat(JSON.parse(fs.readFileSync(f, 'utf8')))) : new Map();
};
const namespaces = fs.readdirSync(path.join(dir, 'en')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const save = () => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`); };

function snapshot(code) {
  const out = {};
  for (const ns of namespaces) {
    const en = read('en', ns), tr = read(code, ns);
    for (const [k, v] of en) if (tr.has(k)) out[`${ns}:${k}`] = hash(v);
  }
  return out;
}

const targets = LOCALE_CODES.filter((c) => c !== 'en');
if (args.includes('--init')) { for (const c of targets) state[c] = snapshot(c); save(); console.log('baseline written (assumes current translations match current English)'); process.exit(0); }
const ai = args.indexOf('--accept');
if (ai !== -1) { const c = args[ai + 1]; if (!targets.includes(c)) { console.error('unknown language'); process.exit(2); } state[c] = snapshot(c); save(); console.log(`accepted current English hashes for ${c}`); process.exit(0); }

const strict = args.includes('--strict');
let fail = false;
for (const c of targets) {
  const cfg = LOCALES[c];
  const covered = new Set(requiredNamespaces(c, namespaces));
  let stale = 0, untracked = 0;
  const examples = [];
  for (const ns of namespaces) {
    const en = read('en', ns), tr = read(c, ns);
    for (const [k, v] of en) {
      if (!tr.has(k)) continue;
      const rec = state[c]?.[`${ns}:${k}`];
      if (rec === undefined) { untracked++; continue; }
      if (rec !== hash(v)) { stale++; if (covered.has(ns) && examples.length < 5) examples.push(`${ns}:${k}`); if (covered.has(ns) && (strict || cfg.tier === 'A')) fail = true; }
    }
  }
  console.log(`${c} (tier ${cfg.tier}): stale=${stale} untracked=${untracked}${examples.length ? ` e.g. ${examples.join(', ')}` : ''}`);
}
if (fail) { console.error('\nSTALE translations on covered surfaces block release.'); process.exit(1); }
console.log('\nfreshness gate: OK');
