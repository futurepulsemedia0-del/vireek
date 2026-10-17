import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AlternativePage } from './AlternativePage';

const seo = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('@/lib/seo', () => ({ useSEO: (cfg: Record<string, unknown>) => void seo.calls.push(cfg) }));
vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));
vi.mock('@/components/ui/BackButton', () => ({ BackButton: () => null }));

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/alternatives/:competitor" element={<><AlternativePage /><Where /></>} />
        <Route path="/compare" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  seo.calls.length = 0;
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO;
});

describe('AlternativePage', () => {
  it('renders the page for a known competitor with SEO + structured data', () => {
    renderAt('/alternatives/servicetitan');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/ServiceTitan alternative/i);
    expect(screen.getAllByRole('link', { name: /start free trial/i }).length).toBeGreaterThan(0);
    const last = seo.calls[seo.calls.length - 1];
    expect(last.canonical).toBe('https://vireek.com/alternatives/servicetitan');
    expect(String(last.title)).toContain('ServiceTitan');
    expect((last.jsonLd as unknown[]).length).toBe(2);
  });

  it('renders a feature table for field-service tools and positioning cards for hybrid AI', () => {
    const { unmount } = renderAt('/alternatives/jobber');
    expect(screen.getByRole('table')).toBeInTheDocument();
    unmount();
    renderAt('/alternatives/smith-ai');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText(/different focus/i)).toBeInTheDocument();
  });

  it('redirects an alias to the canonical URL', () => {
    renderAt('/alternatives/ruby-receptionists');
    expect(screen.getByTestId('where').textContent).toBe('/alternatives/ruby');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Ruby/);
  });

  it('redirects an unknown competitor to /compare', () => {
    renderAt('/alternatives/does-not-exist');
    expect(screen.getByTestId('where').textContent).toBe('/compare');
  });
});
