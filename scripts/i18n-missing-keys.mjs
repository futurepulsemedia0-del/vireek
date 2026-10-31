#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  Missing-translation report (CI)                                     */
/*                                                                      */
/*  Scans files that use react-i18next for literal t('key') calls and   */
/*  compares them with the English locale files.                        */
/*   FAIL  key used, not in English, and no defaultValue  → users would */
/*         see the raw key.                                              */
/*   FAIL  a locale file is missing keys that English has (namespaces   */
/*         that exist in that locale).                                   */
/*   WARN  key used with a defaultValue but absent from locale files    */
/*         (renders English everywhere — translate it when you can).    */
/*  Runtime fallback stays: fallbackLng 'en' + defaultValue.            */
/*  Template-literal keys cannot be checked statically (count shown).   */
/* ------------------------------------------------------------------ */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const LOCALES = join(ROOT, 'src/locales');
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [p ? `${p}.${k}` : k] : flat(v, p ? `${p}.${k}` : k)));
const load = (lang, ns) => {
  const f = join(LOCALES, lang, `${ns}.json`);
  return existsSync(f) ? new Set(flat(JSON.parse(readFileSync(f, 'utf8')))) : null;
};
// i18next treats key_one/key_other/... as plural variants of `key`.
const hasKey = (set, key) => set.has(key) || ['_one', '_other', '_zero', '_two', '_few', '_many'].some((s) => set.has(key + s));

const langs = readdirSync(LOCALES).filter((l) => statSync(join(LOCALES, l)).isDirectory());
const namespaces = [...new Set(readdirSync(join(LOCALES, 'en')).map((f) => f.replace('.json', '')))];
const en = Object.fromEntries(namespaces.map((ns) => [ns, load('en', ns)]));

const failures = [];
const warnings = [];

// 1. Locale parity (every namespace a locale ships must be complete)
for (const lang of langs.filter((l) => l !== 'en')) {
  for (const ns of namespaces) {
    const other = load(lang, ns);
    if (!other) continue;
    const missing = [...en[ns]].filter((k) => !other.has(k));
    if (missing.length) failures.push(`${lang}/${ns}.json is missing ${missing.length} key(s), e.g. ${missing.slice(0, 3).join(', ')}`);
  }
}

// 2. Keys used in code
function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { if (e !== 'node_modules') yield* walk(full); }
    else if (['.ts', '.tsx'].includes(extname(e)) && !/\.test\.tsx?$/.test(e)) yield full;
  }
}
let used = 0;
let dynamic = 0;
let skipped = 0;
for (const file of walk(join(ROOT, 'src'))) {
  const src = readFileSync(file, 'utf8');
  if (!/from 'react-i18next'/.test(src)) continue;
  const rel = relative(ROOT, file).split(sep).join('/');
  const hook = src.match(/useTranslation\(\s*([^)]*)\)/);
  const defaultNs = hook && hook[1].match(/^(?:'([\w-]+)'|\[\s*'([\w-]+)')/);
  if (hook && hook[1].trim() && !defaultNs) { skipped++; continue; } // namespace is a variable/constant: not statically checkable
  const ns0 = (defaultNs && (defaultNs[1] || defaultNs[2])) || 'common';
  dynamic += (src.match(/\bt\(\s*`/g) ?? []).length;
  for (const m of src.matchAll(/\bt\(\s*'([\w.:-]+)'([^)]{0,200})/g)) {
    used++;
    let [ns, key] = m[1].includes(':') ? m[1].split(':') : [ns0, m[1]];
    const line = src.slice(0, m.index).split('\n').length;
    const withDefault = /defaultValue|,\s*['"`]/.test(m[2]);
    if (en[ns] && hasKey(en[ns], key)) continue;
    (withDefault ? warnings : failures).push(`${rel}:${line}  ${ns}:${key}${withDefault ? '  (has defaultValue)' : '  (NO default — users would see the raw key)'}`);
  }
}

console.log(`i18n keys: ${used} literal t() calls checked, ${dynamic} template-literal keys and ${skipped} file(s) with a non-literal namespace not statically checkable.`);
if (warnings.length) {
  console.log(`\n${warnings.length} key(s) rely on defaultValue and are missing from the locale files (English fallback everywhere):`);
  warnings.slice(0, 15).forEach((w) => console.log('  warn ' + w));
  if (warnings.length > 15) console.log(`  …and ${warnings.length - 15} more`);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Untranslated keys::${warnings.length} t() keys have no locale entry (they fall back to defaultValue).`);
}
if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  failures.forEach((f) => console.error('  FAIL ' + f));
  process.exit(1);
}
console.log('i18n key check OK (no raw keys can reach users).');
