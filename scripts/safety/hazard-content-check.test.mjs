// Run: node --experimental-strip-types --no-warnings --test scripts/safety/hazard-content-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck, extractRegion } from './hazard-content-check.mjs';

const REAL = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TODAY = new Date('2029-03-11T00:00:00Z');

function fixture({ promptBody = 'const SYSTEM_PROMPT = `Never walk a caller through gas line work.`;\n', registry, extraFiles = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hazard-'));
  const gdir = join(root, 'supabase/functions/_shared/safety-governance');
  mkdirSync(gdir, { recursive: true });
  cpSync(join(REAL, 'supabase/functions/_shared/safety-governance/hazardGovernance.ts'), join(gdir, 'hazardGovernance.ts'));
  mkdirSync(join(root, 'supabase/functions/demo'), { recursive: true });
  writeFileSync(join(root, 'supabase/functions/demo/index.ts'), promptBody);
  for (const [p, c] of Object.entries(extraFiles)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
  writeFileSync(join(gdir, 'hazardRegistry.ts'), registry ?? defaultRegistry());
  return root;
}
const defaultRegistry = (reviews = '{}', ack = '{}') => `
export const HAZARD_INVENTORY = [{ id: 'prompt.demo', kind: 'ai_prompt', tier: 'instructional', domains: ['gas'], file: 'supabase/functions/demo/index.ts', start: 'const SYSTEM_PROMPT', end: '\`;', owner: 'x', surface: 's' }];
export const HAZARD_REVIEWS = ${reviews};
export const NOT_HAZARD_GUIDANCE = ${ack};
`;

test('extractRegion', () => {
  assert.equal(extractRegion('a START b END c', 'START', 'END').text, 'START b END');
  assert.equal(extractRegion('a START b', 'START').text, 'START b');
  assert.equal(extractRegion('a', 'START').ok, false);
  assert.equal(extractRegion('START b', 'START', 'END').ok, false);
});

test('unreviewed content is backlog by default, a failure with --strict', async () => {
  const root = fixture();
  const a = await runCheck({ root, today: TODAY });
  assert.equal(a.ok, true); assert.deepEqual(a.backlog, ['prompt.demo (instructional)']);
  const b = await runCheck({ root, today: TODAY, strict: true });
  assert.equal(b.ok, false); assert.match(b.errors.join('\n'), /no current review for prompt\.demo/);
});

test('a current review passes strict; editing the text afterwards makes it stale', async () => {
  const probe = await runCheck({ root: fixture(), today: TODAY });
  const hash = probe.items[0].hash;
  const review = `{ 'prompt.demo': { reviewer: 'Dana Reviewer', reviewerQualification: 'licensed gas fitter (fixture)', reviewedOn: '2029-02-01', expiresOn: '2029-12-01', version: 1, contentHash: '${hash}' } }`;
  const ok = await runCheck({ root: fixture({ registry: defaultRegistry(review) }), today: TODAY, strict: true });
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  const edited = await runCheck({ root: fixture({ registry: defaultRegistry(review), promptBody: 'const SYSTEM_PROMPT = `Walk the caller through gas line work.`;\n' }), today: TODAY });
  assert.equal(edited.ok, false); assert.match(edited.errors.join('\n'), /review stale: content changed/);
});

test('an expired review fails even the default gate', async () => {
  const probe = await runCheck({ root: fixture(), today: TODAY });
  const review = `{ 'prompt.demo': { reviewer: 'Dana Reviewer', reviewerQualification: 'licensed gas fitter (fixture)', reviewedOn: '2028-01-01', expiresOn: '2029-01-01', version: 1, contentHash: '${probe.items[0].hash}' } }`;
  const r = await runCheck({ root: fixture({ registry: defaultRegistry(review) }), today: TODAY });
  assert.equal(r.ok, false); assert.match(r.errors.join('\n'), /review expired/);
});

test('marker drift, unknown review id and undeclared domain are failures', async () => {
  const drift = await runCheck({ root: fixture({ promptBody: 'const OTHER = `gas`;\n' }), today: TODAY });
  assert.match(drift.errors.join('\n'), /start marker not found/);
  const unknown = await runCheck({ root: fixture({ registry: defaultRegistry("{ 'nope': { reviewer: 'Dana', reviewerQualification: 'x y z', reviewedOn: '2029-01-01', expiresOn: '2029-06-01', version: 1 } }") }), today: TODAY });
  assert.match(unknown.errors.join('\n'), /unknown inventory id nope/);
  const undeclared = await runCheck({ root: fixture({ promptBody: 'const SYSTEM_PROMPT = `gas and carbon monoxide`;\n' }), today: TODAY });
  assert.match(undeclared.errors.join('\n'), /touches "carbon_monoxide"/);
});

test('a new hazard-bearing prompt file cannot appear without being registered or acknowledged', async () => {
  const extra = { 'supabase/functions/new-agent/index.ts': 'const SYSTEM_PROMPT = `If the user mentions a refrigerant leak, explain how to vent it.`;\n' };
  const r = await runCheck({ root: fixture({ extraFiles: extra }), today: TODAY });
  assert.equal(r.ok, false); assert.match(r.errors.join('\n'), /unregistered hazard-bearing prompt\/content file: supabase\/functions\/new-agent\/index\.ts/);
  const acked = await runCheck({ root: fixture({ extraFiles: extra, registry: defaultRegistry('{}', "{ 'supabase/functions/new-agent/index.ts': 'label text only, no instructions' }") }), today: TODAY });
  assert.equal(acked.ok, true, acked.errors.join('\n'));
  const noReason = await runCheck({ root: fixture({ extraFiles: extra, registry: defaultRegistry('{}', "{ 'supabase/functions/new-agent/index.ts': '' }") }), today: TODAY });
  assert.match(noReason.errors.join('\n'), /without a reason/);
});

test('the real repository passes the default gate and has no expired, stale or invalid reviews', async () => {
  const r = await runCheck({ today: new Date() });
  assert.equal(r.ok, true, r.errors.join('\n'));
});
