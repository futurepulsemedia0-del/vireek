// Invoice-outcome Stripe TEST-MODE records (Task E). PURE + fail-closed.
// This module never talks to Stripe. It only (a) decides whether a key is a test key and (b) builds plain data.
import type { OutcomeSnapshot, StatementState } from './outcomeStatement.ts';
import { isSnapshot } from './outcomeStatement.ts';

export type StripeGuard = { ok: true } | { ok: false; reason: 'missing_key' | 'not_test_key' | 'malformed_key' };

/** Accept ONLY test secret/restricted keys. Anything else (live, unknown, empty) fails closed. */
export function assertStripeTestKey(key: string | null | undefined): StripeGuard {
  if (typeof key !== 'string' || key.trim() === '') return { ok: false, reason: 'missing_key' };
  const k = key.trim();
  if (/^(sk|rk)_live_/.test(k)) return { ok: false, reason: 'not_test_key' };
  if (/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(k)) return { ok: true };
  return { ok: false, reason: /^(sk|rk)_/.test(k) ? 'malformed_key' : 'not_test_key' };
}

/** Defence in depth: after any Stripe call the API object must say livemode === false. */
export const responseIsTestMode = (obj: { livemode?: unknown } | null | undefined): boolean => !!obj && obj.livemode === false;

export interface StripeTestRecord {
  mode: 'test';
  identifier: string;
  statementId: string;
  stripeCustomerId: string;
  amountCents: number;
  currency: string;
  description: string;
}

export type RecordError = 'statement_not_approved' | 'bad_snapshot' | 'nothing_to_bill' | 'bad_customer_id' | 'bad_amount';

export function buildTestRecord(input: {
  statementId: string;
  state: StatementState;
  snapshot: unknown;
  billableCents: number;
  stripeCustomerId: string | null;
}): { ok: true; record: StripeTestRecord } | { ok: false; error: RecordError } {
  if (input.state !== 'approved') return { ok: false, error: 'statement_not_approved' };
  if (!isSnapshot(input.snapshot)) return { ok: false, error: 'bad_snapshot' };
  if (!input.stripeCustomerId || !/^cus_[A-Za-z0-9]+$/.test(input.stripeCustomerId)) return { ok: false, error: 'bad_customer_id' };
  if (!Number.isInteger(input.billableCents) || input.billableCents < 0 || input.billableCents > input.snapshot.totalCents) return { ok: false, error: 'bad_amount' };
  if (input.billableCents === 0) return { ok: false, error: 'nothing_to_bill' };
  const s: OutcomeSnapshot = input.snapshot;
  return {
    ok: true,
    record: {
      mode: 'test',
      identifier: `ivo-${input.statementId}`,
      statementId: input.statementId,
      stripeCustomerId: input.stripeCustomerId,
      amountCents: input.billableCents,
      currency: s.currency.toLowerCase(),
      description: `Vireek outcome statement ${s.period}`,
    },
  };
}
