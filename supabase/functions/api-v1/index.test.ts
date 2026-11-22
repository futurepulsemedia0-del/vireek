// @vitest-environment node
// capital-manage: Vireek NEVER decides credit. prescreen -> submit (pledge receivables) -> accept / withdraw, relayed to a lending partner.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { jsonOf, loadHandler, type Handler } from '../_shared/testing/edgeHarness.ts';
import { authed, BASE_ENV, captureLogs, ID, seedUser } from '../_shared/testing/edgeKit.ts';
import { ProviderBoundaryError } from '../_shared/pay/types.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));
const m = vi.hoisted(() => ({ partner: {} as Record<string, any>, prescreen: vi.fn(), disclosable: vi.fn() }));
vi.mock('../_shared/pay/registry.ts', () => ({ getLendingPartner: () => m.partner }));
vi.mock('../_shared/pay/capitalEngine.ts', () => ({
  resolvePrescreenConfig: (c: unknown) => c ?? {},
  revenueProfileFromRpc: (r: Record<string, unknown>) => ({ trailing12mCents: 1, trailing3mCents: 1, monthsOfHistory: 12, paidInvoiceCount12m: 9, openReceivables: [], ...r }),
  prescreenCapital: (...a: unknown[]) => m.prescreen(...a),
  offerIsDisclosable: (o: unknown) => m.disclosable(o),
  REASON_TEXT: { too_new: 'Not enough history' },
}));

const ELIGIBLE = { outcome: 'eligible_to_apply', reasons: [], eligibleReceivables: [{ invoiceId: 'inv-1', customerRef: 'c1', amountCents: 80000, dueDate: '2026-12-01', issuedAt: '2026-11-01' }, { invoiceId: 'inv-2', customerRef: 'c2', amountCents: 40000, dueDate: '2026-12-05', issuedAt: '2026-11-02' }], eligibleReceivablesCents: 120000, notice: 'indicative' };
const OFFER = { externalOfferId: 'o-1', offeredAmountCents: 90000, totalRepaymentCents: 99000, financeChargeCents: 9000, termDays: 90, estimatedAprBps: 3000, repaymentDescription: 'x', termsUrl: 'https://p.test/t', expiresAt: '2099-01-01T00:00:00Z' };
let db: FakeDb; let handler: Handler; let state: Record<string, unknown>;
const call = (body: unknown, token: string | null = 'tok-owner') => handler(authed(body, token));
const app = (id = 'app-1') => db.rows('capital_applications').find((a) => a.id === id)!;

beforeEach(async () => {
  db = new FakeDb();
  seedUser(db, 'tok-owner', ID.ownerA);
  seedUser(db, 'tok-tech', ID.tech, { ownerId: ID.ownerA, role: 'technician' });
  db.seed('profiles', [{ id: ID.ownerA, role: 'owner' }]);
  state = { available: true, product: 'capital', mode: 'sandbox', reason: null, max_single_cents: 100000, config: {} };
  db.rpcHandlers.pay_product_state = () => state;
  db.rpcHandlers.pay_disclosure_accepted = () => 2;
  db.rpcHandlers.capital_get_revenue_profile = () => ({});
  db.rpcHandlers.capital_pledge_receivables = () => ({});
  db.seed('capital_applications', [
    { id: 'app-1', user_id: ID.ownerA, status: 'prescreened', sandbox: true, external_application_id: 'ext-app' },
    { id: 'app-b', user_id: ID.ownerB, status: 'prescreened', sandbox: true },
  ]);
  m.prescreen.mockReset().mockReturnValue(ELIGIBLE);
  m.disclosable.mockReset().mockReturnValue(true);
  m.partner = {
    id: 'sandbox', isConfigured: () => true,
    submitApplication: vi.fn(async () => ({ outcome: 'offered', sandbox: true, externalApplicationId: 'ext-app', offers: [OFFER] })),
    acceptOffer: vi.fn(async () => ({ status: 'accepted', sandbox: true })), withdrawApplication: vi.fn(async () => {}),
  };
  sb.create = db.createClient;
  captureLogs();
  handler = await loadHandler(() => import('./index.ts'), { ...BASE_ENV });
});

