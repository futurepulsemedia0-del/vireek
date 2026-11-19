// @vitest-environment node
// Regression suite for the `fail-open-secret` rule (docs/security/function-matrix.md).
// Runs the REAL index.ts of every migrated function (Deno.serve captured, supabase-js mocked).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureErrors, loadHandler, post, type Handler } from './edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown, created: 0 }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => { sb.created += 1; return sb.create(...a); } }));

/** A client that explodes on first use: proves the handler got PAST the auth gate without a real database. */
const boom = (): never => { throw new Error('DB_TOUCHED'); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deepStub: any = new Proxy(boom, { get: (_t, p) => (p === 'then' ? undefined : deepStub), apply: boom });

type Case = readonly [name: string, envName: string, load: () => Promise<unknown>];
// compute-fleet-economics is NOT in this table: it also serves signed-in dashboard users, so it has its own suite below.
const CASES: readonly Case[] = [
  ['automation-insurance-claim-status-update', 'INSURANCE_CLAIM_CRON_SECRET', () => import('../../automation-insurance-claim-status-update/index.ts')],
  ['automation-no-show-reschedule', 'NO_SHOW_CRON_SECRET', () => import('../../automation-no-show-reschedule/index.ts')],
  ['automation-vip-customer-tag', 'VIP_TAG_CRON_SECRET', () => import('../../automation-vip-customer-tag/index.ts')],
  ['causal-outcome-tracker', 'CAUSAL_TRACKER_CRON_SECRET', () => import('../../causal-outcome-tracker/index.ts')],
  ['commitment-monitor-tick', 'CRON_SECRET', () => import('../../commitment-monitor-tick/index.ts')],
  ['compute-benchmarks', 'BENCHMARK_CRON_SECRET', () => import('../../compute-benchmarks/index.ts')],
  ['compute-regional-demand', 'BENCHMARK_CRON_SECRET', () => import('../../compute-regional-demand/index.ts')],
  ['deferred-message-dispatcher', 'CRON_SECRET', () => import('../../deferred-message-dispatcher/index.ts')],
  ['detect-service-recovery-signals', 'CRON_SECRET', () => import('../../detect-service-recovery-signals/index.ts')],
  ['escalation-tick', 'CRON_SECRET', () => import('../../escalation-tick/index.ts')],
  ['estimate-recovery-agent', 'CRON_SECRET', () => import('../../estimate-recovery-agent/index.ts')],
  ['followup-agent-dispatcher', 'CRON_SECRET', () => import('../../followup-agent-dispatcher/index.ts')],
  ['followup-agent-enroller', 'CRON_SECRET', () => import('../../followup-agent-enroller/index.ts')],
  ['membership-lifecycle-agent', 'CRON_SECRET', () => import('../../membership-lifecycle-agent/index.ts')],
  ['mine-organizational-memory', 'CRON_SECRET', () => import('../../mine-organizational-memory/index.ts')],
  ['outbound-dialer', 'CRON_SECRET', () => import('../../outbound-dialer/index.ts')],
  ['outbound-queue-builder', 'CRON_SECRET', () => import('../../outbound-queue-builder/index.ts')],
  ['rescue-sla-monitor', 'CRON_SECRET', () => import('../../rescue-sla-monitor/index.ts')],
  ['self-healing-orchestrator', 'CRON_SECRET', () => import('../../self-healing-orchestrator/index.ts')],
  ['service-recovery-agent', 'CRON_SECRET', () => import('../../service-recovery-agent/index.ts')],
  ['vertical-ai-pipeline', 'VERTICAL_AI_CRON_SECRET', () => import('../../vertical-ai-pipeline/index.ts')],
  ['workflow-engine-executor', 'CRON_SECRET', () => import('../../workflow-engine-executor/index.ts')],
  ['workflow-graph-executor', 'CRON_SECRET', () => import('../../workflow-graph-executor/index.ts')],
];

const GOOD = 'unit-test-cron-secret-value';
const BASE_ENV = { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon-key' };
const withSecret = (h?: string): Record<string, string> => (h === undefined ? {} : { 'X-Cron-Secret': h });

async function errorOf(res: Response): Promise<string | null> {
  try { return (JSON.parse(await res.text()) as { error?: string }).error ?? null; } catch { return null; }
}

/** True when the request got past the auth gate (reached the DB stub, or returned something other than an auth denial). */
async function passedGate(h: Handler, req: Request): Promise<boolean> {
  let res: Response;
  try { res = await h(req); } catch (e) { return String(e).includes('DB_TOUCHED'); }
  if (res.status === 401) return false;
  const err = await errorOf(res);
  return err !== 'Service not configured.' && err !== 'Unauthorized' && err !== 'Unauthorized.';
}

beforeEach(() => { sb.created = 0; sb.create = () => deepStub; });
afterEach(() => { vi.restoreAllMocks(); });

describe.each(CASES)('%s — fail-closed cron secret', (name, envName, load) => {
  const boot = (secret: string | undefined) => loadHandler(load, { ...BASE_ENV, ...(secret === undefined ? {} : { [envName]: secret }) });

  it(`unset ${envName} → 500 "Service not configured.", logged, no DB client`, async () => {
    const errs = captureErrors();
    const h = await boot(undefined);
    const res = await h(post({}, withSecret(GOOD)));
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toBe('Service not configured.');
    expect(sb.created).toBe(0);
    const line = errs.lines().find((l) => l.includes('cron_auth_misconfigured'));
    expect(line).toBeDefined();
    expect(line).toContain(name);
    expect(line).toContain(envName);
    expect(line).not.toContain(GOOD);
  });

  it(`empty-string ${envName} is treated as unset → 500`, async () => {
    captureErrors();
    const h = await boot('');
    expect((await h(post({}, withSecret('')))).status).toBe(500);
    expect((await h(post({}, withSecret('anything')))).status).toBe(500);
    expect(sb.created).toBe(0);
  });

  it('unset secret never lets a guessed, empty or missing header through (the original bug)', async () => {
    captureErrors();
    const h = await boot(undefined);
    for (const req of [post({}), post({}, withSecret('')), post({}, withSecret('guess')), post({}, { Authorization: 'Bearer anon-key' })]) {
      const res = await h(req);
      expect(res.status).toBe(500);
    }
    expect(sb.created).toBe(0);
  });

  it('wrong, missing and prefix-only secrets → 401, no DB client', async () => {
    const h = await boot(GOOD);
    for (const hdr of [undefined, '', 'wrong', GOOD.slice(0, -1), `${GOOD}x`, GOOD.toUpperCase()]) {
      const res = await h(post({}, withSecret(hdr)));
      expect(res.status, `header=${String(hdr)}`).toBe(401);
    }
    expect(sb.created).toBe(0);
  });

  it('the anon/bearer key is not a substitute for the cron secret', async () => {
    const h = await boot(GOOD);
    const res = await h(post({}, { Authorization: 'Bearer anon-key', apikey: 'anon-key' }));
    expect(res.status).toBe(401);
    expect(sb.created).toBe(0);
  });

  it('the exact secret passes the gate', async () => {
    const h = await boot(GOOD);
    expect(await passedGate(h, post({}, withSecret(GOOD)))).toBe(true);
  });
});

// compute-fleet-economics: scheduler (cron secret) OR dashboard Refresh button (verified user JWT).
describe('compute-fleet-economics — cron secret OR a verified user session', () => {
  const ENV = 'FLEET_ECONOMICS_CRON_SECRET';
  const load = () => import('../../compute-fleet-economics/index.ts');
  const boot = (secret: string | undefined) => loadHandler(load, { ...BASE_ENV, ...(secret === undefined ? {} : { [ENV]: secret }) });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeEach(() => {
    sb.create = () => ({
      auth: { getUser: async (jwt: string) => (jwt === 'user-jwt' ? { data: { user: { id: 'u1' } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } }) },
      from: boom,
    });
  });

  it('cron call with the secret unset → 500; wrong → 401; right → passes', async () => {
    captureErrors();
    expect((await (await boot(undefined))(post({}, withSecret(GOOD)))).status).toBe(500);
    expect((await (await boot(''))(post({}, withSecret('x')))).status).toBe(500);
    const h = await boot(GOOD);
    expect((await h(post({}, withSecret('wrong')))).status).toBe(401);
    expect(await passedGate(h, post({}, withSecret(GOOD)))).toBe(true);
  });

  it('REGRESSION: with the secret unset, a bare Authorization header no longer opens the function', async () => {
    const h = await boot(undefined);
    expect((await h(post({}, bearer('whatever')))).status).toBe(401);
    expect((await h(post({}, bearer('anon-key')))).status).toBe(401);
  });

  it('a request with no credential at all → 401', async () => {
    for (const secret of [undefined, GOOD]) {
      const h = await boot(secret);
      expect((await h(post({}))).status).toBe(401);
    }
  });

  it('the public anon key (a valid gateway JWT) is rejected by getUser → 401', async () => {
    const h = await boot(GOOD);
    expect((await h(post({}, bearer('anon-key')))).status).toBe(401);
  });

  it('a genuine signed-in user (dashboard Refresh) passes the gate, with or without the cron secret configured', async () => {
    for (const secret of [undefined, GOOD]) {
      const h = await boot(secret);
      expect(await passedGate(h, post({}, bearer('user-jwt')))).toBe(true);
    }
  });

  it('a cron header never falls back to the JWT path: wrong secret + valid user JWT → 401', async () => {
    const h = await boot(GOOD);
    expect((await h(post({}, { ...withSecret('wrong'), ...bearer('user-jwt') }))).status).toBe(401);
  });
});

describe('vertical-ai-pipeline — runs are always logged as cron-triggered', () => {
  it('writes triggered_by="cron" (the unauthenticated "manual" path is gone)', async () => {
    const inserted: unknown[] = [];
    sb.create = () => ({
      from: () => ({ insert: (row: unknown) => { inserted.push(row); return { select: () => ({ single: async () => ({ data: null, error: { message: 'stop here' } }) }) }; } }),
    });
    captureErrors();
    const h = await loadHandler(() => import('../../vertical-ai-pipeline/index.ts'), { ...BASE_ENV, VERTICAL_AI_CRON_SECRET: GOOD });
    await h(post({}, withSecret(GOOD)));
    expect(inserted).toEqual([{ status: 'running', triggered_by: 'cron' }]);
  });
});
