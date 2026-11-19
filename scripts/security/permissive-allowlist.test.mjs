// node --test scripts/security/permissive-allowlist.test.mjs
// Gate: every `policy-true` / `anon-write-policy` finding in the migrations must be an explicit, reviewed allowlist entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './rls-audit.mjs';
import { PERMISSIVE_ALLOWLIST, key } from './permissive-allowlist.mjs';

const { tables, findings } = load();
const permissive = findings.filter((f) => f.rule === 'policy-true' || f.rule === 'anon-write-policy');
const found = new Set(permissive.map((f) => key(f.table, f.detail.split(' (')[0])));
const AUTH_BOUND = /auth\.uid\(\)|auth\.jwt\(\)|get_account_owner_id|is_vireek_staff|auth\.role\(\)/i;
const allowed = new Set(PERMISSIVE_ALLOWLIST.map((e) => key(e.table, e.policy)));

test('allowlist entries are unique, complete and well-formed', () => {
  assert.equal(allowed.size, PERMISSIVE_ALLOWLIST.length, 'duplicate allowlist entry');
  for (const e of PERMISSIVE_ALLOWLIST) {
    assert.ok(e.table && e.policy && e.kind && e.why && e.why.length > 15, `incomplete entry ${e.table}`);
  }
});

test('no unreviewed permissive policy exists', () => {
  const unreviewed = [...found].filter((k) => !allowed.has(k));
  assert.deepEqual(unreviewed, [], `unreviewed permissive policies (fix them or review + allowlist): ${unreviewed.join(', ')}`);
});

test('no stale allowlist entry (policy fixed or removed)', () => {
  const stale = [...allowed].filter((k) => !found.has(k));
  assert.deepEqual(stale, [], `stale allowlist entries: ${stale.join(', ')}`);
});

test('no policy lets the anon role write with a non-false USING (anon-write-policy)', () => {
  assert.deepEqual(permissive.filter((f) => f.rule === 'anon-write-policy'), []);
});

test('unauthenticated-reachable writes are INSERT-only, and unbounded ones are reviewed public-insert tables', () => {
  const publicInsert = new Set(PERMISSIVE_ALLOWLIST.filter((e) => e.kind === 'public-insert').map((e) => e.table));
  for (const t of tables.values()) {
    for (const p of t.policies.values()) {
      if (p.cmd !== 'select' && p.roles.some((r) => r === 'anon' || r === 'public')) {
        const exprs = `${p.using ?? ''} ${p.check ?? ''}`;
        // `TO public` + auth.uid()/staff check denies a real anon caller (auth.uid() is NULL): not reachable.
        if (AUTH_BOUND.test(exprs)) continue;
        // Truly unauthenticated-reachable writes: must be INSERT-only and a reviewed public-insert table.
        assert.equal(p.cmd, 'insert', `${t.name}.${p.name}: anon-reachable ${p.cmd}`);
        const trivial = p.check === null || /^\s*true\s*$/i.test(p.check);
        if (trivial) assert.ok(publicInsert.has(t.name), `${t.name}.${p.name}: unbounded anon INSERT not reviewed`);
      }
    }
  }
});

test('previously cross-tenant-readable lead tables are staff-only', () => {
  for (const n of ['demo_bookings', 'onboarding_bookings', 'status_subscribers']) {
    for (const p of tables.get(n).policies.values()) {
      if (p.cmd === 'insert') continue;
      assert.match(`${p.using} ${p.check ?? ''}`, /is_vireek_staff/i, `${n}.${p.name} must be staff-gated, got: ${p.using}`);
      assert.doesNotMatch(`${p.using}`, /role\s*=\s*'admin'/i, `${n}.${p.name} still uses the tenant admin role`);
    }
  }
});
