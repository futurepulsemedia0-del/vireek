import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: rpcMock } }));
vi.mock('@/contexts/AccessibilityContext', () => ({ useAccessibility: () => ({ language: 'en' }) }));
vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));

import { HelpArticlePage } from '@/pages/HelpArticlePage';
import { HELP_ARTICLES } from '@/lib/helpArticles';

const article = HELP_ARTICLES[0];

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/help/:slug" element={<HelpArticlePage />} />
        <Route path="/contact" element={<p>Contact page</p>} />
        <Route path="/help" element={<p>Help home</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: { success: true }, error: null });
});

describe('HelpArticlePage', () => {
  it('renders the article with breadcrumb, related links and SEO tags', () => {
    renderAt(`/help/${article.slug}`);
    expect(screen.getByRole('heading', { level: 1, name: article.title })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Related articles' })).toBeInTheDocument();

    expect(document.title).toBe(`${article.title} | Vireek Help Center`);
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      `https://vireek.com/help/${article.slug}`,
    );
    const types = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(
      (s) => JSON.parse(s.textContent ?? '{}')['@type'],
    );
    expect(types).toEqual(expect.arrayContaining(['FAQPage', 'BreadcrumbList']));
  });

  it('shows a noindex not-found state with search for unknown slugs', () => {
    renderAt('/help/does-not-exist');
    expect(screen.getByRole('heading', { name: /couldn’t find that article/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /search help articles/i })).toBeInTheDocument();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, follow');
  });

  it('searches and navigates to a result', async () => {
    renderAt(`/help/${article.slug}`);
    fireEvent.change(screen.getByRole('combobox', { name: /search help articles/i }), { target: { value: 'invite' } });
    fireEvent.click(await screen.findByRole('option', { name: /invite a team member/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /invite a team member/i })).toBeInTheDocument();
  });

  it('shows a no-results state with a support link', async () => {
    renderAt(`/help/${article.slug}`);
    fireEvent.change(screen.getByRole('combobox', { name: /search help articles/i }), { target: { value: 'zzzxqv' } });
    expect(await screen.findByText(/No articles match/i)).toBeInTheDocument();
  });

  it('records a helpful vote and remembers it', async () => {
    const { unmount } = renderAt(`/help/${article.slug}`);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(await screen.findByText('Thanks for your feedback.')).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledWith(
      'submit_help_feedback',
      expect.objectContaining({ p_slug: article.slug, p_helpful: true, p_comment: null }),
    );
    unmount();
    renderAt(`/help/${article.slug}`);
    expect(screen.getByText('Thanks for your feedback.')).toBeInTheDocument();
  });

  it('collects an optional comment for a not-helpful vote', async () => {
    renderAt(`/help/${article.slug}`);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    fireEvent.change(screen.getByLabelText(/what were you looking for/i), { target: { value: '  Need pricing  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(await screen.findByText('Thanks for your feedback.')).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledWith(
      'submit_help_feedback',
      expect.objectContaining({ p_helpful: false, p_comment: 'Need pricing' }),
    );
  });

  it('shows an error and lets the visitor retry', async () => {
    rpcMock.mockRejectedValueOnce(new Error('boom'));
    renderAt(`/help/${article.slug}`);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t send|couldn't send|offline/i);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Thanks for your feedback.')).toBeInTheDocument();
  });
});
