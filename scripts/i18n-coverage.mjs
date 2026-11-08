#!/usr/bin/env node
/**
 * CI gate: locale coverage + integrity against src/i18n/locales.config.ts.
 *   node scripts/i18n-coverage.mjs [--json]
 * Fails (exit 1) when:
 *  - a covered namespace falls below the language's minCoverage,
 *  - a locale has keys that English does not (extra keys),
 *  - a value is empty, or {{placeholders}} / ICU-style {tokens} / <tags> differ from English,
 *  - a glossary rule is broken (doNotTranslate terms, forbiddenTerms).
 * Human-review-required keys missing from docs/i18n/reviewed-keys.json are reported as PENDING
 * and block only with --strict (use --strict as the release gate for tier-A surfaces).
 * Works on Node >= 18 (the .ts config is transpiled with the project's `typescript`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadTs } from './lib/load-ts.mjs';

const root = process.cwd();
const cfg = await loadTs(path.join(root, 'src/i18n/locales.config.ts'));
const { LOCALES, LOCALE_CODES, requiredNamespaces, isHumanReviewRequired } = cfg;
const dir = path.join(root, 'src/locales');
const json = process.argv.includes('--json');

const flat = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
const load = (l, ns) => {
  const f = path.join(dir, l, `${ns}.json`);
  return fs.existsSync(f) ? new Map(flat(JSON.parse(fs.readFileSync(f, 'utf8')))) : null;
};
const tokens = (s) =>
  typeof s === 'string'
    ? [...s.matchAll(/\{\{\s*[\w.]+\s*\}\}|\{[\w.]+(?:,[^}]*)?\}|<\/?\w+\s*\/?>/g)].map((m) => m[0].replace(/\s+/g, '')).sort().join('|')
    : '';

const namespaces = fs.readdirSync(path.join(dir, 'en')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
const reviewedFile = path.join(root, 'docs/i18n/reviewed-keys.json');
const reviewed = fs.existsSync(reviewedFile) ? JSON.parse(fs.readFileSync(reviewedFile, 'utf8')) : {};

const problems = [];
const pending = [];
const glossary = fs.existsSync(path.join(root, 'docs/i18n/glossary.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'docs/i18n/glossary.json'), 'utf8')) : {};
const strict = process.argv.includes('--strict');
const report = [];
for (const code of LOCALE_CODES) {
  if (code === 'en') continue;
  const c = LOCALES[code];
  for (const ns of requiredNamespaces(code, namespaces)) {
    const en = load('en', ns);
    const tr = load(code, ns);
    if (!tr) { problems.push(`${code}/${ns}: file missing (required by tier ${c.tier})`); report.push({ code, ns, coverage: 0 }); continue; }
    let present = 0;
    for (const [k, v] of en) {
      const t = tr.get(k);
      if (t === undefined) continue;
      present++;
      if (typeof t === 'string' && t.trim() === '') problems.push(`${code}/${ns}:${k} empty value`);
      else if (tokens(t) !== tokens(v)) problems.push(`${code}/${ns}:${k} placeholder/tag mismatch (en: ${tokens(v) || '-'} | ${code}: ${tokens(t) || '-'})`);
      if (typeof t === 'string' && typeof v === 'string') {
        for (const term of glossary.doNotTranslate ?? []) if (new RegExp(`\\b${term}\\b`).test(v) && !t.includes(term)) problems.push(`${code}/${ns}:${k} glossary: "${term}" must stay untranslated`);
        for (const bad of glossary.forbiddenTerms?.[code] ?? []) if (t.toLowerCase().includes(bad.toLowerCase())) problems.push(`${code}/${ns}:${k} forbidden term "${bad}" (see glossary)`);
      }
      if (isHumanReviewRequired(`${ns}.${k}`) && !(reviewed[code] ?? []).includes(`${ns}.${k}`)) pending.push(`${code}/${ns}:${k} awaiting human review sign-off (docs/i18n/reviewed-keys.json)`);
    }
    // CLDR plural categories English lacks (zero/two/few/many) are legitimate extras when the English _other exists.
    const pluralExtra = (k) => /_(zero|two|few|many)$/.test(k) && en.has(k.replace(/_(zero|two|few|many)$/, '_other'));
    for (const k of tr.keys()) if (!en.has(k) && !pluralExtra(k)) problems.push(`${code}/${ns}:${k} extra key (not in English)`);
    const coverage = en.size ? present / en.size : 1;
    report.push({ code, ns, coverage: Number(coverage.toFixed(3)), missing: en.size - present });
    if (coverage < c.minCoverage) problems.push(`${code}/${ns}: coverage ${(coverage * 100).toFixed(1)}% < required ${(c.minCoverage * 100).toFixed(0)}% (tier ${c.tier})`);
  }
}
if (strict) problems.push(...pending.map((p) => `[strict] ${p}`));
if (json) console.log(JSON.stringify({ report, problems, pending }, null, 2));
else {
  console.table(report.filter((r) => r.missing));
  console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\ni18n coverage gate: OK');
  if (pending.length && !strict) console.log(`\n${pending.length} key(s) awaiting human review sign-off (blocking only with --strict, the release gate):\n- ${pending.join('\n- ')}`);
}
process.exit(problems.length ? 1 : 0);
