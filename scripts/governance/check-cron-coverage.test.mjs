// Run with: node --test scripts/governance/check-cron-coverage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyze, isCronStyle, stripSqlComments } from './check-cron-coverage.mjs';

const CRON_FN = 'const s = Deno.env.get("CRON_SECRET");\n';
function repo({ fns = {}, sql = {}, wf = {}, exemptions, baseline }) {
  const root = mkdtempSync(join(tmpdir(), 'cron-'));
  const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  for (const [n, src] of Object.entries(fns)) put(`supabase/functions/${n}/index.ts`, src);
  for (const [n, s] of Object.entries(sql)) put(`supabase/migrations/${n}.sql`, s);
  for (const [n, y] of Object.entries(wf)) put(`.github/workflows/${n}.yml`, y);
  if (exemptions) put('docs/governance/cron-exemptions.json', JSON.stringify({ exemptions }));
  if (baseline) put('scripts/governance/baselines/cron-coverage.json', JSON.stringify({ functions: baseline }));
  return root;
}
const withRepo = (spec, fn) => { const r = repo(spec); try { fn(analyze(r), r); } finally { rmSync(r, { recursive: true, force: true }); } };

test('an unscheduled cron-style function is a new offender', () => {
  withRepo({ fns: { 'job-a': CRON_FN } }, (r) => assert.equal(r.newOffenders.join(), 'job-a'));
});

test('cron_dispatch, synthetic_cron_tick and URL-in-cron.schedule all count as scheduled', () => {
  withRepo({
    fns: { a: CRON_FN, b: CRON_FN, c: CRON_FN },
    sql: { m1: "select cron.schedule('x','* * * * *',$$select public.cron_dispatch('a')$$);select cron.schedule('y','* * * * *',$$select public.synthetic_cron_tick('b')$$);",
           m2: "select cron.schedule('z','* * * * *',$$select net.http_post(url := base || '/c', headers := h)$$);" },
  }, (r) => assert.deepEqual(r.errors, []));
});

test('schedules that only appear in SQL comments do not count', () => {
  withRepo({ fns: { a: CRON_FN }, sql: { m: "-- select cron.schedule('x','* * * * *',$$select public.cron_dispatch('a')$$);\n/* cron_dispatch('a') */" } },
    (r) => assert.equal(r.newOffenders.join(), 'a'));
  assert.equal(stripSqlComments("a\n-- x\nb /* y */ c").replace(/\s+/g, ' ').trim(), 'a b c');
});

test('net.http_post outside cron.schedule (e.g. a trigger) does not count', () => {
  withRepo({ fns: { a: CRON_FN }, sql: { m: "create function t() returns trigger as $$ begin perform net.http_post(url := base || '/a'); return new; end $$ language plpgsql;" } },
    (r) => assert.equal(r.newOffenders.join(), 'a'));
});

test('a workflow counts only when it has a schedule trigger', () => {
  const call = 'curl "$URL/functions/v1/a"';
  withRepo({ fns: { a: CRON_FN }, wf: { w: `on:\n  schedule:\n    - cron: "0 * * * *"\njobs: ${call}` } }, (r) => assert.deepEqual(r.errors, []));
  withRepo({ fns: { a: CRON_FN }, wf: { w: `on:\n  push:\njobs: ${call}` } }, (r) => assert.equal(r.newOffenders.join(), 'a'));
});

test('markers override detection; signals in comments are ignored', () => {
  assert.equal(isCronStyle('// @not-cron\nconst x = "CRON_SECRET";'), false);
  assert.equal(isCronStyle('// @cron\nDeno.serve(() => new Response());'), true);
  assert.equal(isCronStyle('// mentions CRON_SECRET only in a comment\nDeno.serve(() => new Response());'), false);
  assert.equal(isCronStyle('// Cron-driven (every 2 min)\nDeno.serve(() => new Response());'), true);
});

test('exemptions need a valid kind, a real reason and an existing function', () => {
  const ok = { function: 'a', kind: 'one-off', reason: 'Run by hand once during the migration runbook.' };
  withRepo({ fns: { a: CRON_FN }, exemptions: [ok] }, (r) => assert.deepEqual(r.errors, []));
  withRepo({ fns: { a: CRON_FN }, exemptions: [{ ...ok, reason: 'too short' }] }, (r) => assert.ok(r.errors.some((e) => /reason/.test(e))));
  withRepo({ fns: { a: CRON_FN }, exemptions: [{ ...ok, kind: 'whatever' }] }, (r) => assert.ok(r.errors.some((e) => /kind must be/.test(e))));
  withRepo({ fns: { a: CRON_FN }, exemptions: [{ ...ok, function: 'ghost' }] }, (r) => assert.ok(r.errors.some((e) => /does not exist/.test(e))));
  withRepo({ fns: { a: CRON_FN }, exemptions: [{ function: 'a', kind: 'covered-by-sql', reason: 'Scheduled directly in SQL by another job.', evidence: 'nope.sql' }] },
    (r) => assert.ok(r.errors.some((e) => /covered-by-sql needs/.test(e))));
});

test('an exemption for a function that is now scheduled is stale', () => {
  withRepo({ fns: { a: CRON_FN }, sql: { m: "select cron.schedule('x','* * * * *',$$select public.cron_dispatch('a')$$);" },
             exemptions: [{ function: 'a', kind: 'one-off', reason: 'Run by hand once during the migration runbook.' }] },
    (r) => assert.ok(r.errors.some((e) => /delete this exemption/.test(e))));
});

test('baseline tolerates legacy offenders but may only shrink', () => {
  withRepo({ fns: { a: CRON_FN }, baseline: ['a'] }, (r) => assert.deepEqual(r.errors, []));
  withRepo({ fns: { a: CRON_FN, b: CRON_FN }, baseline: ['a'] }, (r) => assert.equal(r.newOffenders.join(), 'b'));
  withRepo({ fns: { a: CRON_FN }, baseline: ['ghost'] }, (r) => assert.ok(r.errors.some((e) => /no longer exists/.test(e))));
  withRepo({ fns: { a: CRON_FN }, baseline: ['a'], sql: { m: "select cron.schedule('x','* * * * *',$$select public.cron_dispatch('a')$$);" } },
    (r) => assert.ok(r.errors.some((e) => /remove it from the baseline/.test(e))));
});
