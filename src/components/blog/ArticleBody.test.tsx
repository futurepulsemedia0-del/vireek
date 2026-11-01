import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArticleBody } from '@/components/blog/ArticleBody';
import { FaqAccordion } from '@/components/blog/ArticleChrome';
import type { Block, BlogFaq, Inline } from '@/lib/blogTypes';

vi.mock('@/components/sections/MissedCallCalculator', () => ({ MissedCallCalculator: () => <div>calculator</div> }));
const ctaClick = vi.fn();
vi.mock('@/lib/blogAnalytics', () => ({
  blogEvents: { ctaClick: (...a: unknown[]) => ctaClick(...a), calculatorUse: vi.fn(), scrollDepth: vi.fn(), share: vi.fn(), newsletterSignup: vi.fn() },
  SCROLL_MILESTONES: [25, 50, 75, 90],
}));

const t = (v: string): Inline[] => [{ t: 'text', v }];
const blocks: Block[] = [
  { t: 'h2', id: 'first', c: t('First') },
  { t: 'p', c: [{ t: 'text', v: 'See ' }, { t: 'link', href: '/pricing', c: t('pricing') }, { t: 'text', v: ' and ' }, { t: 'link', href: 'https://example.com', c: t('a source') }, { t: 'text', v: ' <script>alert(1)</script>' }] },
  { t: 'table', head: [t('Option'), t('Cost')], rows: [[t('A'), t('$1')]] },
  { t: 'callout', kind: 'warning', c: [{ t: 'p', c: t('Careful here.') }] },
  { t: 'steps', items: [t('One'), t('Two')] },
  { t: 'figure', src: '/og-image.png', alt: 'Diagram of the call flow', width: 1200, height: 630, caption: t('Call flow') },
  { t: 'cta', type: 'demo', heading: 'See it live', button: '', body: [] },
];

const renderBody = () => render(<MemoryRouter><ArticleBody blocks={blocks} slug="demo-post" /></MemoryRouter>);

describe('ArticleBody', () => {
  beforeEach(() => ctaClick.mockClear());

  it('renders headings with anchor ids and an accessible, scrollable table', () => {
    renderBody();
    expect(screen.getByRole('heading', { level: 2, name: 'First' }).id).toBe('first');
    const region = screen.getByRole('region', { name: /table/i });
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
  });

  it('treats content as text: no HTML injection, safe external links', () => {
    const { container } = renderBody();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    const ext = screen.getByRole('link', { name: 'a source' });
    expect(ext.getAttribute('rel')).toBe('noopener noreferrer');
    expect(ext.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: 'pricing' }).getAttribute('href')).toBe('/pricing');
  });

  it('renders figures with intrinsic size, alt text and lazy loading', () => {
    renderBody();
    const img = screen.getByRole('img', { name: 'Diagram of the call flow' });
    expect(img.getAttribute('width')).toBe('1200');
    expect(img.getAttribute('height')).toBe('630');
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('tracks inline CTA clicks with the post slug', () => {
    renderBody();
    fireEvent.click(screen.getByRole('link', { name: /book a demo/i }));
    expect(ctaClick).toHaveBeenCalledWith('demo-post', 'demo', 'inline');
  });
});

describe('FaqAccordion', () => {
  const faq: BlogFaq[] = [{ q: 'Does it work after hours?', a: t('Yes, around the clock.'), aText: 'Yes, around the clock.' }];
  it('renders native details/summary so answers stay in the DOM for crawlers', () => {
    const { container } = render(<MemoryRouter><FaqAccordion faq={faq} /></MemoryRouter>);
    expect(container.querySelectorAll('details')).toHaveLength(1);
    expect(screen.getByText('Yes, around the clock.')).toBeTruthy();
  });
  it('renders nothing without questions', () => {
    const { container } = render(<FaqAccordion faq={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
