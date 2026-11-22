import test from 'node:test';
import assert from 'node:assert/strict';
import { seedTestAccount, validateSeedEnv } from './seed-test-account.mjs';

const ok = { E2E_SEED_SUPABASE_URL: 'https://abcd.supabase.co', E2E_SEED_SERVICE_ROLE_KEY: 'k', E2E_SEED_CONFIRM_PROJECT_REF: 'abcd', E2E_TEST_EMAIL: 'e2e+ci@x.com', E2E_TEST_PASSWORD: 'a-long-password-1' };

test('validateSeedEnv accepts a complete, matching config', () => assert.deepEqual(validateSeedEnv(ok), []));
test('validateSeedEnv blocks wrong project, non-e2e email, weak password, missing vars', () => {
  assert.ok(validateSeedEnv({ ...ok, E2E_SEED_CONFIRM_PROJECT_REF: 'prod' }).some((p) => /does not match/.test(p)));
  assert.ok(validateSeedEnv({ ...ok, E2E_TEST_EMAIL: 'ceo@x.com' }).some((p) => /start with "e2e"/.test(p)));
  assert.ok(validateSeedEnv({ ...ok, E2E_TEST_PASSWORD: 'short' }).some((p) => /12 characters/.test(p)));
  assert.ok(validateSeedEnv({}).length >= 5);
});

function fakeAdmin({ createError = null, existingUsers = [], customers = [] } = {}) {
  const log = [];
  const chain = (table, op, payload) => {
    const c = { eq: () => c, limit: () => c, select: () => c, then: (res) => res(op === 'select' ? { data: customers, error: null } : { data: null, error: null }) };
    log.push({ table, op, payload });
    return c;
  };
  return { log, auth: { admin: {
    createUser: async () => (createError ? { data: null, error: { message: createError } } : { data: { user: { id: 'new-id' } }, error: null }),
    listUsers: async () => ({ data: { users: existingUsers }, error: null }),
    updateUserById: async (id, p) => (log.push({ op: 'updateUser', id, p }), { error: null }),
  } }, from: (t) => ({ update: (p) => chain(t, 'update', p), select: () => chain(t, 'select'), insert: (p) => chain(t, 'insert', p) }) };
}

test('creates user, completes onboarding, inserts customer on a fresh project', async () => {
  const a = fakeAdmin();
  const r = await seedTestAccount(a, { email: 'e2e@x.com', password: 'pw' });
  assert.deepEqual(r, { userId: 'new-id', userCreated: true, customerCreated: true });
  assert.ok(a.log.some((l) => l.table === 'profiles' && l.payload.onboarding_completed === true));
});
test('is idempotent: existing user gets password reset, existing customer is not duplicated', async () => {
  const a = fakeAdmin({ createError: 'already registered', existingUsers: [{ id: 'u1', email: 'E2E@x.com' }], customers: [{ id: 'c1' }] });
  const r = await seedTestAccount(a, { email: 'e2e@x.com', password: 'pw' });
  assert.deepEqual(r, { userId: 'u1', userCreated: false, customerCreated: false });
  assert.ok(a.log.some((l) => l.op === 'updateUser' && l.id === 'u1'));
  assert.ok(!a.log.some((l) => l.op === 'insert'));
});
test('surfaces createUser failure when the user truly does not exist', async () => {
  await assert.rejects(seedTestAccount(fakeAdmin({ createError: 'boom' }), { email: 'e2e@x.com', password: 'pw' }), /createUser failed/);
});
