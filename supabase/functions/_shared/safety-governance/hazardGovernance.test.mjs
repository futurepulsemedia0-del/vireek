// Run: node --experimental-strip-types --no-warnings --test supabase/functions/_shared/safety-governance/hazardGovernance.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HAZARD_DOMAINS, MAX_REVIEW_VALIDITY_DAYS, contentHash, decideUse, detectHazardDomains, entryTier, evaluateReview, gateEntriesForAi } from './hazardGovernance.ts';
import { ONTOLOGY_SEED } from '../vertical-ai/ontologySeed.ts';

const NOW = new Date('2029-03-11T10:00:00Z');
const rv = (o = {}) => ({ reviewer: 'Dana Reviewer', reviewerQualification: 'licensed gas fitter (test fixture)', reviewedOn: '2029-02-01', expiresOn: '2030-01-15', version: 1, ...o });

test('detects the four hazard domains and nothing else', () => {
  assert.deepEqual(detectHazardDomains('Check refrigerant pressures and superheat'), ['refrigerant']);
  assert.deepEqual(detectHazardDomains('If you smell gas leave. A CO alarm is sounding.'), ['gas', 'carbon_monoxide']);
  assert.deepEqual(detectHazardDomains('Reset the GFCI; sparking at the breaker panel'), ['electrical']);
  assert.deepEqual(detectHazardDomains('Replace the air filter every 3 months'), []);
  assert.deepEqual(detectHazardDomains(null), []);
  assert.deepEqual([...HAZARD_DOMAINS], ['gas', 'carbon_monoxide', 'electrical', 'refrigerant']);
});

test('review verdict matrix', () => {
  const cur = { version: 1 };
  assert.equal(evaluateReview(null, cur, NOW).status, 'unreviewed');
  assert.equal(evaluateReview(rv(), cur, NOW).status, 'approved');
  assert.equal(evaluateReview(rv({ expiresOn: '2029-03-11' }), cur, NOW).status, 'expired', 'expiry day itself is already expired');
  assert.equal(evaluateReview(rv({ expiresOn: '2029-03-12' }), cur, NOW).status, 'approved');
  assert.equal(evaluateReview(rv({ version: 2 }), cur, NOW).status, 'stale', 'content version moved on');
  for (const bad of [{ reviewer: '' }, { reviewer: 'ab' }, { reviewerQualification: '  ' }, { reviewedOn: '2029-02-30' }, { reviewedOn: 'yesterday' }, { expiresOn: '' }, { version: 0 }, { version: 1.5 }]) {
    assert.equal(evaluateReview(rv(bad), cur, NOW).status, 'invalid', JSON.stringify(bad));
  }
  assert.equal(evaluateReview(rv({ reviewedOn: '2029-04-01', expiresOn: '2029-12-01' }), cur, NOW).status, 'invalid', 'review dated in the future');
  assert.equal(evaluateReview(rv({ expiresOn: '2029-01-01' }), cur, NOW).status, 'invalid', 'expiry before review');
  const long = new Date(Date.parse('2029-02-01T00:00:00Z') + (MAX_REVIEW_VALIDITY_DAYS + 1) * 86400000).toISOString().slice(0, 10);
  assert.equal(evaluateReview(rv({ expiresOn: long }), cur, NOW).status, 'invalid', 'validity longer than the maximum');
});

test('review is bound to the exact text', () => {
  const h = contentHash('Never open the panel.');
  assert.equal(contentHash('Never   open the\npanel.'), h, 'whitespace-insensitive');
  assert.equal(evaluateReview(rv({ contentHash: h }), { version: 1, hash: h }, NOW).status, 'approved');
  assert.equal(evaluateReview(rv({ contentHash: h }), { version: 1, hash: contentHash('Open the panel.') }, NOW).status, 'stale');
  assert.equal(evaluateReview(rv(), { version: 1, hash: h }, NOW).status, 'stale', 'code-resident text requires a hash on the review');
});

