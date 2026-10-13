import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { UseCasePage } from './UseCasePage';
import { USE_CASES } from '@/lib/useCases';

const seo = vi.hoisted(() => vi.fn());

vi.mock('@/lib/seo', () => ({ useSEO: seo }));
vi.mock('@/components/Header', () => ({ Header: () => <header /> }));
vi.mock('@/components/Footer', () => ({ Footer: () => <footer /> }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));
vi.mock('@/pages/NotFoundPage', () => ({ NotFoundPage: () => <h1>Page not found</h1> }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  const motionOnly = new Set(['initial', 'animate', 'whileInView', 'viewport', 'variants', 'transition']);
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        function MotionStub({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) {
          const domProps = Object.fromEntries(Object.entries(props).filter(([key]) => !motionOnly.has(key)));
          return React.createElement(tag, domProps, children);
        },
    },
  );
  return { motion };
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/use-cases/:slug" element={<UseCasePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  seo.mockClear();
});

describe('UseCasePage', () => {
  it.each(USE_CASES.map((u) => [u.slug, u.headline] as const))('renders the %s scenario with its headline', (slug, headline) => {
    renderAt(`/use-cases/${slug}`);
    expect(screen.getByRole('heading', { level: 1, name: headline })).toBeInTheDocument();
  });

  it('offers a working primary CTA and a demo link', () => {
    renderAt('/use-cases/missed-calls');
    const trialLinks = screen.getAllByRole('link', { name: 'Start Free Trial' });
    expect(trialLinks.length).toBeGreaterThanOrEqual(2);
    expect(trialLinks[0]).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: /Book a demo/ })).toHaveAttribute('href', '/demo');
  });

  it('sets a canonical URL plus breadcrumb and FAQ structured data', () => {
    renderAt('/use-cases/emergency-dispatch');
    expect(seo).toHaveBeenCalledTimes(1);
    const config = seo.mock.calls[0][0] as { canonical: string; jsonLd: { '@type': string }[] };
    expect(config.canonical).toBe('https://vireek.com/use-cases/emergency-dispatch');
    expect(config.jsonLd.map((item) => item['@type'])).toEqual(['BreadcrumbList', 'FAQPage']);
  });

  it('cross-links the other scenarios but not itself', () => {
    renderAt('/use-cases/after-hours');
    const nav = screen.getByRole('navigation', { name: 'Other use cases' });
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/use-cases/missed-calls', '/use-cases/emergency-dispatch', '/use-cases/estimate-follow-up']);
  });

  it('shows the 404 page, without indexable SEO, for an unknown slug', () => {
    renderAt('/use-cases/does-not-exist');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(seo).not.toHaveBeenCalled();
  });
});
