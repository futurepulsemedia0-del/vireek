// @vitest-environment node
// Regression suite for the `gateway-jwt-only` rule (docs/security/function-matrix.md).
// The public anon key is a valid JWT, so `verify_jwt = true` alone lets any internet caller in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureErrors, loadHandler, post, type Handler } from './edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown, created: 0 }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => { sb.created += 1; return sb.create(...a); } }));

const boom = (): never => { throw new Error('DB_TOUCHED'); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deepStub: any = new Proxy(boom, { get: (_t, p) => (p === 'then' ? undefined : deepStub), apply: boom });

const SERVICE_KEY = 'service-role-key-for-tests';
const ANON_KEY = 'anon-key-public';
const BASE_ENV = { SUPABASE_URL: 'http://db.test', SUPABASE_ANON_KEY: ANON_KEY, GBP_APPLY_ENABLED: 'true' };
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

const DENIALS = new Set(['Unauthorized', 'Unauthorized.', 'not_authenticated', 'Service not configured.']);
async function passedGate(h: Handler, req: Request): Promise<boolean> {
  let res: Response;
  try { res = await h(req); } catch (e) { return String(e).includes('DB_TOUCHED'); }
  if (res.status === 401) return false;
  try { const err = (JSON.parse(await res.text()) as { error?: string }).error; if (err && DENIALS.has(err)) return false; } catch { /* not JSON */ }
  return true;
}

beforeEach(() => { sb.created = 0; sb.create = () => deepStub; });
afterEach(() => { vi.restoreAllMocks(); });

type Case = readonly [name: string, load: () => Promise<unknown>];

const SERVICE_FUNCTIONS: readonly Case[] = [
  ['enforce-payment-suspension', () => import('../../enforce-payment-suspension/index.ts')],
  ['check-warranty-alerts', () => import('../../check-warranty-alerts/index.ts')],
  ['marketing-campaign-dispatcher', () => import('../../marketing-campaign-dispatcher/index.ts')],
  ['dr-backup-run', () => import('../../dr-backup-run/index.ts')],
  ['check-contract-renewals', () => import('../../check-contract-renewals/index.ts')],
  ['check-credential-expirations', () => import('../../check-credential-expirations/index.ts')],
  ['data-retention-sweep', () => import('../../data-retention-sweep/index.ts')],
  ['dr-restore-drill', () => import('../../dr-restore-drill/index.ts')],
  ['marketing-engine-tick', () => import('../../marketing-engine-tick/index.ts')],
  ['check-cost-guardrails', () => import('../../check-cost-guardrails/index.ts')],
  ['economics-routing-eval', () => import('../../economics-routing-eval/index.ts')],
  ['economics-sweep', () => import('../../economics-sweep/index.ts')],
  ['learning-policy-monitor', () => import('../../learning-policy-monitor/index.ts')],
  ['outcome-reconciler', () => import('../../outcome-reconciler/index.ts')],
];

describe.each(SERVICE_FUNCTIONS)('%s — service/cron callers only', (name, load) => {
  const boot = (env: Record<string, string> = {}) => loadHandler(load, { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ...env });

  it('the public anon key (valid for verify_jwt) is rejected with 401 and never reaches the database', async () => {
    const h = await boot();
    expect((await h(post({}, bearer(ANON_KEY)))).status).toBe(401);
    expect(sb.created).toBe(0);
  });

  it('no credential, an arbitrary user JWT, and near-miss service keys → 401', async () => {
    const h = await boot();
    for (const headers of [{}, bearer('a-signed-in-users-jwt'), bearer(''), bearer(SERVICE_KEY.slice(0, -1)), bearer(`${SERVICE_KEY}x`), { 'X-Cron-Secret': SERVICE_KEY }]) {
      expect((await h(post({}, headers))).status, JSON.stringify(headers)).toBe(401);
    }
    expect(sb.created).toBe(0);
  });

  it('the service-role bearer passes the gate', async () => {
    const h = await boot();
    expect(await passedGate(h, post({}, bearer(SERVICE_KEY)))).toBe(true);
  });

  it('X-Cron-Secret passes only when CRON_SECRET is configured and matches', async () => {
    const h = await boot({ CRON_SECRET: 'cron-secret-for-tests' });
    expect(await passedGate(h, post({}, { 'X-Cron-Secret': 'cron-secret-for-tests' }))).toBe(true);
    expect((await h(post({}, { 'X-Cron-Secret': 'nope' }))).status).toBe(401);
    const noCron = await boot();
    expect((await noCron(post({}, { 'X-Cron-Secret': 'cron-secret-for-tests' }))).status).toBe(401);
  });

  it(`${name}: with no service key configured it fails closed (500 + log), never open`, async () => {
    const errs = captureErrors();
    const h = await loadHandler(load, { ...BASE_ENV });
    expect((await h(post({}, bearer(ANON_KEY)))).status).toBe(500);
    expect((await h(post({}))).status).toBe(500);
    expect(errs.lines().some((l) => l.includes('cron_auth_misconfigured'))).toBe(true);
    expect(sb.created).toBe(0);
  });
});

const USER_FUNCTIONS: readonly Case[] = [
  ['lien-waiver-email', () => import('../../lien-waiver-email/index.ts')],
  ['direct-mail-settings', () => import('../../direct-mail-settings/index.ts')],
  ['direct-mail-verify', () => import('../../direct-mail-verify/index.ts')],
  ['call-inspector', () => import('../../call-inspector/index.ts')],
  ['franchise-royalty-issue', () => import('../../franchise-royalty-issue/index.ts')],
  ['gbp-sync', () => import('../../gbp-sync/index.ts')],
  ['generate-insights', () => import('../../generate-insights/index.ts')],
];

describe.each(USER_FUNCTIONS)('%s — signed-in users only', (_name, load) => {
  const boot = (env: Record<string, string> = BASE_ENV) => loadHandler(load, { SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ...env });
  const USERS: Record<string, { id?: string; is_anonymous?: boolean } | null> = {
    'real-user-jwt': { id: 'u1', is_anonymous: false },
    'anonymous-session-jwt': { id: 'u2', is_anonymous: true },
  };

  beforeEach(() => {
    sb.create = () => ({
      auth: { getUser: async (jwt: string) => (USERS[jwt] ? { data: { user: USERS[jwt] }, error: null } : { data: { user: null }, error: { message: 'invalid JWT: missing sub claim' } }) },
      rpc: boom,
      from: boom,
    });
  });

  it('no Authorization header → 401', async () => {
    const h = await boot();
    expect((await h(post({}))).status).toBe(401);
    expect((await h(post({}, { Authorization: 'Basic abc' }))).status).toBe(401);
  });

  it('the public anon key → 401 (getUser rejects it) and no table/RPC access happens', async () => {
    const h = await boot();
    expect((await h(post({}, bearer(ANON_KEY)))).status).toBe(401);
  });

  it('an anonymous-sign-in session is not a user → 401', async () => {
    const h = await boot();
    expect((await h(post({}, bearer('anonymous-session-jwt')))).status).toBe(401);
  });

  it('a forged/expired token → 401', async () => {
    const h = await boot();
    expect((await h(post({}, bearer('forged.jwt.value')))).status).toBe(401);
  });

  it('a real signed-in user passes the gate', async () => {
    const h = await boot();
    expect(await passedGate(h, post({}, bearer('real-user-jwt')))).toBe(true);
  });

  it('missing SUPABASE_ANON_KEY → 500 (fails closed)', async () => {
    captureErrors();
    const h = await boot({ SUPABASE_URL: 'http://db.test', GBP_APPLY_ENABLED: 'true' });
    expect((await h(post({}, bearer('real-user-jwt')))).status).toBe(500);
  });
});

// ------------------------------------------------------------------------------------------------------------------
const USER_JWTS: Record<string, { id: string; is_anonymous: boolean }> = { 'jwt-user-a': { id: 'user-a', is_anonymous: false } };
const authStub = (extra: Record<string, unknown> = {}) => ({
  auth: { getUser: async (jwt: string) => (USER_JWTS[jwt] ? { data: { user: USER_JWTS[jwt] }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } }) },
  ...extra,
});

