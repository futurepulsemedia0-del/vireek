import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({ language: 'en' }));
vi.mock('@/contexts/AccessibilityContext', () => ({
  useAccessibility: () => ({ language: state.language }),
}));

import { useSEO } from './seo';

const CANONICAL = 'https://vireek.com/pricing';
const config = { title: 'Pricing', description: 'Plans', canonical: CANONICAL };

const hreflangs = () =>
  Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="alternate"][hreflang]'));
const canonicalHref = () => document.querySelector('link[rel="canonical"]')?.getAttribute('href');

beforeEach(() => {
  document.head.innerHTML = '';
  state.language = 'en';
});

describe('useSEO canonical (no misleading hreflang)', () => {
  it('English: clean canonical and no hreflang links', () => {
    renderHook(() => useSEO(config));
    expect(canonicalHref()).toBe(CANONICAL);
    expect(hreflangs()).toHaveLength(0);
  });

  it('Persian: canonical stays the clean URL, og:locale is fa_IR, still no hreflang', () => {
    state.language = 'fa';
    renderHook(() => useSEO(config));
    expect(canonicalHref()).toBe(CANONICAL);
    expect(hreflangs()).toHaveLength(0);
    expect(document.querySelector('meta[property="og:locale"]')?.getAttribute('content')).toBe('fa_IR');
    expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(CANONICAL);
  });

  it('removes managed og:locale:alternate tags on unmount', () => {
    const { unmount } = renderHook(() => useSEO(config));
    expect(document.querySelectorAll('meta[property="og:locale:alternate"]').length).toBeGreaterThan(0);
    unmount();
    expect(document.querySelectorAll('meta[property="og:locale:alternate"]')).toHaveLength(0);
  });
});
