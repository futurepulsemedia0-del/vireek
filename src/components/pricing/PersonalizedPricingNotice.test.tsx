import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PersonalizedPricingNotice } from './PersonalizedPricingNotice';
import en from '@/locales/en/pricingDisclosure.json';
import { PERSONALIZED_PRICING_FLAG } from '@/lib/pricingPersonalization';

// Vitest globals are off in this project, so RTL's auto-cleanup isn't registered.
afterEach(cleanup);

const flags = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock('@/hooks/useFeatureFlag', () => ({ useFeatureFlag: (key: string) => flags.on.has(key) }));
// Real English strings from the shipped locale file.
vi.mock('@/i18n/pricingDisclosureNamespace', () => ({
  usePricingDisclosureT: () => ({
    language: 'en',
    t: (key: string) => {
      const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);
      return typeof v === 'string' ? v : key;
    },
  }),
}));

describe('PersonalizedPricingNotice', () => {
  beforeEach(() => { flags.on = new Set(); });

  it('renders nothing while the flag is off, even on a personalized path', () => {
    const { container } = render(<PersonalizedPricingNotice path="outcome_pricing" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the location notice for an active surge when the flag is on', () => {
    flags.on.add(PERSONALIZED_PRICING_FLAG);
    render(<PersonalizedPricingNotice path="service_area_surge" />);
    const note = screen.getByTestId('personalized-pricing-notice');
    expect(note).toHaveAttribute('data-variant', 'location');
    expect(note).toHaveAttribute('role', 'note');
    expect(note).toHaveAttribute('aria-label', en.notice.aria);
    expect(screen.getByText(en.notice.location.title)).toBeInTheDocument();
    expect(screen.getByText(en.notice.location.body)).toBeInTheDocument();
  });

  it('hides the surge notice when no surge is applied to this price', () => {
    flags.on.add(PERSONALIZED_PRICING_FLAG);
    const { container } = render(<PersonalizedPricingNotice path="service_area_surge" applied={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the modeled notice for outcome pricing', () => {
    flags.on.add(PERSONALIZED_PRICING_FLAG);
    render(<PersonalizedPricingNotice path="outcome_pricing" />);
    expect(screen.getByTestId('personalized-pricing-notice')).toHaveAttribute('data-variant', 'modeled');
    expect(screen.getByText(en.notice.modeled.title)).toBeInTheDocument();
  });

  it('never shows on a tiered estimate, flag on or off', () => {
    flags.on.add(PERSONALIZED_PRICING_FLAG);
    const { container } = render(<PersonalizedPricingNotice path="tiered_estimate" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('never shows for lender-decided financing terms', () => {
    flags.on.add(PERSONALIZED_PRICING_FLAG);
    const { container } = render(<PersonalizedPricingNotice path="financing_offer" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a learn-more link only when a destination is given', () => {
    flags.on.add(PERSONALIZED_PRICING_FLAG);
    const { rerender } = render(<PersonalizedPricingNotice path="price_list_override" />);
    expect(screen.queryByRole('link')).toBeNull();
    rerender(<PersonalizedPricingNotice path="price_list_override" learnMoreHref="/privacy" />);
    expect(screen.getByRole('link', { name: en.notice.learnMore })).toHaveAttribute('href', '/privacy');
  });

  it('uses logical (RTL-safe) alignment and no physical left/right utilities', () => {
    flags.on.add(PERSONALIZED_PRICING_FLAG);
    render(<PersonalizedPricingNotice path="service_area_travel_fee" />);
    const cls = screen.getByTestId('personalized-pricing-notice').className;
    expect(cls).toContain('text-start');
    expect(cls).not.toMatch(/\b(?:text-left|text-right|ml-|mr-|pl-|pr-)/);
  });
});
