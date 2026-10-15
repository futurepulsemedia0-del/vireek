import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';

const h = vi.hoisted(() => ({
  order: [] as string[],
  submit: vi.fn(),
  confirmPayment: vi.fn(),
  update: vi.fn(),
  elementsProps: null as any,
  paymentElementProps: null as any,
  autoReady: true,
  getStripe: vi.fn(),
}));

vi.mock('@/lib/stripeLoader', () => ({ getStripe: h.getStripe }));

vi.mock('@stripe/react-stripe-js', async () => {
  const React = await import('react');
  return {
    Elements: (props: any) => {
      h.elementsProps = props;
      return React.createElement(React.Fragment, null, props.children);
    },
    PaymentElement: (props: any) => {
      h.paymentElementProps = props;
      React.useEffect(() => {
        if (h.autoReady) props.onReady?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return React.createElement('div', { 'data-testid': 'payment-element' });
    },
    useStripe: () => ({ confirmPayment: h.confirmPayment }),
    useElements: () => ({ submit: h.submit, update: h.update }),
  };
});

import { StripePaymentForm } from './StripePaymentForm';

const KEY = 'pk_test_51AbCdEfGhIjKlMnOp';

function setup(overrides: Partial<ComponentProps<typeof StripePaymentForm>> = {}) {
  const props = {
    publishableKey: KEY,
    amountCents: 11800,
    payLabel: 'Pay $118.00',
    returnUrl: 'https://vireek.com/pay-result?status=success',
    createIntent: vi.fn(async () => {
      h.order.push('createIntent');
      return 'pi_secret_123';
    }),
    onSuccess: vi.fn(),
    onProcessingChange: vi.fn(),
    ...overrides,
  };
  const view = render(<StripePaymentForm {...props} />);
  return { props, ...view };
}

const clickPay = () => fireEvent.click(screen.getByRole('button', { name: /pay \$|processing/i }));

beforeEach(() => {
  h.order.length = 0;
  h.autoReady = true;
  h.submit.mockReset().mockImplementation(async () => {
    h.order.push('submit');
    return {};
  });
  h.confirmPayment.mockReset().mockImplementation(async () => {
    h.order.push('confirm');
    return { paymentIntent: { status: 'succeeded' } };
  });
  h.update.mockReset();
  h.getStripe.mockReset().mockReturnValue(Promise.resolve({}));
});

describe('StripePaymentForm', () => {
  it('refuses to load Stripe.js with a missing or non-publishable key', () => {
    setup({ publishableKey: 'sk_live_not_a_publishable_key' });
    expect(screen.getByRole('alert').textContent).toMatch(/isn.t available/i);
    expect(h.getStripe).not.toHaveBeenCalled();
    expect(screen.queryByTestId('payment-element')).toBeNull();
  });

  it('initialises Elements as a deferred payment-mode intent in USD', () => {
    setup();
    expect(h.getStripe).toHaveBeenCalledWith(KEY);
    expect(h.elementsProps.options).toMatchObject({ mode: 'payment', amount: 11800, currency: 'usd' });
  });

  it('enables Apple Pay and Google Pay on the Payment Element', () => {
    setup();
    expect(h.paymentElementProps.options.wallets).toEqual({ applePay: 'auto', googlePay: 'auto' });
  });

  it('keeps the pay button disabled until the Payment Element is ready', () => {
    h.autoReady = false;
    setup();
    expect((screen.getByRole('button', { name: /pay \$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('validates the form first, then creates the intent, then confirms without forcing a redirect', async () => {
    const { props } = setup();
    clickPay();
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith('succeeded'));
    expect(h.order).toEqual(['submit', 'createIntent', 'confirm']);
    expect(h.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        clientSecret: 'pi_secret_123',
        redirect: 'if_required',
        confirmParams: { return_url: props.returnUrl },
      }),
    );
  });

  it('reports a processing payment (e.g. delayed method) as processing, not failed', async () => {
    h.confirmPayment.mockResolvedValue({ paymentIntent: { status: 'processing' } });
    const { props } = setup();
    clickPay();
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith('processing'));
  });

  it('does not create an intent or charge when the form fails validation', async () => {
    h.submit.mockResolvedValue({ error: { type: 'validation_error', message: 'Your card number is incomplete.' } });
    const { props } = setup();
    clickPay();
    expect((await screen.findByRole('alert')).textContent).toBe('Your card number is incomplete.');
    expect(props.createIntent).not.toHaveBeenCalled();
    expect(h.confirmPayment).not.toHaveBeenCalled();
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it('shows the server message and does not confirm when the intent cannot be created', async () => {
    const { props } = setup({ createIntent: vi.fn().mockRejectedValue(new Error('Tipping isn’t available for this payment.')) });
    clickPay();
    expect((await screen.findByRole('alert')).textContent).toBe('Tipping isn’t available for this payment.');
    expect(h.confirmPayment).not.toHaveBeenCalled();
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it('shows Stripe’s message for a declined card and lets the customer retry', async () => {
    h.confirmPayment.mockResolvedValueOnce({ error: { type: 'card_error', message: 'Your card was declined.' } });
    const { props } = setup();
    clickPay();
    expect((await screen.findByRole('alert')).textContent).toBe('Your card was declined.');
    expect((screen.getByRole('button', { name: /pay \$/i }) as HTMLButtonElement).disabled).toBe(false);

    clickPay();
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith('succeeded'));
  });

  it('hides internal error details for non-card errors', async () => {
    h.confirmPayment.mockResolvedValue({ error: { type: 'api_error', message: 'No such PaymentIntent: pi_internal' } });
    setup();
    clickPay();
    const text = (await screen.findByRole('alert')).textContent ?? '';
    expect(text).not.toMatch(/pi_internal/);
    expect(text).toMatch(/not been charged/i);
  });

  it('treats an unexpected throw as a generic failure instead of hanging', async () => {
    h.confirmPayment.mockRejectedValue(new Error('network'));
    setup();
    clickPay();
    expect((await screen.findByRole('alert')).textContent).toMatch(/not been charged/i);
    expect((screen.getByRole('button', { name: /pay \$/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('ignores a second click while a payment is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    h.submit.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    setup();
    const button = screen.getByRole('button', { name: /pay \$/i });
    fireEvent.click(button);
    fireEvent.click(button);
    release({});
    await waitFor(() => expect(h.confirmPayment).toHaveBeenCalledTimes(1));
  });

  it('pushes a changed total (tip) into Elements so the wallet sheet shows the right amount', () => {
    const { rerender, props } = setup();
    rerender(<StripePaymentForm {...props} amountCents={13600} payLabel="Pay $136.00" />);
    expect(h.update).toHaveBeenLastCalledWith({ amount: 13600 });
  });

  it('reports processing state to the parent so it can lock the tip selector', async () => {
    const { props } = setup();
    clickPay();
    await waitFor(() => expect(props.onProcessingChange).toHaveBeenCalledWith(true));
    await waitFor(() => expect(props.onProcessingChange).toHaveBeenLastCalledWith(false));
  });
});
