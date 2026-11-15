// Guards docs/compliance/internal-audit-program.md: it must never imply an audit happened,
// must stay in sync with the control registry, and must cite only things that exist.
// Run: node --test scripts/compliance/internal-audit-program.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const doc = readFileSync(resolve(ROOT, 'docs/compliance/internal-audit-program.md'), 'utf8');
const registry = JSON.parse(readFileSync(resolve(ROOT, 'docs/compliance/soc2/controls.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const ids = registry.controls.map((c) => c.id);
const section = (n) => doc.split(new RegExp(`^## ${n}\\. `, 'm'))[1]?.split(/^## \d+\. /m)[0] ?? '';
const idsIn = (t) => [...t.matchAll(/\b[A-Z]{3}-\d{2}\b/g)].map((m) => m[0]);

test('states that no audit has occurred', () => {
  assert.match(doc, /No internal audit cycle has been planned, started or completed/);
  assert.match(doc, /No audit report, attestation, certification or opinion exists/);
  assert.match(doc, /\| — \| not started \| not started \| none exists \| none held \|/);
});

test('no affirmative audit or compliance claims', () => {
  const banned = [
    /\b(we|Vireek) (have|has) (completed|passed|conducted|performed) (an?|the) (internal )?audit/i,
    /\bVireek is (SOC ?2|ISO ?27001)[- ]?(compliant|certified|audited)\b/i,
    /\baudit (was|has been) (completed|passed)\b/i,
    /\b(audit|review|assessment) (found|identified|noted) no (material )?(issues|findings|exceptions)\b/i,
    /\b(audit|review|assessment) (was )?(completed|passed) (successfully|with no)/i,
    /\bclean opinion\b/i,
  ];
  for (const re of banned) assert.doesNotMatch(doc, re, `matched ${re}`);
});

test('plan and scope each cover every registry control exactly once, and no unknown ids', () => {
  for (const [n, name] of [[2, 'plan'], [3, 'scope']]) {
    const found = idsIn(section(n));
    assert.deepEqual([...found].sort(), [...ids].sort(), `${name}: ids differ from registry`);
  }
  for (const id of new Set(idsIn(doc))) assert.ok(ids.includes(id), `unknown control id ${id}`);
});

test('findings register and cycle table stay empty until real events exist', () => {
  assert.match(doc, /\| — \| — \| — \| — \| — \| none recorded \|/);
});

test('required sections and tags are present', () => {
  for (const h of ['## 2. Annual plan', '## 3. Scope per control area', '## 4. Evidence sampling method', '## 6. Finding template', '## 7. Management review agenda']) {
    assert.ok(doc.includes(h), `missing ${h}`);
  }
  for (const t of ['[COUNSEL]', '[VERIFY]', '[FILL]']) assert.ok(doc.includes(t), `missing tag ${t}`);
});

test('every cited collector id exists in lib.mjs', () => {
  const lib = readFileSync(resolve(ROOT, 'scripts/compliance/lib.mjs'), 'utf8');
  for (const m of doc.matchAll(/`((?:repo|github|supabase|manual)\.[a-z_]+)`/g)) assert.ok(lib.includes(`'${m[1]}'`), `unknown collector ${m[1]}`);
});

test('every cited npm script exists', () => {
  for (const m of doc.matchAll(/npm run ([a-z:\-]+)/g)) assert.ok(pkg.scripts[m[1]], `npm script ${m[1]} missing`);
});

test('every cited repo path exists, except those declared as not present', () => {
  const declared = doc.split('**Referenced by the registry but not present in the snapshot**')[1]?.split('\n## ')[0] ?? '';
  const allow = new Set([...declared.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  const missing = [];
  for (const m of doc.matchAll(/`([^`\s]+\/[^`\s]*)`/g)) {
    const p = m[1].replace(/[.,;:]+$/, '');
    if (/^(https?:|node |npm )/.test(p) || p.includes('<') || p.includes('*') || allow.has(p)) continue;
    if (/\.(md|mjs|ts|tsx|json|yml|csv)$|\/$/.test(p) && !existsSync(resolve(ROOT, p))) missing.push(p);
  }
  assert.deepEqual(missing, []);
});