describe('generate-insights — a caller can only generate insights for their own account (was: any user_id accepted)', () => {
  const boot = () => loadHandler(() => import('../../generate-insights/index.ts'), { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY });
  beforeEach(() => { sb.create = () => authStub({ from: boom, rpc: boom }); });

  it("another user's id in the body → 403 and the service-role data is never read", async () => {
    const h = await boot();
    expect((await h(post({ user_id: 'victim-user' }, bearer('jwt-user-a')))).status).toBe(403);
  });
  it('the anon key with a victim id → 401', async () => {
    const h = await boot();
    expect((await h(post({ user_id: 'victim-user' }, bearer(ANON_KEY)))).status).toBe(401);
  });
  it('their own id passes the gate', async () => {
    const h = await boot();
    expect(await passedGate(h, post({ user_id: 'user-a' }, bearer('jwt-user-a')))).toBe(true);
  });
});

describe('flywheel-engine — scheduler (full sweep) or signed-in user (own account only)', () => {
  const boot = (env: Record<string, string> = {}) => loadHandler(() => import('../../flywheel-engine/index.ts'), { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ...env });
  let seen: string[];
  beforeEach(() => {
    seen = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec: any = new Proxy(function () { /* noop */ }, {
      get: (_t, p) => (p === 'then' ? (res: (v: unknown) => void) => res({ data: [], error: null }) : (...a: unknown[]) => { seen.push(`${String(p)}(${a.map((x) => JSON.stringify(x)).join(',')})`); return rec; }),
      apply: () => rec,
    });
    sb.create = () => authStub({ from: (t: string) => { seen.push(`from(${t})`); return rec; }, rpc: () => rec });
  });

  it('anon key → 401; no credential → 401', async () => {
    const h = await boot();
    expect((await h(post({}, bearer(ANON_KEY)))).status).toBe(401);
    expect((await h(post({}))).status).toBe(401);
  });
  it('a signed-in user can NOT target someone else: single_user_id in the body is ignored', async () => {
    const h = await boot();
    try { await h(post({ single_user_id: 'victim-user' }, bearer('jwt-user-a'))); } catch { /* downstream stub noise is fine */ }
    const joined = seen.join('\n');
    expect(joined).not.toContain('victim-user');
    expect(joined).toContain('user-a');
    expect(joined).not.toContain('from(profiles)');
  });
  it('the service key may run the full sweep', async () => {
    const h = await boot();
    try { await h(post({}, bearer(SERVICE_KEY))); } catch { /* ignore */ }
    expect(seen.join('\n')).toContain('from(profiles)');
  });
  it('no service key configured → 500 (fails closed, even for a user JWT)', async () => {
    captureErrors();
    const h = await loadHandler(() => import('../../flywheel-engine/index.ts'), { ...BASE_ENV });
    expect((await h(post({}, bearer('jwt-user-a')))).status).toBe(500);
  });
});

