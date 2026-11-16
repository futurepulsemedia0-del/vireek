import { describe, it, expect } from 'vitest';
import {
  MAX_BILLABLE_OVERAGE_MINUTES,
  OVERAGE_METADATA_KEY,
  isRenewalDraftInvoice,
  overageAmountCents,
  overageDescription,
  overageIdempotencyKey,
  periodFromInvoice,
  planFromInvoiceLines,
  resolveClosingPlan,
  processOverageInvoice,
  type InvoiceItemLike,
  type InvoiceItemParams,
  type InvoiceLike,
  type OverageDeps,
  type RolloverArgs,
  type SetBillingArgs,
  type UsagePeriodRow,
} from './overage';
import { overageCentsPerMinute, OVERAGE_CENTS_PER_MINUTE } from './planCatalog';
import { PRICING_PLANS, parseOverageRate } from '../../../../src/lib/pricing';

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function invoice(over: Partial<InvoiceLike> = {}): InvoiceLike {
  return {
    id: 'in_1',
    billing_reason: 'subscription_cycle',
    status: 'draft',
    customer: 'cus_1',
    subscription: 'sub_1',
    currency: 'usd',
    period_start: 1_790_000_000,
    period_end: 1_792_592_000,
    ...over,
  };
}

/** In-memory stand-ins for the DB (ledger semantics of period_rollover) and Stripe. */
function makeWorld(
  opts: { overageMinutes?: number; policy?: 'allow' | 'bill'; plan?: string; invoiceStatus?: string; snapshotPlan?: string | null; profileIncluded?: number; usedMinutes?: number } = {},
) {
  const world = {
    ledger: new Map<string, UsagePeriodRow>(),
    items: [] as { id: string; invoice: string; params: InvoiceItemParams; key: string }[],
    idempotency: new Map<string, { id: string }>(),
    createCalls: 0,
    stripeInvoiceStatus: opts.invoiceStatus ?? 'draft',
    failNextCreate: false,
    failNextSetBillingBilled: false,
    rolloverArgs: [] as RolloverArgs[],
    periodPlans: new Map<string, string>(),
  };
  const plan = opts.plan ?? 'starter';
  const policy = opts.policy ?? 'bill';
  const profileIncluded = opts.profileIncluded ?? 400;
  const overageMinutes = opts.overageMinutes ?? 30;

  const deps: OverageDeps = {
    findProfilesByCustomer: async (c) => {
      const me = { id: USER, plan, usage_period_plan: opts.snapshotPlan ?? null };
      return c === 'cus_1' ? [me] : c === 'cus_dup' ? [me, { id: OTHER, plan, usage_period_plan: null }] : [];
    },
    planFromPriceId: (id) => ({ price_starter: 'starter', price_pro: 'professional' } as Record<string, string>)[id] ?? null,
    setPeriodPlan: async (userId, p) => {
      world.periodPlans.set(userId, p);
    },
    retrieveInvoice: async (id) => ({ id, status: world.stripeInvoiceStatus }),
    listInvoiceItems: async (id) => world.items.filter((i) => i.invoice === id).map((i): InvoiceItemLike => ({ id: i.id, metadata: i.params.metadata })),
    createInvoiceItem: async (params, key) => {
      world.createCalls++;
      if (world.failNextCreate) {
        world.failNextCreate = false;
        throw new Error('stripe down');
      }
      const prior = world.idempotency.get(key);
      if (prior) return prior;
      const created = { id: `ii_${world.items.length + 1}` };
      world.items.push({ id: created.id, invoice: params.invoice, params, key });
      world.idempotency.set(key, created);
      return created;
    },
    rollover: async (a: RolloverArgs) => {
      const k = `${a.p_user}|${a.p_period_key}`;
      const hit = world.ledger.get(k);
      if (hit) return hit;
      world.rolloverArgs.push(a);
      const included = a.p_included_override ?? profileIncluded;
      const used = opts.usedMinutes ?? profileIncluded + overageMinutes;
      const minutes = Math.max(used - included, 0);
      const rate = a.p_rate_cents;
      const billable = policy === 'bill' && rate !== null && a.p_currency === 'usd';
      const status = minutes === 0 ? 'skipped_zero' : policy !== 'bill' ? 'skipped_policy' : rate === null ? 'skipped_no_rate' : !billable ? 'skipped_currency' : 'pending';
      const row: UsagePeriodRow = {
        user_id: a.p_user,
        period_key: a.p_period_key,
        billing_status: status,
        overage_minutes: minutes,
        rate_cents: rate,
        amount_cents: minutes * (rate ?? 0),
        stripe_invoice_item_id: null,
      };
      world.ledger.set(k, row);
      return row;
    },
    setBilling: async (a: SetBillingArgs) => {
      const k = `${a.p_user}|${a.p_period_key}`;
      const row = world.ledger.get(k);
      if (!row) return null;
      if (a.p_status === 'billed' && world.failNextSetBillingBilled) {
        world.failNextSetBillingBilled = false;
        throw new Error('db down');
      }
      if (['pending', 'failed', 'needs_review'].includes(row.billing_status)) {
        row.billing_status = a.p_status;
        row.stripe_invoice_item_id = a.p_item_id ?? row.stripe_invoice_item_id;
      }
      return row;
    },
    log: () => {},
  };
  return { world, deps };
}

