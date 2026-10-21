import { describe, expect, it } from 'vitest';
import { buildElementsOptions } from './paymentElement';

const appearance = { theme: 'stripe' } as never;

describe('buildElementsOptions setupFutureUsage', () => {
  it('stays unchanged for ordinary payments', () => {
    expect(buildElementsOptions(100, appearance)).not.toHaveProperty('setupFutureUsage');
  });
  it('matches the PaymentIntent when the card is saved for renewals', () => {
    expect(buildElementsOptions(100, appearance, 'off_session')).toMatchObject({ mode: 'payment', amount: 100, setupFutureUsage: 'off_session' });
  });
});