describe('public token endpoints now rate-limit per IP', () => {
  const limiter = (allowed: boolean | 'down') => () => ({
    rpc: async (name: string) => {
      if (name !== 'edge_rate_limit_hit') return { data: null, error: null };
      return allowed === 'down' ? { data: null, error: { message: 'down' } } : { data: { allowed, remaining: 0, retry_after: 30 }, error: null };
    },
    from: boom,
  });
  const UUID = '123e4567-e89b-42d3-a456-426614174000';
  const bootU = () => loadHandler(() => import('../../unsubscribe-status-updates/index.ts'), { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY });
  const bootS = () => loadHandler(() => import('../../sign-document-action/index.ts'), { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY });

  it('unsubscribe-status-updates: malformed token → 400 before any DB client; limited → 429 + Retry-After; limiter down → fails open', async () => {
    const h = await bootU();
    expect((await h(post({ token: "' or 1=1 --" }))).status).toBe(400);
    expect(sb.created).toBe(0);
    sb.create = limiter(false);
    const limited = await h(post({ token: UUID }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('30');
    captureErrors();
    sb.create = limiter('down');
    expect(await passedGate(h, post({ token: UUID }))).toBe(true);
  });

  it('sign-document-action: over-long token → 400; limited → 429; allowed → proceeds', async () => {
    const h = await bootS();
    expect((await h(post({ action: 'view', signer_token: 'x'.repeat(500) }))).status).toBe(400);
    sb.create = limiter(false);
    expect((await h(post({ action: 'view', signer_token: 'tok' }))).status).toBe(429);
    sb.create = limiter(true);
    expect((await h(post({ action: 'view', signer_token: 'tok' }))).status).toBe(200);
  });
});
