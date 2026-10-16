import { describe, it, expect } from 'vitest';
import {
  canViewBilling,
  httpsUrlOrNull,
  normalizeCard,
  normalizeInvoice,
  sortCards,
  type StripeInvoiceLike,
} from './subscriptionInvoices';

const base: StripeInvoiceLike = {
  id: 'in_1',
  number: 'VIREEK-0001',
  status: 'paid',
  created: 1_790_000_000,
  currency: 'usd',
  total: 19900,
  amount_due: 0,
  amount_paid: 19900,
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1/test_1',
  invoice_pdf: 'https://pay.stripe.com/invoice/acct_1/test_1/pdf',
};

describe('normalizeInvoice', () => {
  it('maps a paid invoice and upper-cases the currency', () => {
    const dto = normalizeInvoice(base);
    expect(dto?.status).toBe('paid');
    expect(dto?.currency).toBe('USD');
    expect(dto?.total).toBe(19900);
    expect(dto?.pdfUrl).toBe(base.invoice_pdf);
    expect(dto?.createdAt).toBe(new Date(1_790_000_000 * 1000).toISOString());
  });

  it('hides drafts and unknown statuses — they are not customer-facing', () => {
    expect(normalizeInvoice({ ...base, status: 'draft' })).toBeNull();
    expect(normalizeInvoice({ ...base, status: null })).toBeNull();
    expect(normalizeInvoice({ ...base, status: 'something_new' })).toBeNull();
  });

  it('drops non-https URLs so javascript:/data: links never reach the browser', () => {
    const dto = normalizeInvoice({ ...base, invoice_pdf: 'javascript:alert(1)', hosted_invoice_url: 'http://insecure.example/x' });
    expect(dto?.pdfUrl).toBeNull();
    expect(dto?.hostedUrl).toBeNull();
  });

  it('prefers the first line item period and description, truncating long text', () => {
    const dto = normalizeInvoice({
      ...base,
      period_start: 1,
      period_end: 2,
      lines: { data: [{ description: 'x'.repeat(300), period: { start: 1_790_000_000, end: 1_792_592_000 } }] },
    });
    expect(dto?.description).toHaveLength(140);
    expect(dto?.periodStart).toBe(new Date(1_790_000_000 * 1000).toISOString());
    expect(dto?.periodEnd).toBe(new Date(1_792_592_000 * 1000).toISOString());
  });

  it('keeps open invoices with their retry info', () => {
    const dto = normalizeInvoice({ ...base, status: 'open', amount_due: 19900, amount_paid: 0, attempt_count: 2, next_payment_attempt: 1_790_100_000 });
    expect(dto?.status).toBe('open');
    expect(dto?.attemptCount).toBe(2);
    expect(dto?.nextPaymentAttemptAt).toBe(new Date(1_790_100_000 * 1000).toISOString());
  });
});

describe('httpsUrlOrNull', () => {
  it('accepts https, rejects everything else', () => {
    expect(httpsUrlOrNull('https://pay.stripe.com/x')).toBe('https://pay.stripe.com/x');
    expect(httpsUrlOrNull('http://pay.stripe.com/x')).toBeNull();
    expect(httpsUrlOrNull('not a url')).toBeNull();
    expect(httpsUrlOrNull(null)).toBeNull();
  });
});

describe('normalizeCard / sortCards', () => {
  const pm = (id: string, last4: string) => ({ id, card: { brand: 'Visa', last4, exp_month: 4, exp_year: 2030, funding: 'credit' } });

  it('skips payment methods without usable card details', () => {
    expect(normalizeCard({ id: 'pm_x' }, null)).toBeNull();
    expect(normalizeCard({ id: 'pm_x', card: { last4: '4242' } }, null)).toBeNull();
  });

  it('flags the default card and sorts it first', () => {
    const cards = [normalizeCard(pm('pm_a', '1111'), 'pm_b'), normalizeCard(pm('pm_b', '4242'), 'pm_b')].filter(
      (c): c is NonNullable<typeof c> => c !== null,
    );
    const sorted = sortCards(cards);
    expect(sorted[0].id).toBe('pm_b');
    expect(sorted[0].isDefault).toBe(true);
    expect(sorted[0].brand).toBe('visa');
    expect(sorted[1].isDefault).toBe(false);
  });
});

describe('canViewBilling', () => {
  const member = (over: Partial<NonNullable<Parameters<typeof canViewBilling>[0]['member']>> = {}) => ({
    inviteStatus: 'active',
    permissions: { can_view_billing: true },
    customRolePermissions: null,
    ...over,
  });

  it('always allows owners', () => {
    expect(canViewBilling({ profileRole: 'owner', member: null })).toBe(true);
  });

  it('allows an active member with the permission', () => {
    expect(canViewBilling({ profileRole: 'admin', member: member() })).toBe(true);
  });

  it('denies members without a team row, pending invites, or without the permission', () => {
    expect(canViewBilling({ profileRole: 'admin', member: null })).toBe(false);
    expect(canViewBilling({ profileRole: 'admin', member: member({ inviteStatus: 'pending' }) })).toBe(false);
    expect(canViewBilling({ profileRole: 'admin', member: member({ permissions: { can_view_billing: false } }) })).toBe(false);
  });

  it('lets the custom role override the base permissions, like the client does', () => {
    expect(canViewBilling({ profileRole: 'admin', member: member({ customRolePermissions: { can_view_billing: false } }) })).toBe(false);
    expect(
      canViewBilling({ profileRole: 'admin', member: member({ permissions: { can_view_billing: false }, customRolePermissions: { can_view_billing: true } }) }),
    ).toBe(true);
  });
});
