// Guards docs/compliance/insurance-program.md against the failure modes that matter:
// claiming coverage exists, inventing amounts, citing files that do not exist.
// Run: node --test scripts/compliance/insurance-program.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_PATH = 'docs/compliance/insurance-program.md';
const doc = readFileSync(resolve(ROOT, DOC_PATH), 'utf8');

test('document states that it does not assert any coverage', () => {
  assert.match(doc, /does NOT state that Vireek holds, has bound, has applied for, or has been quoted any insurance/);
});

test('no affirmative coverage claims', () => {
  const banned = [
    /\bVireek (is|are|was) (fully )?(insured|covered)\b/i,
    /\bwe (are|have been) (fully )?insured\b/i,
    /\bVireek (holds|carries|maintains|has) (a |an )?(active |current )?(cyber|E&O|errors|general liability|GL|tech)[^.\n|]{0,40}(polic|coverage|insurance)/i,
    /\bcoverage (is|has been) (in force|bound|active)\b/i,
  ];
  for (const re of banned) assert.doesNotMatch(doc, re, `matched ${re}`);
});

test('no invented amounts: no currency figures anywhere', () => {
  assert.doesNotMatch(doc, /(\$|USD|EUR|€|£)\s?\d/i);
  assert.doesNotMatch(doc, /\b\d+\s?(million|M)\b\s*(limit|aggregate|per claim)/i);
});

test('policy register stays empty until a declarations page exists', () => {
  const section = doc.split('### 1.2 Policy register')[1]?.split('\n---')[0] ?? '';
  const rows = section.split('\n').filter((l) => /^\|\s*(Cyber|Tech E&O|GL)\s*\|/.test(l));
  assert.equal(rows.length, 3);
  for (const r of rows) {
    const cells = r.split('|').slice(2, -1).map((c) => c.replace(/`/g, '').trim());
    for (const c of cells) assert.ok(['—', 'none', '[COUNSEL]'].includes(c), `non-empty register cell: ${c}`);
  }
});

test('required sections and tags are present', () => {
  for (const h of [
    '## 1. Coverage types to discuss with a broker',
    '## 2. Underwriting questionnaire answer sheet',
    '## 3. Evidence index',
    '## 4. Gaps list',
  ]) assert.ok(doc.includes(h), `missing heading ${h}`);
  for (const t of ['[COUNSEL]', '[VERIFY]', '[R]', '[V]', '[N]', '[P]']) assert.ok(doc.includes(t), `missing tag ${t}`);
  for (const k of ['MFA', 'ackup', 'ncident', 'endor']) assert.ok(doc.includes(k), `missing topic ${k}`);
});

test('every cited repo path exists, except those declared as not present', () => {
  const notPresentParagraph = doc.split('**Referenced by existing docs but not present in the snapshot**')[1]?.split('\n---')[0] ?? '';
  const allowMissing = new Set(
    [...notPresentParagraph.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((p) => /\//.test(p)),
  );
  const cited = new Set();
  for (const m of doc.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1].replace(/[,.;:]+$/, '');
    if (/^(docs|src|supabase|public|scripts|\.github)\//.test(p) || /^(RUNBOOK|SECURITY)\.md$/.test(p)) cited.add(p);
  }
  assert.ok(cited.size > 25, 'expected many evidence citations');
  const missing = [...cited].filter((p) => !existsSync(resolve(ROOT, p)) && !allowMissing.has(p));
  assert.deepEqual(missing, []);
});

test('every answer-sheet row carries an evidence tag or [COUNSEL]/[VERIFY]', () => {
  const sheet = doc.split('## 2. Underwriting questionnaire answer sheet')[1]?.split('\n## 3.')[0] ?? '';
  const rows = sheet.split('\n').filter((l) => /^\|\s*[A-I]\d+\s*\|/.test(l));
  assert.ok(rows.length >= 40, `expected >=40 rows, got ${rows.length}`);
  for (const r of rows) assert.match(r, /\[(R|P|V|N|COUNSEL|VERIFY)\]/, `untagged row: ${r.slice(0, 60)}`);
});
