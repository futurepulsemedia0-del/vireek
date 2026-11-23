// node --test scripts/pricing/pricing-change-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, fingerprint, normalizeSource, validateLedger } from './pricing-change-check.mjs';

const GUARDED = [{ path: 'src/lib/pricing.ts', required: true }];
const SRC_A = `export const PRICE = 99; // monthly\nexport const URL = 'https://buy.stripe.com/abc';\n`;
const SRC_B = `export const PRICE = 109; // monthly\nexport const URL = 'https://buy.stripe.com/abc';\n`;

const entry = (over = {}) => ({
  change_ref: 'PC-2026-0002',
  kind: 'change',
  title: 'Raise Starter price',
  summary: 'Starter monthly price goes from 99 to 109.',
  grandfathering: 'grandfathered',
  requested_by: 'author@vireek.test',
  approved_by: 'approver@vireek.test',
  approved_at: '2026-11-01',
  effective_date: '2026-12-15',
  notice: { required: true, days: 30, counsel_reviewed: true },
  files: { 'src/lib/pricing.ts': fingerprint(SRC_B) },
  ...over,
});
const baseline = () => ({
  change_ref: 'PC-2026-0001',
  kind: 'baseline',
  title: 'Baseline',
  summary: 'Pricing at introduction of change control.',
  grandfathering: 'not_applicable',
  requested_by: null,
  approved_by: 'approver@vireek.test',
  approved_at: '2026-10-01',
  effective_date: '2026-10-01',
  files: { 'src/lib/pricing.ts': fingerprint(SRC_A) },
});
const ledger = (...entries) => ({ schema_version: 1, approvers: ['approver@vireek.test'], entries });
const run = (over) => evaluate({ guarded: GUARDED, current: { 'src/lib/pricing.ts': SRC_A }, ledger: ledger(baseline()), ...over });

// ---- normalizer ------------------------------------------------------------

test('fingerprint ignores comments and whitespace but not values', () => {
  const reformatted = `export   const PRICE=99;\n\n/* note */ export const URL =\n  'https://buy.stripe.com/abc';`;
  assert.equal(fingerprint(SRC_A), fingerprint(reformatted));
  assert.notEqual(fingerprint(SRC_A), fingerprint(SRC_B));
});

test('"//" inside strings, templates and regex literals is not a comment', () => {
  assert.ok(normalizeSource(`const u = "https://x.test/a"; // c`).includes('https://x.test/a'));
  assert.ok(normalizeSource('const t = `a // b ${1 + 1}`; // c').includes('a // b'));
  const rx = normalizeSource(String.raw`const r = s.match(/\$([\d.]+)\/min/); // tail`);
  assert.ok(rx.includes(String.raw`/\$([\d.]+)\/min/`));
  assert.ok(!rx.includes('tail'));
});

