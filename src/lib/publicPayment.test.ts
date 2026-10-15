import { describe, it, expect, beforeEach, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke } } }));

import { createPublicPaymentIntent } from './publicPayment';

const TOKEN = 'b'.repeat(64);

describe('createPublicPaymentIntent', () => {
  beforeEach(() => invoke.mockReset());

  it('asks the server for an intent with the chosen tip and returns the client secret', async () => {
    invoke.mockResolvedValue({ data: { client_secret: 'pi_123_secret_abc' }, error: null });
    const secret = await createPublicPaymentIntent(TOKEN, { kind: 'percent', percent: 18 });
    expect(secret).toBe('pi_123_secret_abc');
    expect(invoke).toHaveBeenCalledWith('public-payment', { body: { action: 'intent', token: TOKEN, tip: { kind: 'percent', percent: 18 } } });
  });

  it('surfaces the server’s customer-facing message on failure', async () => {
    invoke.mockResolvedValue({ data: null, error: { context: { json: async () => ({ error: 'This invoice has already been paid.' }) } } });
    await expect(createPublicPaymentIntent(TOKEN, { kind: 'none' })).rejects.toThrow('This invoice has already been paid.');
  });

  it('falls back to a generic message when the error body is unreadable', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('boom') });
    await expect(createPublicPaymentIntent(TOKEN, { kind: 'none' })).rejects.toThrow('Something went wrong. Please try again.');
  });

  it('rejects a reply without a client secret', async () => {
    invoke.mockResolvedValue({ data: {}, error: null });
    await expect(createPublicPaymentIntent(TOKEN, { kind: 'none' })).rejects.toThrow('Could not start the payment.');
  });
});
