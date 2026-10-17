import { describe, it, expect } from 'vitest';
import { buildStripeEvidence, isHandledDisputeEvent, normalizeDispute } from './normalize';

const stripeDispute = {
  id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 45000, currency: 'USD', reason: 'fraudulent', status: 'needs_response',
  created: 1_790_000_000, is_charge_refundable: false,
  evidence_details: { due_by: 1_790_600_000, has_evidence: false, past_due: false, submission_count: 0 },
  balance_transactions: [{ net: -4515 }, { net: -1500 }],
  payment_method_details: { card: { network_reason_code: '10.4' } },
};

describe('disputes normalize', () => {
  it('maps a Stripe dispute to the flat ingest shape', () => {
    const n = normalizeDispute(stripeDispute);
    expect(n).toMatchObject({ stripe_dispute_id: 'dp_1', stripe_payment_intent_id: 'pi_1', amount_cents: 45000, currency: 'usd', reason: 'fraudulent', network_reason_code: '10.4', evidence_due_by: 1_790_600_000 });
    expect(n.net_balance_cents).toBe(-4515 - 1500);
  });
  it('accepts expanded charge / payment_intent objects', () => {
    expect(normalizeDispute({ ...stripeDispute, charge: { id: 'ch_9' }, payment_intent: { id: 'pi_9' } })).toMatchObject({ stripe_charge_id: 'ch_9', stripe_payment_intent_id: 'pi_9' });
  });
  it('tolerates missing optional parts and rejects malformed objects', () => {
    const n = normalizeDispute({ id: 'dp_2', status: 'won' });
    expect(n).toMatchObject({ amount_cents: 0, currency: 'usd', evidence_due_by: null, submission_count: 0, net_balance_cents: 0 });
    expect(() => normalizeDispute({ status: 'won' })).toThrow();
    expect(() => normalizeDispute(null)).toThrow();
  });
  it('only handles charge.dispute.* events', () => {
    expect(isHandledDisputeEvent('charge.dispute.closed')).toBe(true);
    expect(isHandledDisputeEvent('charge.refunded')).toBe(false);
  });
  it('builds evidence: trims text, drops empties, ignores unknown keys, last file per category wins', () => {
    const ev = buildStripeEvidence(
      { product_description: '  AC repair  ', service_date: '', evil_key: 'x', customer_name: 5 },
      [{ category: 'receipt', stripe_file_id: 'file_1' }, { category: 'receipt', stripe_file_id: 'file_2' }, { category: 'bogus', stripe_file_id: 'file_3' }],
    );
    expect(ev).toEqual({ product_description: 'AC repair', receipt: 'file_2' });
  });
});
