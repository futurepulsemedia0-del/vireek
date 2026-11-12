import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { TermsContent } from '@/components/sections/TermsContent';
import { RefundPolicyContent } from '@/components/sections/RefundPolicyContent';
import { SlaContent } from '@/components/sections/SlaContent';
import { AcceptableUseContent } from '@/components/sections/AcceptableUseContent';
import { PRICING_PLANS } from '@/lib/pricing';
import termsSource from './TermsContent.tsx?raw';
import refundSource from './RefundPolicyContent.tsx?raw';
import slaSource from './SlaContent.tsx?raw';
import aupSource from './AcceptableUseContent.tsx?raw';

// Guards the billing / limits / trial / SLA wording. Every new clause block must stay
// marked for lawyer review, and the pages must not drift away from lib/pricing.ts.
const MARKER = '{/* LEGAL-REVIEW-REQUIRED */}';
const count = (src: string) => src.split(MARKER).length - 1;

function pageText(ui: ReactElement): string {
  const { container } = render(<MemoryRouter>{ui}</MemoryRouter>);
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

beforeAll(() => {
  // jsdom has no IntersectionObserver (used by framer-motion whileInView and the TOC).
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    },
  );
});

describe('TermsContent', () => {
  it('states included-minutes, metering, top-up and overage rules', () => {
    const text = pageText(<TermsContent />);
    expect(text).toMatch(/do not roll over/i);
    expect(text).toMatch(/rounded up to the next whole minute/i);
    expect(text).toMatch(/Top-up minutes .* remain available until used/i);
    expect(text).toMatch(/overage is enabled for your account/i);
    expect(text).toMatch(/voice answering may pause/i);
  });

  it('states the trial terms: 14 days, card required, 60 minutes total, converts, one per account', () => {
    const text = pageText(<TermsContent />);
    expect(text).toMatch(/14 days/);
    expect(text).toMatch(/60 minutes in total/);
    expect(text).toMatch(/payment card is required/i);
    expect(text).toMatch(/converts to the plan you selected/i);
    expect(text).toMatch(/one trial per account/i);
    expect(text).not.toMatch(/does not require a credit card/i);
  });

  it('shows every plan from lib/pricing.ts with its price and overage rate', () => {
    const text = pageText(<TermsContent />);
    for (const p of PRICING_PLANS) {
      expect(text).toContain(p.name);
      if (p.monthly) expect(text).toContain(`$${p.monthly}/month`);
      if (p.annual) expect(text).toContain(`$${p.annual}/year`);
      if (p.id !== 'enterprise' && p.overage) expect(text).toContain(p.overage);
    }
  });

  it('covers fair use, SLA scope, taxes, price-change notice and the liability placeholder', () => {
    const text = pageText(<TermsContent />);
    expect(text).toMatch(/toll fraud, SMS pumping/i);
    expect(text).toMatch(/Other plans have no SLA/i);
    expect(text).toMatch(/exclusive of taxes/i);
    expect(text).toMatch(/at least 30 days/i);
    expect(text).toMatch(/WORDING TO BE FINALIZED BY COUNSEL/);
  });

  it('keeps the section ids that other pages link to', () => {
    const { container } = render(<MemoryRouter><TermsContent /></MemoryRouter>);
    for (const id of ['subscription-plans-and-billing', 'included-minutes-and-overage', 'free-trial-terms', 'ai-service-disclaimer', 'limitation-of-liability', 'termination']) {
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
    }
  });

  it('keeps new clause blocks marked for legal review', () => {
    expect(count(termsSource)).toBeGreaterThanOrEqual(14);
    expect(termsSource).toContain('[LAWYER TO CONFIRM]');
  });
});

describe('RefundPolicyContent', () => {
  it('reconciles the trial section with a card-required trial and leaves refund terms in place', () => {
    const text = pageText(<RefundPolicyContent />);
    expect(text).toMatch(/cancel before the trial ends/i);
    expect(text).not.toMatch(/no payment is collected during a free trial/i);
    // Refund terms must not change in this edit.
    expect(text).toMatch(/non-refundable/i);
    expect(text).toMatch(/first 7 days of your first paid subscription/i);
    expect(text).toMatch(/within 2 business days/i);
  });

  it('keeps new clause blocks marked for legal review', () => {
    expect(count(refundSource)).toBeGreaterThanOrEqual(5);
  });
});

describe('SlaContent', () => {
  it('limits numeric uptime commitments to Enterprise order forms', () => {
    const text = pageText(<SlaContent />);
    expect(text).toMatch(/only in Enterprise order forms/i);
    expect(text).toMatch(/not covered by an SLA/i);
    expect(text).not.toMatch(/99\.\d%/);
  });

  it('keeps new clause blocks marked for legal review', () => {
    expect(count(slaSource)).toBeGreaterThanOrEqual(3);
  });
});

describe('AcceptableUseContent', () => {
  it('prohibits toll fraud and SMS pumping and explains caps and throttling', () => {
    const text = pageText(<AcceptableUseContent />);
    expect(text).toMatch(/toll fraud/i);
    expect(text).toMatch(/SMS pumping/i);
    expect(text).toMatch(/caps such as maximum call length, daily spend/i);
    expect(text).toMatch(/throttle, restrict, or suspend/i);
    expect(text).toMatch(/A2P 10DLC/);
  });

  it('keeps new clause blocks marked for legal review', () => {
    expect(count(aupSource)).toBeGreaterThanOrEqual(7);
  });
});