test('a changed string literal changes the fingerprint (e.g. a Stripe link)', () => {
  const a = `const L = 'https://buy.stripe.com/aaa';`;
  const b = `const L = 'https://buy.stripe.com/bbb';`;
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test('words are never glued together', () => {
  assert.equal(normalizeSource('export   const\n x = 1'), 'export const x=1');
});

// ---- ledger validation -------------------------------------------------------

test('a well-formed ledger validates', () => {
  assert.deepEqual(validateLedger(ledger(baseline(), entry()), ['src/lib/pricing.ts']), []);
});

test('placeholders are rejected for approvers, approver and dates', () => {
  const l = ledger({ ...baseline(), approved_by: 'REPLACE_WITH_APPROVER_EMAIL', approved_at: 'REPLACE_WITH_YYYY-MM-DD' });
  l.approvers = ['REPLACE_WITH_APPROVER_EMAIL'];
  const errs = validateLedger(l, ['src/lib/pricing.ts']).join('\n');
  assert.match(errs, /approvers contains an invalid or placeholder/);
  assert.match(errs, /approved_by must be a real email/);
  assert.match(errs, /approved_at must be a valid/);
});

test('requester and approver must differ (case-insensitive)', () => {
  const errs = validateLedger(ledger(entry({ requested_by: 'Approver@vireek.test' })), ['src/lib/pricing.ts']).join('\n');
  assert.match(errs, /different people/);
});

test('approver must be in the approvers list', () => {
  const errs = validateLedger(ledger(entry({ approved_by: 'someone.else@vireek.test' })), ['src/lib/pricing.ts']).join('\n');
  assert.match(errs, /not listed in ledger.approvers/);
});

test('effective date cannot precede approval, and must respect notice days', () => {
  assert.match(validateLedger(ledger(entry({ effective_date: '2026-10-01' })), ['src/lib/pricing.ts']).join('\n'), /earlier than approved_at/);
  assert.match(validateLedger(ledger(entry({ effective_date: '2026-11-20' })), ['src/lib/pricing.ts']).join('\n'), /less than notice.days/);
  assert.deepEqual(validateLedger(ledger(entry({ effective_date: '2026-12-01' })), ['src/lib/pricing.ts']), []);
});

test('notice-requiring change needs counsel_reviewed === true', () => {
  const errs = validateLedger(ledger(entry({ notice: { required: true, days: 30, counsel_reviewed: false } })), ['src/lib/pricing.ts']).join('\n');
  assert.match(errs, /counsel_reviewed must be true/);
});

test('invalid calendar dates, refs, kinds and fingerprints are rejected', () => {
  const errs = validateLedger(
    ledger(entry({ approved_at: '2026-02-30', change_ref: 'PC-26-1', kind: 'oops', files: { 'src/lib/pricing.ts': 'abc', 'src/other.ts': 'f'.repeat(64) } })),
    ['src/lib/pricing.ts'],
  ).join('\n');
  assert.match(errs, /approved_at must be a valid/);
  assert.match(errs, /change_ref must look like/);
  assert.match(errs, /kind must be one of/);
  assert.match(errs, /64 lowercase hex/);
  assert.match(errs, /not a guarded file/);
});

test('duplicate change_ref is rejected', () => {
  const errs = validateLedger(ledger(baseline(), { ...entry(), change_ref: 'PC-2026-0001' }), ['src/lib/pricing.ts']).join('\n');
  assert.match(errs, /duplicate change_ref/);
});

// ---- evaluate: file vs ledger ------------------------------------------------

test('unchanged pricing file with matching entry passes', () => {
  assert.deepEqual(run().errors, []);
});

test('changed pricing file without a new entry fails and prints the fingerprint', () => {
  const r = run({ current: { 'src/lib/pricing.ts': SRC_B } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /changed without a matching ledger entry/);
  assert.ok(r.errors[0].includes(fingerprint(SRC_B)));
});

test('changed pricing file with a matching new entry passes', () => {
  const r = run({ current: { 'src/lib/pricing.ts': SRC_B }, ledger: ledger(baseline(), entry({ effective_date: '2026-12-15' })) });
  assert.deepEqual(r.errors, []);
});

test('comment-only or formatting-only edits need no entry', () => {
  const r = run({ current: { 'src/lib/pricing.ts': `// new comment\n${SRC_A}\n\n` } });
  assert.deepEqual(r.errors, []);
});

test('missing ledger and missing required file fail; optional file is skipped', () => {
  assert.match(evaluate({ guarded: GUARDED, current: {}, ledger: null }).errors[0], /missing/);
  assert.match(evaluate({ guarded: GUARDED, current: { 'src/lib/pricing.ts': null }, ledger: ledger(baseline()) }).errors.join('\n'), /guarded file not found/);
  const opt = [{ path: 'src/lib/pricing.ts', required: true }, { path: 'x/catalog.ts', required: false }];
  const r = evaluate({ guarded: opt, current: { 'src/lib/pricing.ts': SRC_A, 'x/catalog.ts': null }, ledger: ledger(baseline()) });
  assert.deepEqual(r.errors, []);
  assert.equal(r.notes.length, 1);
});

// ---- evaluate: head vs base (pull request) ---------------------------------

test('PR that changes pricing must ADD a new entry; reusing an old fingerprint is not enough', () => {
  const baseLedger = ledger(baseline());
  // head ledger identical to base, pricing changed -> fail
  const r1 = run({ current: { 'src/lib/pricing.ts': SRC_B }, ledger: baseLedger, baseLedger, base: { 'src/lib/pricing.ts': SRC_A } });
  assert.ok(r1.errors.some((e) => /no NEW ledger entry/.test(e)));
  // head adds the entry -> pass
  const head = ledger(baseline(), entry({ effective_date: '2026-12-15' }));
  const r2 = run({ current: { 'src/lib/pricing.ts': SRC_B }, ledger: head, baseLedger, base: { 'src/lib/pricing.ts': SRC_A } });
  assert.deepEqual(r2.errors, []);
});

test('PR may not edit or delete existing ledger entries (append-only)', () => {
  const baseLedger = ledger(baseline(), entry({ effective_date: '2026-12-15' }));
  const edited = ledger(baseline(), entry({ effective_date: '2026-12-15', summary: 'quietly rewritten summary text' }));
  const r = run({ current: { 'src/lib/pricing.ts': SRC_B }, ledger: edited, baseLedger, base: { 'src/lib/pricing.ts': SRC_B } });
  assert.ok(r.errors.some((e) => /append-only/.test(e)));
  const removed = ledger(baseline());
  const r2 = run({ current: { 'src/lib/pricing.ts': SRC_A }, ledger: removed, baseLedger, base: { 'src/lib/pricing.ts': SRC_A } });
  assert.ok(r2.errors.some((e) => /append-only/.test(e)));
});

test('PR that does not touch pricing passes without new entries', () => {
  const baseLedger = ledger(baseline());
  const r = run({ ledger: baseLedger, baseLedger, base: { 'src/lib/pricing.ts': SRC_A } });
  assert.deepEqual(r.errors, []);
});

test('first introduction of the ledger (no base ledger) is accepted when entries match', () => {
  const r = run({ baseLedger: null, base: { 'src/lib/pricing.ts': SRC_A } });
  assert.deepEqual(r.errors, []);
});
