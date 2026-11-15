import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { logMissMock } = vi.hoisted(() => ({ logMissMock: vi.fn() }));
vi.mock('@/lib/feedback/api', () => ({ logHelpSearchMiss: logMissMock }));
vi.mock('@/contexts/AccessibilityContext', () => ({ useAccessibility: () => ({ language: 'en' }) }));
vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));

import { HelpCenterPage } from '@/pages/HelpCenterPage';
import { HELP_ARTICLES } from '@/lib/helpArticles';
import { HELP_CATEGORIES } from '@/lib/helpContent';

function renderAt(path = '/help') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/help" element={<HelpCenterPage />} />
        <Route path="/help/:slug" element={<p>Article page</p>} />
        <Route path="/contact" element={<p>Contact page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const scrollToMock = vi.fn();

beforeEach(() => {
  logMissMock.mockReset();
  logMissMock.mockResolvedValue(undefined);
  scrollToMock.mockReset();
  Object.defineProperty(window, 'scrollTo', { value: scrollToMock, writable: true, configurable: true });
  // jsdom has no IntersectionObserver; framer-motion's whileInView and the scroll-spy both feature-detect it.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  document.head.querySelectorAll('script[type="application/ld+json"]').forEach((el) => el.remove());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('HelpCenterPage', () => {
  it('lists every article as a link to its own page, not as an accordion', () => {
    renderAt();
    for (const category of HELP_CATEGORIES) {
      const list = screen.getByRole('list', { name: `${category.name} articles` });
      const expected = HELP_ARTICLES.filter((a) => a.categoryId === category.id);
      const links = within(list).getAllByRole('link');
      expect(links).toHaveLength(expected.length);
      expected.forEach((article, i) => {
        expect(links[i]).toHaveAttribute('href', `/help/${article.slug}`);
        expect(links[i]).toHaveTextContent(article.title);
      });
    }
    // No article row is an expandable control any more.
    expect(document.querySelectorAll('[aria-expanded]').length).toBe(0);
  });

  it('shows a decorative document icon on every article row', () => {
    renderAt();
    const rows = screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/help/'));
    expect(rows).toHaveLength(HELP_ARTICLES.length);
    for (const row of rows) {
      const icon = row.querySelector('svg');
      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('shows the article count per category', () => {
    renderAt();
    const first = HELP_CATEGORIES[0];
    const count = HELP_ARTICLES.filter((a) => a.categoryId === first.id).length;
    expect(screen.getAllByText(`${count} article${count === 1 ? '' : 's'}`).length).toBeGreaterThan(0);
  });

  it('filters with the shared ranked search and shows the category on each result', () => {
    renderAt();
    fireEvent.change(screen.getByRole('textbox', { name: /search the help center/i }), { target: { value: 'invite' } });
    const list = screen.getByRole('list', { name: 'Search results' });
    const links = within(list).getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveTextContent(/invite a team member/i);
    expect(links[0]).toHaveTextContent(/Team & Permissions/);
    expect(screen.getByRole('status')).toHaveTextContent(/matching "invite"/);
  });

  it('does not filter on a single character', () => {
    renderAt();
    fireEvent.change(screen.getByRole('textbox', { name: /search the help center/i }), { target: { value: 'a' } });
    expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
    expect(screen.getAllByRole('list').length).toBeGreaterThanOrEqual(HELP_CATEGORIES.length);
  });

  it('shows an empty state and records the miss once, after a pause', async () => {
    vi.useFakeTimers();
    renderAt();
    fireEvent.change(screen.getByRole('textbox', { name: /search the help center/i }), { target: { value: 'zzzxqv' } });
    expect(screen.getByText('No matching articles')).toBeInTheDocument();
    expect(logMissMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(logMissMock).toHaveBeenCalledTimes(1);
    expect(logMissMock).toHaveBeenCalledWith('zzzxqv');
  });

  it('does not log a miss when the query has results', async () => {
    vi.useFakeTimers();
    renderAt();
    fireEvent.change(screen.getByRole('textbox', { name: /search the help center/i }), { target: { value: 'billing' } });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(logMissMock).not.toHaveBeenCalled();
  });

  it('scrolls to a category when opened with a #hash deep link', async () => {
    renderAt('/help#billing');
    await waitFor(() => expect(scrollToMock).toHaveBeenCalled());
  });

  it('ignores an unknown or malformed #hash', async () => {
    renderAt('/help#not-a-category');
    renderAt('/help#%E0%A4%A');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it('jumps to a category from the sidebar', () => {
    renderAt();
    const nav = screen.getByRole('navigation', { name: 'Help Center categories' });
    fireEvent.click(within(nav).getByRole('button', { name: new RegExp(HELP_CATEGORIES[2].name) }));
    expect(scrollToMock).toHaveBeenCalledTimes(1);
  });

  it('emits CollectionPage + BreadcrumbList JSON-LD and no FAQPage on the hub', () => {
    renderAt();
    const schemas = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) =>
      JSON.parse(s.textContent ?? '{}'),
    );
    const types = schemas.map((s) => s['@type']);
    expect(types).toEqual(expect.arrayContaining(['CollectionPage', 'BreadcrumbList']));
    expect(types).not.toContain('FAQPage');
    const collection = schemas.find((s) => s['@type'] === 'CollectionPage');
    expect(collection.mainEntity.numberOfItems).toBe(HELP_ARTICLES.length);
    expect(collection.mainEntity.itemListElement[0].url).toBe(`https://vireek.com/help/${HELP_ARTICLES[0].slug}`);
  });
});
