import { describe, it, expect } from 'vitest';
import {
  GENERIC_PAYMENT_ERROR,
  PAYMENT_ELEMENT_OPTIONS,
  buildAppearance,
  buildElementsOptions,
  buildReturnUrl,
  describePaymentError,
  isValidPublishableKey,
  rgbTripletToHex,
} from './paymentElement';

describe('PAYMENT_ELEMENT_OPTIONS', () => {
  it('lets Stripe show Apple Pay and Google Pay whenever the device and domain allow it', () => {
    expect(PAYMENT_ELEMENT_OPTIONS.wallets).toEqual({ applePay: 'auto', googlePay: 'auto' });
  });
});

describe('buildElementsOptions', () => {
  it('builds a deferred USD payment-mode configuration', () => {
    const appearance = buildAppearance({ dark: false });
    expect(buildElementsOptions(12345, appearance)).toEqual({ mode: 'payment', amount: 12345, currency: 'usd', appearance });
  });
});

describe('isValidPublishableKey', () => {
  it('accepts only publishable keys', () => {
    expect(isValidPublishableKey('pk_test_51AbCdEfGhIjKl')).toBe(true);
    expect(isValidPublishableKey('pk_live_51AbCdEfGhIjKl')).toBe(true);
  });

  it('rejects secret keys, junk and empty values so they can never reach the browser SDK', () => {
    expect(isValidPublishableKey('sk_live_51AbCdEfGhIjKl')).toBe(false);
    expect(isValidPublishableKey('rk_live_51AbCdEfGhIjKl')).toBe(false);
    expect(isValidPublishableKey('pk_test_')).toBe(false);
    expect(isValidPublishableKey('')).toBe(false);
    expect(isValidPublishableKey(null)).toBe(false);
    expect(isValidPublishableKey(undefined)).toBe(false);
  });
});

describe('rgbTripletToHex', () => {
  it('converts the Tailwind CSS-variable triplet to hex', () => {
    expect(rgbTripletToHex('37 99 235')).toBe('#2563eb');
    expect(rgbTripletToHex(' 37, 99, 235 ')).toBe('#2563eb');
    expect(rgbTripletToHex('0 0 0')).toBe('#000000');
  });

  it('returns null for anything that is not a valid triplet', () => {
    expect(rgbTripletToHex('')).toBeNull();
    expect(rgbTripletToHex('37 99')).toBeNull();
    expect(rgbTripletToHex('300 0 0')).toBeNull();
    expect(rgbTripletToHex('a b c')).toBeNull();
    expect(rgbTripletToHex('1.5 2 3')).toBeNull();
  });
});

describe('buildAppearance', () => {
  it('follows the app theme and brand accent', () => {
    const light = buildAppearance({ dark: false, accentTriplet: '37 99 235' });
    expect(light.theme).toBe('stripe');
    expect(light.variables?.colorPrimary).toBe('#2563eb');
    expect(buildAppearance({ dark: true }).theme).toBe('night');
  });

  it('falls back to a safe accent when the CSS variable is missing', () => {
    expect(buildAppearance({ dark: false, accentTriplet: '' }).variables?.colorPrimary).toBe('#2563eb');
  });
});

describe('buildReturnUrl', () => {
  it('points at the existing result page without a double slash', () => {
    expect(buildReturnUrl('https://vireek.com')).toBe('https://vireek.com/pay-result?status=success');
    expect(buildReturnUrl('https://vireek.com/')).toBe('https://vireek.com/pay-result?status=success');
  });
});

describe('describePaymentError', () => {
  it('shows Stripe’s customer-safe message for card and validation errors', () => {
    expect(describePaymentError({ type: 'card_error', message: 'Your card was declined.' })).toBe('Your card was declined.');
    expect(describePaymentError({ type: 'validation_error', message: 'Your card number is incomplete.' })).toBe('Your card number is incomplete.');
  });

  it('never leaks internals for other error types', () => {
    expect(describePaymentError({ type: 'api_error', message: 'No such PaymentIntent: pi_123' })).toBe(GENERIC_PAYMENT_ERROR);
    expect(describePaymentError({ type: 'card_error' })).toBe(GENERIC_PAYMENT_ERROR);
    expect(describePaymentError(null)).toBe(GENERIC_PAYMENT_ERROR);
  });
});