describe('overageAmountCents', () => {
  it('multiplies whole minutes by the rate', () => {
    expect(overageAmountCents(30, 20)).toBe(600);
    expect(overageAmountCents(1, 12)).toBe(12);
  });
  it('returns 0 for zero minutes or zero rate', () => {
    expect(overageAmountCents(0, 20)).toBe(0);
    expect(overageAmountCents(10, 0)).toBe(0);
  });
  it('rounds partial minutes up', () => {
    expect(overageAmountCents(0.2, 20)).toBe(20);
    expect(overageAmountCents(10.01, 20)).toBe(220);
  });
  it('handles large values exactly (no float drift)', () => {
    expect(overageAmountCents(MAX_BILLABLE_OVERAGE_MINUTES, 20)).toBe(2_000_000);
    expect(Number.isSafeInteger(overageAmountCents(MAX_BILLABLE_OVERAGE_MINUTES, 20))).toBe(true);
  });
  it('refuses nonsense instead of charging it', () => {
    expect(() => overageAmountCents(-1, 20)).toThrow();
    expect(() => overageAmountCents(Number.NaN, 20)).toThrow();
    expect(() => overageAmountCents(Number.POSITIVE_INFINITY, 20)).toThrow();
    expect(() => overageAmountCents(5, 0.5)).toThrow();
    expect(() => overageAmountCents(5, -1)).toThrow();
    expect(() => overageAmountCents(MAX_BILLABLE_OVERAGE_MINUTES + 1, 20)).toThrow();
  });
});

describe('invoice helpers', () => {
  it('accepts only draft subscription_cycle invoices', () => {
    expect(isRenewalDraftInvoice({ billing_reason: 'subscription_cycle', status: 'draft' })).toBe(true);
    expect(isRenewalDraftInvoice({ billing_reason: 'subscription_cycle', status: 'open' })).toBe(false);
    expect(isRenewalDraftInvoice({ billing_reason: 'subscription_create', status: 'draft' })).toBe(false);
    expect(isRenewalDraftInvoice({ billing_reason: 'manual', status: 'draft' })).toBe(false);
  });
  it('derives a stable period key from the invoice', () => {
    const a = periodFromInvoice(invoice());
    const b = periodFromInvoice(invoice());
    expect(a?.key).toBe('sub_1:1792592000');
    expect(a?.key).toBe(b?.key);
    expect(a?.startIso).toBe(new Date(1_790_000_000 * 1000).toISOString());
  });
  it('rejects missing or inverted periods', () => {
    expect(periodFromInvoice(invoice({ period_start: null }))).toBeNull();
    expect(periodFromInvoice(invoice({ period_start: 10, period_end: 10 }))).toBeNull();
    expect(periodFromInvoice(invoice({ period_start: 20, period_end: 10 }))).toBeNull();
  });
  it('builds the documented idempotency key and description', () => {
    expect(overageIdempotencyKey(USER, 'sub_1:5')).toBe(`overage:${USER}:sub_1:5`);
    expect(overageDescription(30, 20)).toBe('Voice overage: 30 min x $0.20');
    expect(overageDescription(7, 12)).toBe('Voice overage: 7 min x $0.12');
  });
});

