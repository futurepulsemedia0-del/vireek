import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CustomerStoriesPage } from './CustomerStoriesPage';
import { CASE_STUDIES } from '@/components/sections/CaseStudies';

const seo = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('@/lib/seo', () => ({ useSEO: (cfg: Record<string, unknown>) => void seo.calls.push(cfg) }));
vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/customers" element={<CustomerStoriesPage />} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(cleanup);
beforeEach(() => {
  seo.calls.length = 0;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('CustomerStoriesPage', () => {
  it('lists all stories, labels them, and shows the disclosure', () => {
    renderAt('/customers');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Stories from the trades/);
    expect(screen.getAllByRole('article')).toHaveLength(CASE_STUDIES.length);
    expect(screen.getByRole('note').textContent).toMatch(/illustrative/i);
    expect(screen.getAllByText('Illustrative example').length).toBe(CASE_STUDIES.length);
    const last = seo.calls[seo.calls.length - 1];
    expect(last.canonical).toBe('https://vireek.com/customers');
    expect((last.jsonLd as unknown[]).length).toBe(2);
  });

  it('filters by trade from the URL and via the chips', () => {
    renderAt('/customers?trade=hvac');
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^HVAC/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^Plumbing/ }));
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByText(/Ramirez Plumbing/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^All trades/ }));
    expect(screen.getAllByRole('article')).toHaveLength(CASE_STUDIES.length);
  });

  it('shows an honest empty state for a trade with no stories', () => {
    renderAt('/customers?trade=locksmith');
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.getByText(/No published Locksmith stories yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /see all stories/i }));
    expect(screen.getAllByRole('article')).toHaveLength(CASE_STUDIES.length);
  });

  it('ignores junk trade params', () => {
    renderAt('/customers?trade=%3Cscript%3E');
    expect(screen.getAllByRole('article')).toHaveLength(CASE_STUDIES.length);
  });
});