const submit = (extra: Record<string, unknown> = {}) => call({ action: 'submit', application_id: 'app-1', requested_amount_cents: 90000, invoice_ids: ['inv-1', 'inv-2'], ...extra });

describe('capital-manage: access + kill switch', () => {
  it('401 / 403 / unavailable / unconfigured', async () => {
    expect((await call({ action: 'prescreen' }, null)).status).toBe(401);
    expect((await call({ action: 'prescreen' }, 'tok-tech')).status).toBe(403);
    state = { available: false, product: 'capital', mode: 'live', reason: 'killed' };
    expect((await call({ action: 'prescreen' })).status).toBe(403);
    state = { available: true, product: 'capital', mode: 'live' };
    m.partner.isConfigured = () => false;
    expect((await call({ action: 'prescreen' })).status).toBe(503);
  });
  it('invalid action 400; another tenant application is 404', async () => {
    expect((await call({ action: 'nope', application_id: 'app-1' })).status).toBe(400);
    expect((await call({ action: 'submit', application_id: 'app-b' })).status).toBe(404);
    expect(m.partner.submitApplication).not.toHaveBeenCalled();
  });
  it('mode mismatch (sandbox application, live product) is 409', async () => {
    state = { ...state, mode: 'live' };
    expect((await submit()).status).toBe(409);
  });
});

describe('capital-manage: prescreen', () => {
  it('requires the prescreen disclosure', async () => {
    db.rpcHandlers.pay_disclosure_accepted = () => null;
    const res = await call({ action: 'prescreen' });
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).disclosure_key).toBe('capital_prescreen');
  });
  it('stores the result for the OWNER with status and never returns open receivables', async () => {
    const res = await call({ action: 'prescreen' });
    const body = await jsonOf(res);
    expect(res.status).toBe(200);
    expect(body.outcome).toBe('eligible_to_apply');
    expect(body.profile.openReceivables).toBeUndefined();
    const row = db.rows('capital_applications').find((a) => a.id !== 'app-1' && a.id !== 'app-b')!;
    expect(row).toMatchObject({ user_id: ID.ownerA, status: 'prescreened', disclosure_prescreen_version: 2 });
    expect(db.rows('capital_events')[0]).toMatchObject({ user_id: ID.ownerA, event_type: 'prescreen' });
  });
  it('an ineligible result is recorded as prescreen_not_eligible with reason texts', async () => {
    m.prescreen.mockReturnValue({ ...ELIGIBLE, outcome: 'not_eligible', reasons: ['too_new'] });
    const body = await jsonOf(await call({ action: 'prescreen' }));
    expect(body.reasons).toEqual([{ code: 'too_new', text: 'Not enough history' }]);
    expect(db.rows('capital_applications').some((a) => a.status === 'prescreen_not_eligible')).toBe(true);
  });
});

