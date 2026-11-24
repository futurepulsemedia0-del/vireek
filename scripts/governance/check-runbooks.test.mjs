// node --test scripts/governance/check-runbooks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dayNumber, evaluateDoc, isOwnerless, listDocs, parseFrontmatter, runCheck, GENERATED } from './check-runbooks.mjs';
import { CLASSIFICATION, buildBlock } from './add-runbook-frontmatter.mjs';

const CLI = fileURLToPath(new URL('./check-runbooks.mjs', import.meta.url));
const TODAY = '2027-01-15';
const doc = (fm, body = '# Title\n') => `---\n${fm.join('\n')}\n---\n${body}`;
const ev = (fm, opts = {}) => evaluateDoc('docs/runbooks/x.md', doc(fm), { today: TODAY, root: opts.root ?? '/nonexistent', ...opts });

test('dayNumber rejects impossible dates', () => {
  assert.equal(dayNumber('2027-02-30'), null);
  assert.equal(dayNumber('2027-13-01'), null);
  assert.equal(dayNumber('27-01-01'), null);
  assert.ok(dayNumber('2028-02-29') !== null);
});

test('parseFrontmatter: none, unclosed, bad line, duplicate key, comments and quotes', () => {
  assert.equal(parseFrontmatter('# Title\n').data, null);
  assert.match(parseFrontmatter('---\nowner: a\n# x\n').error, /not closed/);
  assert.match(parseFrontmatter('---\nowner a\n---\n').error, /key: value/);
  assert.match(parseFrontmatter('---\nowner: a\nowner: b\n---\n').error, /duplicate/);
  const ok = parseFrontmatter('---\n# note\nowner: "Dana K."   # trailing\nkind: runbook\n---\n# T\n');
  assert.deepEqual(ok.data, { owner: 'Dana K.', kind: 'runbook' });
  assert.equal(parseFrontmatter('---\r\nowner: a\r\n---\r\n# T').data.owner, 'a');
});

test('isOwnerless treats placeholders as nobody', () => {
  for (const v of ['TBD', 'tbd', '', '  ', 'unassigned', 'TODO', '—', undefined]) assert.equal(isOwnerless(v), true, String(v));
  assert.equal(isOwnerless('Dana K.'), false);
});

test('missing or malformed metadata is INVALID, not merely a warning', () => {
  assert.match(evaluateDoc('f.md', '# T\n', { today: TODAY }).invalid[0], /no frontmatter/);
  assert.ok(ev(['kind: runbook', 'last_tested: never', 'next_test: TBD']).invalid.some((m) => /owner/.test(m)));
  assert.ok(ev(['owner: a', 'kind: sop', 'last_tested: never', 'next_test: TBD']).invalid.some((m) => /kind must be/.test(m)));
  assert.ok(ev(['owner: a', 'kind: runbook', 'last_tested: yesterday', 'next_test: TBD']).invalid.some((m) => /last_tested/.test(m)));
  assert.ok(ev(['owner: a', 'kind: runbook', 'last_tested: never', 'next_test: 2027-02-30']).invalid.some((m) => /next_test/.test(m)));
  assert.ok(ev(['owner: a', 'kind: runbook', 'area: finance', 'last_tested: never', 'next_test: TBD']).invalid.some((m) => /area must be/.test(m)));
  assert.ok(ev(['owner: a', 'kind: runbook', 'color: red', 'last_tested: never', 'next_test: TBD']).invalid.some((m) => /unknown key/.test(m)));
});

test('a reference/template/log does not need test dates and is never "stale"', () => {
  const r = ev(['owner: Dana', 'kind: reference', 'last_tested: n/a', 'next_test: n/a']);
  assert.deepEqual([r.invalid, r.findings], [[], []]);
  assert.ok(ev(['owner: Dana', 'kind: template', 'last_tested: never', 'next_test: n/a']).invalid.length > 0, '"never" is not valid for a non-testable kind');
});

test('runbook: ownerless + never tested + unscheduled are all listed', () => {
  const r = ev(['owner: TBD', 'kind: runbook', 'last_tested: never', 'next_test: TBD']);
  assert.deepEqual(r.invalid, []);
  assert.deepEqual(r.findings, ['ownerless', 'never tested', 'no next test scheduled']);
});