describe('overage rates stay in sync with the public pricing page', () => {
  it('matches src/lib/pricing.ts for every metered plan', () => {
    for (const plan of PRICING_PLANS) {
      const displayed = parseOverageRate(plan.overage);
      const billed = overageCentsPerMinute(plan.id);
      if (displayed === null) {
        expect(billed).toBeNull();
      } else {
        expect(billed).toBe(Math.round(displayed * 100));
      }
    }
  });
  it('has no rate for free, enterprise or unknown plans', () => {
    expect(overageCentsPerMinute('free')).toBeNull();
    expect(overageCentsPerMinute('enterprise')).toBeNull();
    expect(overageCentsPerMinute('nope')).toBeNull();
    expect(overageCentsPerMinute(null)).toBeNull();
    expect(Object.keys(OVERAGE_CENTS_PER_MINUTE)).toHaveLength(3);
  });
});

describe('processOverageInvoice', () => {
  it('ignores non-renewal and non-draft invoices', async () => {
    const { deps, world } = makeWorld();
    expect((await processOverageInvoice(invoice({ billing_reason: 'subscription_update' }), deps)).outcome).toBe('ignored');
    expect((await processOverageInvoice(invoice({ status: 'open' }), deps)).outcome).toBe('ignored');
    expect(world.items).toHaveLength(0);
    expect(world.ledger.size).toBe(0);
  });

  it('creates exactly one invoice item with the documented description and key', async () => {
    const { deps, world } = makeWorld({ overageMinutes: 30 });
    const out = await processOverageInvoice(invoice(), deps);
    expect(out).toEqual({ outcome: 'billed', itemId: 'ii_1', amountCents: 600, reusedExistingItem: false });
    expect(world.items).toHaveLength(1);
    expect(world.items[0].params.amount).toBe(600);
    expect(world.items[0].params.currency).toBe('usd');
    expect(world.items[0].params.invoice).toBe('in_1');
    expect(world.items[0].params.description).toBe('Voice overage: 30 min x $0.20');
    expect(world.items[0].key).toBe(`overage:${USER}:sub_1:1792592000`);
    expect(world.items[0].params.metadata[OVERAGE_METADATA_KEY]).toBe(world.items[0].key);
    expect([...world.ledger.values()][0].stripe_invoice_item_id).toBe('ii_1');
  });

  it('replaying the same webhook 3 times creates exactly one invoice item', async () => {
    const { deps, world } = makeWorld({ overageMinutes: 30 });
    const first = await processOverageInvoice(invoice(), deps);
    const second = await processOverageInvoice(invoice(), deps);
    const third = await processOverageInvoice(invoice(), deps);
    expect(first.outcome).toBe('billed');
    expect(second.outcome).toBe('billed');
    expect(third.outcome).toBe('billed');
    expect(world.items).toHaveLength(1);
    expect(world.createCalls).toBe(1);
  });

  it('does not duplicate when the DB write after Stripe failed and the event is retried', async () => {
    const { deps, world } = makeWorld({ overageMinutes: 10 });
    world.failNextSetBillingBilled = true;
    await expect(processOverageInvoice(invoice(), deps)).rejects.toThrow('db down');
    expect(world.items).toHaveLength(1);
    const retry = await processOverageInvoice(invoice(), deps);
    expect(retry.outcome).toBe('billed');
    expect(world.items).toHaveLength(1); // reused the item already on the invoice
  });

  it('does not duplicate even after the Stripe idempotency key expired', async () => {
    const { deps, world } = makeWorld({ overageMinutes: 10 });
    await processOverageInvoice(invoice(), deps);
    world.idempotency.clear(); // simulate the 24h key lifetime elapsing
    world.ledger.clear(); // and a ledger that has to be rebuilt
    await processOverageInvoice(invoice(), deps);
    expect(world.items).toHaveLength(1);
  });

  it('rethrows Stripe failures so the webhook retries, then succeeds once', async () => {
    const { deps, world } = makeWorld({ overageMinutes: 10 });
    world.failNextCreate = true;
    await expect(processOverageInvoice(invoice(), deps)).rejects.toThrow('stripe down');
    expect([...world.ledger.values()][0].billing_status).toBe('failed');
    const retry = await processOverageInvoice(invoice(), deps);
    expect(retry.outcome).toBe('billed');
    expect(world.items).toHaveLength(1);
  });

  it('creates no item for zero overage', async () => {
    const { deps, world } = makeWorld({ overageMinutes: 0 });
    const out = await processOverageInvoice(invoice(), deps);
    expect(out).toEqual({ outcome: 'skipped', status: 'skipped_zero' });
    expect(world.items).toHaveLength(0);
  });

  it('creates no item when the policy is allow (the default)', async () => {
    const { deps, world } = makeWorld({ overageMinutes: 50, policy: 'allow' });
    const out = await processOverageInvoice(invoice(), deps);
    expect(out).toEqual({ outcome: 'skipped', status: 'skipped_policy' });
    expect(world.items).toHaveLength(0);
  });

  it('does not bill plans without a rate (enterprise) or non-USD invoices', async () => {
    const ent = makeWorld({ overageMinutes: 50, plan: 'enterprise' });
    expect((await processOverageInvoice(invoice(), ent.deps)).outcome).toBe('skipped');
    expect(ent.world.items).toHaveLength(0);
    const eur = makeWorld({ overageMinutes: 50 });
    expect((await processOverageInvoice(invoice({ currency: 'eur' }), eur.deps)).outcome).toBe('skipped');
    expect(eur.world.items).toHaveLength(0);
  });

  it('never attaches to an invoice that is no longer a draft', async () => {
    const { deps, world } = makeWorld({ overageMinutes: 30, invoiceStatus: 'open' });
    const out = await processOverageInvoice(invoice(), deps);
    expect(out).toEqual({ outcome: 'needs_review', reason: 'invoice_not_draft:open' });
    expect(world.items).toHaveLength(0);
    expect([...world.ledger.values()][0].billing_status).toBe('needs_review');
  });

  it('refuses a ledger row whose amount disagrees with minutes x rate', async () => {
    const { deps, world } = makeWorld({ overageMinutes: 30 });
    const original = deps.rollover;
    deps.rollover = async (a) => ({ ...(await original(a)), amount_cents: 1 });
    const out = await processOverageInvoice(invoice(), deps);
    expect(out.outcome).toBe('needs_review');
    expect(world.items).toHaveLength(0);
  });

  it('ignores unknown or ambiguous customers (tenant isolation)', async () => {
    const { deps, world } = makeWorld();
    expect(await processOverageInvoice(invoice({ customer: 'cus_unknown' }), deps)).toEqual({ outcome: 'ignored', reason: 'no_profile' });
    expect(await processOverageInvoice(invoice({ customer: 'cus_dup' }), deps)).toEqual({ outcome: 'ignored', reason: 'ambiguous_profile' });
    expect(world.items).toHaveLength(0);
    expect(world.ledger.size).toBe(0);
  });

  it('prices the closing period on the better plan when a downgrade already hit the profile (renewal race)', async () => {
    // profile already shows Starter (400 min, 20c) but the running period was Professional (1500 min, 15c)
    const { deps, world } = makeWorld({ plan: 'starter', snapshotPlan: 'professional', usedMinutes: 1600 });
    const out = await processOverageInvoice(invoice(), deps);
    expect(world.rolloverArgs[0].p_plan_id).toBe('professional');
    expect(world.rolloverArgs[0].p_included_override).toBe(1500);
    expect(world.rolloverArgs[0].p_rate_cents).toBe(15);
    expect(out).toEqual({ outcome: 'billed', itemId: 'ii_1', amountCents: 1500, reusedExistingItem: false }); // 100 min x 15c, not 1200 x 20c
  });

  it('keeps the profile allowance (custom minutes) when the closing plan equals the current plan', async () => {
    const { deps, world } = makeWorld({ plan: 'starter', snapshotPlan: 'starter' });
    await processOverageInvoice(invoice(), deps);
    expect(world.rolloverArgs[0].p_included_override).toBeNull();
  });

  it('uses the upgraded plan when the customer upgraded mid-period', async () => {
    const { deps, world } = makeWorld({ plan: 'professional', snapshotPlan: 'starter', profileIncluded: 1500, usedMinutes: 1550 });
    await processOverageInvoice(invoice(), deps);
    expect(world.rolloverArgs[0].p_plan_id).toBe('professional');
    expect(world.rolloverArgs[0].p_included_override).toBeNull();
  });

  it('passes the plan of the new period (from the invoice lines) to the rollover', async () => {
    const { deps, world } = makeWorld();
    await processOverageInvoice(invoice({ lines: { data: [{ price: { id: 'price_starter' } }] } }), deps);
    expect(world.rolloverArgs[0].p_next_plan).toBe('starter');
  });

  it('records the first period plan when a subscription is created', async () => {
    const { deps, world } = makeWorld();
    const out = await processOverageInvoice(
      invoice({ billing_reason: 'subscription_create', lines: { data: [{ price: { id: 'price_pro' } }] } }),
      deps,
    );
    expect(out).toEqual({ outcome: 'snapshot_recorded', plan: 'professional' });
    expect(world.periodPlans.get(USER)).toBe('professional');
    expect(world.ledger.size).toBe(0);
    expect(world.items).toHaveLength(0);
  });

  it('does not record a snapshot for unknown prices or customers', async () => {
    const { deps, world } = makeWorld();
    expect(await processOverageInvoice(invoice({ billing_reason: 'subscription_create', lines: { data: [{ price: { id: 'price_x' } }] } }), deps)).toEqual({ outcome: 'ignored', reason: 'no_plan' });
    expect(await processOverageInvoice(invoice({ billing_reason: 'subscription_create', customer: 'cus_unknown', lines: { data: [{ price: { id: 'price_pro' } }] } }), deps)).toEqual({ outcome: 'ignored', reason: 'no_profile' });
    expect(world.periodPlans.size).toBe(0);
  });
});

describe('resolveClosingPlan / planFromInvoiceLines', () => {
  it('picks the higher-ranked plan', () => {
    expect(resolveClosingPlan('professional', 'starter')).toBe('professional');
    expect(resolveClosingPlan('starter', 'professional')).toBe('professional');
    expect(resolveClosingPlan('business', 'business')).toBe('business');
  });
  it('falls back safely', () => {
    expect(resolveClosingPlan(null, 'starter')).toBe('starter');
    expect(resolveClosingPlan('starter', null)).toBe('starter');
    expect(resolveClosingPlan(null, null)).toBeNull();
    expect(resolveClosingPlan('weird', 'starter')).toBe('starter');
  });
  it('reads the plan from invoice lines', () => {
    const map = (id: string) => (id === 'p1' ? 'business' : null);
    expect(planFromInvoiceLines({ lines: { data: [{ price: null }, { price: { id: 'x' } }, { price: { id: 'p1' } }] } }, map)).toBe('business');
    expect(planFromInvoiceLines({ lines: null }, map)).toBeNull();
    expect(planFromInvoiceLines({}, map)).toBeNull();
  });
});