describe('capital-manage: submit', () => {
  it('requires state "prescreened" and the application disclosure', async () => {
    app().status = 'submitted';
    expect((await submit()).status).toBe(409);
    app().status = 'prescreened';
    db.rpcHandlers.pay_disclosure_accepted = (a: any) => (a.p_key === 'capital_application' ? null : 2);
    const res = await submit();
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).disclosure_key).toBe('capital_application');
  });
  it.each([[0], [-5], [1.5], [100001], ['abc']])('rejects requested amount %s', async (amt) => {
    expect((await submit({ requested_amount_cents: amt })).status).toBe(422);
    expect(m.partner.submitApplication).not.toHaveBeenCalled();
  });
  it('rejects empty / oversized / non-eligible receivable selections', async () => {
    expect((await submit({ invoice_ids: [] })).status).toBe(422);
    expect((await submit({ invoice_ids: Array.from({ length: 201 }, (_, i) => `i${i}`) })).status).toBe(422);
    expect((await submit({ invoice_ids: ['inv-1', 'someone-elses-invoice'] })).status).toBe(422);
    expect((await submit({ requested_amount_cents: 100000, invoice_ids: ['inv-2'] })).status).toBe(422); // exceeds the pledged face value
  });
  it('re-runs the pre-screen on fresh data and refuses when no longer eligible', async () => {
    m.prescreen.mockReturnValue({ ...ELIGIBLE, outcome: 'not_eligible', reasons: ['too_new'] });
    expect((await submit()).status).toBe(409);
    expect(m.partner.submitApplication).not.toHaveBeenCalled();
  });
  it('an already pledged receivable is a 409 and nothing is sent to the partner', async () => {
    db.rpcHandlers.capital_pledge_receivables = () => ({ error: { message: 'already_pledged: inv-1' } });
    expect((await submit()).status).toBe(409);
    expect(m.partner.submitApplication).not.toHaveBeenCalled();
  });
  it('happy path: pledges, hashes the package, stores the offer exactly as returned, app -> offered', async () => {
    const res = await submit();
    expect(res.status).toBe(200);
    expect(db.rpcCalls('capital_pledge_receivables')[0].payload).toMatchObject({ p_user_id: ID.ownerA, p_invoice_ids: ['inv-1', 'inv-2'] });
    expect(app().data_package_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(app().status).toBe('offered');
    expect(db.rows('capital_offers')[0]).toMatchObject({ user_id: ID.ownerA, external_offer_id: 'o-1', total_repayment_cents: 99000, estimated_apr_bps: 3000 });
  });
  it('an offer missing mandatory disclosure fields is dropped; with none left the application errors', async () => {
    m.disclosable.mockReturnValue(false);
    await submit();
    expect(db.rows('capital_offers')).toHaveLength(0);
    expect(app()).toMatchObject({ status: 'error', failure_code: 'no_disclosable_offer' });
  });
  it('a partner decline is recorded; a boundary error becomes 503 and status error; unknown error 502', async () => {
    m.partner.submitApplication.mockResolvedValueOnce({ outcome: 'declined', sandbox: true, externalApplicationId: 'ext', offers: [], declineReasons: ['thin_file'] });
    await submit();
    expect(app()).toMatchObject({ status: 'declined_by_partner', decline_reasons: ['thin_file'] });
    app().status = 'prescreened';
    m.partner.submitApplication.mockRejectedValueOnce(new ProviderBoundaryError('provider_not_configured'));
    expect((await submit()).status).toBe(503);
    expect(app().status).toBe('error');
    app().status = 'prescreened';
    m.partner.submitApplication.mockRejectedValueOnce(new Error('socket hang up'));
    expect((await submit()).status).toBe(502);
  });
});

describe('capital-manage: accept / withdraw', () => {
  beforeEach(() => {
    app().status = 'offered';
    db.seed('capital_offers', [{ id: 'o-db', application_id: 'app-1', status: 'open', external_offer_id: 'o-1', expires_at: '2099-01-01T00:00:00Z' }]);
  });
  it('accept requires status offered and an open, unexpired offer of THIS application', async () => {
    app().status = 'prescreened';
    expect((await call({ action: 'accept_offer', application_id: 'app-1', offer_id: 'o-db' })).status).toBe(409);
    app().status = 'offered';
    db.rows('capital_offers')[0].expires_at = '2000-01-01T00:00:00Z';
    expect((await call({ action: 'accept_offer', application_id: 'app-1', offer_id: 'o-db' })).status).toBe(409);
    expect(m.partner.acceptOffer).not.toHaveBeenCalled();
  });
  it('accept relays to the partner and records the event; funded maps to funded', async () => {
    m.partner.acceptOffer.mockResolvedValueOnce({ status: 'funded', sandbox: true });
    expect((await call({ action: 'accept_offer', application_id: 'app-1', offer_id: 'o-db' })).status).toBe(200);
    expect(m.partner.acceptOffer).toHaveBeenCalledWith('ext-app', 'o-1');
    expect(app().status).toBe('funded');
    expect(db.rows('capital_events').some((e) => e.event_type === 'offer_accepted')).toBe(true);
  });
  it('withdraw is only allowed from prescreened / submitted / offered, and closes open offers', async () => {
    expect((await call({ action: 'withdraw', application_id: 'app-1' })).status).toBe(200);
    expect(m.partner.withdrawApplication).toHaveBeenCalledWith('ext-app');
    expect(app().status).toBe('withdrawn');
    expect(db.rows('capital_offers')[0].status).toBe('withdrawn');
    expect((await call({ action: 'withdraw', application_id: 'app-1' })).status).toBe(409);
  });
});