test('a test claimed with a date needs evidence; unsafe or missing evidence is invalid', () => {
  const base = ['owner: Dana', 'kind: runbook', 'last_tested: 2026-12-01', 'next_test: 2027-06-01'];
  assert.ok(ev(base).invalid.some((m) => /evidence/.test(m)));
  assert.ok(ev([...base, 'evidence: ../../etc/passwd']).invalid.some((m) => /repo-relative/.test(m)));
  assert.ok(ev([...base, 'evidence: /etc/passwd']).invalid.some((m) => /repo-relative/.test(m)));
  assert.ok(ev([...base, 'evidence: docs/missing.md']).invalid.some((m) => /does not exist/.test(m)));
  assert.deepEqual(ev([...base, 'evidence: https://example.com/drill/42']).invalid, []);
});

test('fresh test with real evidence file passes cleanly; old test is stale; past next_test is overdue', () => {
  const root = mkdtempSync(join(tmpdir(), 'rb-'));
  try {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs/drill.md'), 'record');
    const fresh = ev(['owner: Dana', 'kind: runbook', 'last_tested: 2026-12-01', 'next_test: 2027-06-01', 'evidence: docs/drill.md'], { root });
    assert.deepEqual([fresh.invalid, fresh.findings], [[], []]);
    const stale = ev(['owner: Dana', 'kind: runbook', 'last_tested: 2025-01-01', 'next_test: 2027-06-01', 'evidence: docs/drill.md'], { root });
    assert.match(stale.findings[0], /^stale: last tested 744 days ago/);
    const over = ev(['owner: Dana', 'kind: runbook', 'last_tested: 2026-12-01', 'next_test: 2027-01-14', 'evidence: docs/drill.md'], { root });
    assert.deepEqual(over.findings, ['overdue: next test was due 2027-01-14']);
    const custom = ev(['owner: Dana', 'kind: runbook', 'last_tested: 2026-12-01', 'next_test: 2027-06-01', 'evidence: docs/drill.md'], { root, maxAgeDays: 30 });
    assert.match(custom.findings[0], /stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('date logic: future last_tested and next_test before last_tested are invalid', () => {
  assert.ok(ev(['owner: a', 'kind: runbook', 'last_tested: 2027-02-01', 'next_test: TBD', 'evidence: https://e.x/1']).invalid.some((m) => /future/.test(m)));
  assert.ok(ev(['owner: a', 'kind: runbook', 'last_tested: 2026-12-01', 'next_test: 2026-11-01', 'evidence: https://e.x/1']).invalid.some((m) => /before last_tested/.test(m)));
});

test('listDocs skips generated files and non-markdown; runCheck aggregates', () => {
  const root = mkdtempSync(join(tmpdir(), 'rb-'));
  try {
    mkdirSync(join(root, 'docs/runbooks'), { recursive: true });
    mkdirSync(join(root, 'docs/security'), { recursive: true });
    writeFileSync(join(root, 'docs/runbooks/a.md'), doc(['owner: Dana', 'kind: reference', 'last_tested: n/a', 'next_test: n/a']));
    writeFileSync(join(root, 'docs/runbooks/b.md'), '# no frontmatter\n');
    writeFileSync(join(root, 'docs/security/function-policy.json'), '{}');
    for (const g of GENERATED) writeFileSync(join(root, g), '# generated\n');
    assert.deepEqual(listDocs(root), ['docs/runbooks/a.md', 'docs/runbooks/b.md']);
    const res = runCheck({ root, today: TODAY });
    assert.equal(res.scanned, 2);
    assert.equal(res.invalid.length, 1);
    assert.equal(res.flagged.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('codemod block: owner is always TBD, testable kinds are "never", nothing is claimed as tested', () => {
  assert.equal(buildBlock('runbook', 'voice'), '---\nowner: TBD\nkind: runbook\narea: voice\nlast_tested: never\nnext_test: TBD\n---\n');
  assert.equal(buildBlock('log', 'unassigned'), '---\nowner: TBD\nkind: log\narea: unassigned\nlast_tested: n/a\nnext_test: n/a\n---\n');
  for (const [file, [kind]] of Object.entries(CLASSIFICATION)) {
    const r = evaluateDoc(file, `${buildBlock(...CLASSIFICATION[file])}# x\n`, { today: TODAY });
    assert.deepEqual(r.invalid, [], `${file} (${kind})`);
    assert.ok(!GENERATED.includes(file), `${file} is generated and must not be in the table`);
  }
});

test('CLI: exit 0 with warnings by default, 1 with --strict, 1 for invalid, 2 for bad usage', () => {
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
  const def = run('--today', TODAY);
  assert.equal(def.status, 0, def.stdout + def.stderr);
  assert.match(def.stdout, /ownerless/);
  assert.equal(run('--strict', '--today', TODAY).status, 1);
  assert.equal(run('--today', '2027-02-30').status, 2);
  assert.equal(run('--max-age-days', '0').status, 2);
  assert.equal(run('--nope').status, 2);
});