test('tier decides use: floor and guardrail are never blocked, instructional is', () => {
  const unrev = evaluateReview(null, { version: 1 }, NOW);
  const ok = evaluateReview(rv(), { version: 1 }, NOW);
  assert.deepEqual(decideUse('floor', unrev).allow, true);
  assert.equal(decideUse('floor', unrev).mode, 'floor_unreviewed');
  assert.equal(decideUse('guardrail', unrev).allow, true);
  assert.equal(decideUse('instructional', unrev).allow, false);
  assert.equal(decideUse('instructional', ok).allow, true);
  assert.equal(decideUse('instructional', evaluateReview(rv({ expiresOn: '2029-03-01' }), { version: 1 }, NOW)).allow, false);
  assert.equal(decideUse('none', unrev).mode, 'no_hazard');
});

const entry = (o) => ({ kind: 'symptom', key: 'k', version: 1, title: 'Low refrigerant charge', payload: { checks: ['Check refrigerant pressures'], causes: [] }, reviewed: false, ...o });

test('ontology gate: unreviewed / expired hazard symptoms are withheld, safety floor and non-hazard rows pass', () => {
  const rows = [
    entry({ key: 'unreviewed' }),
    entry({ key: 'approved', reviewed: true, reviewedBy: 'Dana Reviewer', reviewerQualification: 'EPA 608 universal (test fixture)', reviewedAt: '2029-02-01T00:00:00Z', reviewExpiresOn: '2030-01-01' }),
    entry({ key: 'expired', reviewed: true, reviewedBy: 'Dana Reviewer', reviewerQualification: 'EPA 608 universal (test fixture)', reviewedAt: '2027-01-01T00:00:00Z', reviewExpiresOn: '2028-01-01' }),
    entry({ key: 'floor', kind: 'safety_rule', title: 'Gas odor', payload: { flag: 'gas_odor', guidance: 'Leave the building and call 911.' } }),
    entry({ key: 'plain', title: 'Weak airflow', payload: { checks: ['Check the air filter'], causes: [] } }),
    entry({ key: 'underdeclared', title: 'Plain title', payload: { checks: ['Look at it'] }, declaredHazardDomains: ['gas'] }),
  ];
  const r = gateEntriesForAi(rows, NOW);
  assert.deepEqual(r.allowed.map((e) => e.key), ['approved', 'floor', 'plain']);
  assert.deepEqual(r.blocked.map((b) => b.key).sort(), ['expired', 'underdeclared', 'unreviewed']);
  assert.deepEqual(r.unreviewedFloor, ['safety_rule:floor@v1']);
  // report-only mode blocks nothing but still reports
  const rep = gateEntriesForAi(rows, NOW, false);
  assert.equal(rep.allowed.length, rows.length);
  assert.equal(rep.blocked.length, 3);
});

test('caller synonyms do not count as hazard guidance', () => {
  const e = entry({ key: 'syn', title: 'Weak airflow', payload: { synonyms: ['gas smell', 'breaker tripped'], checks: ['Check the filter'] } });
  assert.equal(entryTier(e), 'none');
});

test('bundled seed: every instructional hazard row is withheld until reviewed; every safety rule is kept', () => {
  const r = gateEntriesForAi([...ONTOLOGY_SEED], NOW);
  assert.ok(r.blocked.length > 0);
  for (const b of r.blocked) assert.equal(b.tier, 'instructional');
  for (const e of ONTOLOGY_SEED.filter((x) => x.kind === 'safety_rule')) assert.ok(r.allowed.includes(e), `safety rule ${e.key} must never be blocked`);
});

test('migration declares every domain and the publish gate', () => {
  const sql = readFileSync(new URL('../../../migrations/20290311000000_hazard_content_governance.sql', import.meta.url), 'utf8');
  for (const d of HAZARD_DOMAINS) assert.ok(sql.includes(`'${d}'`), `migration lacks domain ${d}`);
  for (const t of ['trg_hazard_publish_gate', 'record_hazard_review', 'hazard_content_review_log', 'hazard_content_unreviewed']) assert.ok(sql.includes(t), t);
  assert.ok(/ON CONFLICT \(trade, kind, key, version, jurisdiction\) DO NOTHING/.test(sql), 'seed insert must be idempotent');
});
