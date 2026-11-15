import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LegalDocument, renderInline } from '@/components/legal/LegalDocument';
import { LEGAL_DOCS } from '@/lib/legalDocs';

beforeAll(() => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
});

describe('LegalDocument', () => {
  it.each(LEGAL_DOCS.map((d) => [d.slug, d] as const))('renders %s with title, every section and related links', (_s, doc) => {
    render(<MemoryRouter><LegalDocument doc={doc} /></MemoryRouter>);
    expect(screen.getByRole('heading', { level: 1, name: doc.title })).toBeInTheDocument();
    for (const s of doc.sections) expect(document.getElementById(s.id)).not.toBeNull();
    for (const r of doc.related) {
      const hit = screen.getAllByRole('link').some((a) => a.getAttribute('href') === r.href && (a.textContent ?? '').includes(r.label));
      expect(hit, r.label).toBe(true);
    }
  });

  it('renderInline drops unsafe hrefs and keeps the label as text', () => {
    render(<MemoryRouter><p>{renderInline('x [bad](javascript:alert(1)) y [ok](/privacy) **b**')}</p></MemoryRouter>);
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.getByRole('link', { name: 'ok' })).toHaveAttribute('href', '/privacy');
  });
});
