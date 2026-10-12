import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SmsTermsContent } from '@/components/sections/SmsTermsContent';

// Carriers and the campaign registry (TCR) reject A2P 10DLC campaigns whose
// public terms page lacks specific language. These tests fail loudly if a
// future edit removes any of it.
function pageText(): string {
  const { container } = render(
    <MemoryRouter>
      <SmsTermsContent />
    </MemoryRouter>,
  );
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

describe('SmsTermsContent (A2P 10DLC required language)', () => {
  beforeAll(() => {
    // jsdom has no IntersectionObserver (used by framer-motion whileInView).
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

  it('names the program and the sender', () => {
    const text = pageText();
    expect(text).toContain('Vireek Appointment & Service Messaging');
    expect(text).toMatch(/operated by Vireek on behalf of/i);
  });

  it('states frequency, rates, and that consent is not a condition of purchase', () => {
    const text = pageText();
    expect(text).toMatch(/message frequency varies/i);
    expect(text).toMatch(/message and data rates may apply/i);
    expect(text).toMatch(/not a condition of any purchase/i);
  });

  it('documents opt-out and help keywords', () => {
    const text = pageText();
    for (const word of ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'HELP']) {
      expect(text).toContain(word);
    }
  });

  it('describes how consent is collected and that it is not shared for marketing', () => {
    const text = pageText();
    expect(text).toMatch(/how you opt in/i);
    expect(text).toMatch(/not shared with third parties or affiliates for marketing/i);
  });

  it('links to the privacy policy, terms, and data request page', () => {
    const { container } = render(
      <MemoryRouter>
        <SmsTermsContent />
      </MemoryRouter>,
    );
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/privacy#sms-consent');
    expect(hrefs).toContain('/terms');
    expect(hrefs).toContain('/data-request');
    expect(hrefs).toContain('mailto:ali@vireek.com');
  });
});
