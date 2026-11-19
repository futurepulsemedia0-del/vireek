// @vitest-environment node
// Supabase Auth hooks: the Standard Webhooks signature is the only credential.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Webhook } from 'npm:standardwebhooks@1.0.0';
import { captureErrors, loadHandler, post, type Handler } from './edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown, created: 0 }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => { sb.created += 1; return sb.create(...a); } }));

const boom = (): never => { throw new Error('DB_TOUCHED'); };
const SECRET_B64 = Buffer.from('hook-secret-32-bytes-long-xxxxxxxx').toString('base64');
const SECRET = `v1,whsec_${SECRET_B64}`;
const BASE_ENV = { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon-key', FRAUD_HASH_PEPPER: 'pepper-for-tests' };

const signed = (body: unknown, opts: { id?: string; ageSeconds?: number; secretB64?: string } = {}): Request => {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0);
  const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  return post(body, { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': Webhook.sign(opts.secretB64 ?? SECRET_B64, id, ts, raw) });
};

async function passed(h: Handler, req: Request): Promise<boolean> {
  try { const r = await h(req); return r.status !== 401 && r.status !== 409 && !(r.status === 500 && (await r.text()).includes('not configured')); }
  catch (e) { return String(e).includes('DB_TOUCHED'); }
}

let claimed: Set<string>;
let claimStoreDown = false;
beforeEach(() => {
  sb.created = 0; claimed = new Set(); claimStoreDown = false;
  sb.create = () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'claim_webhook_event') {
        if (claimStoreDown) return { data: null, error: { message: 'store down' } };
        const k = `${args.p_provider}:${args.p_event_id}`;
        if (claimed.has(k)) return { data: false, error: null };
        claimed.add(k); return { data: true, error: null };
      }
      return boom();
    },
    from: boom,
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const HOOKS = [
  ['auth-before-user-created', 'BEFORE_USER_CREATED_HOOK_SECRET', { metadata: { ip_address: '203.0.113.9' }, user: { email: 'new.person@example.com', user_metadata: {} } }, () => import('../../auth-before-user-created/index.ts')],
  ['auth-send-sms-hook', 'SEND_SMS_HOOK_SECRET', { user: { phone: '15551234567' }, sms: { otp: '123456' } }, () => import('../../auth-send-sms-hook/index.ts')],
] as const;

describe.each(HOOKS)('%s — Standard Webhooks signature is the only credential', (_n, envName, payload, load) => {
  const boot = (secret: string | undefined = SECRET) => loadHandler(load, { ...BASE_ENV, ...(secret ? { [envName]: secret } : {}) });

  it('secret unset → 500 (fail closed), no DB client', async () => {
    const h = await boot('');
    expect((await h(signed(payload))).status).toBe(500);
    expect(sb.created).toBe(0);
  });
  it('no signature headers (e.g. a caller holding only the anon key) → 401, no DB client', async () => {
    const h = await boot();
    expect((await h(post(payload, { Authorization: 'Bearer anon-key', apikey: 'anon-key' }))).status).toBe(401);
    expect(sb.created).toBe(0);
  });
  it('a forged signature (wrong secret) → 401', async () => {
    const h = await boot();
    const forged = signed(payload, { secretB64: Buffer.from('some-other-secret-material-xxxxxxxx').toString('base64') });
    expect((await h(forged)).status).toBe(401);
    expect(sb.created).toBe(0);
  });
  it('a stale (10 min old) but correctly signed delivery → 401', async () => {
    const h = await boot();
    expect((await h(signed(payload, { ageSeconds: 600 }))).status).toBe(401);
  });
  it('a body tampered after signing → 401', async () => {
    const h = await boot();
    const good = signed(payload, { id: 'msg_tamper' });
    const headers = Object.fromEntries(good.headers);
    expect((await h(post({ ...payload, extra: 'tampered' }, headers))).status).toBe(401);
  });
  it('a valid signature passes the gate', async () => {
    const h = await boot();
    expect(await passed(h, signed(payload))).toBe(true);
  });
  it('the same delivery id twice → second is refused with 409 (replay)', async () => {
    const h = await boot();
    expect(await passed(h, signed(payload, { id: 'msg_replay_1' }))).toBe(true);
    expect((await h(signed(payload, { id: 'msg_replay_1' }))).status).toBe(409);
  });
  it('replay store outage fails OPEN (logged) so sign-up / sign-in is not blocked', async () => {
    const errs = captureErrors();
    claimStoreDown = true;
    const h = await boot();
    expect(await passed(h, signed(payload))).toBe(true);
    expect(errs.lines().some((l) => l.includes('auth_hook_replay_store_unavailable'))).toBe(true);
  });
});
