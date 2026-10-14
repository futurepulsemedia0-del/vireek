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

describe('useSEO hreflang + canonical', () => {
  it('English: clean canonical, 9 languages + x-default', () => {
    renderHook(() => useSEO(config));
    expect(canonicalHref()).toBe(CANONICAL);
    expect(hreflangs()).toHaveLength(10);
    expect(hreflangs().find((l) => l.hreflang === 'x-default')?.href).toBe(CANONICAL);
  });

  it('Persian: self-canonical localized URL matches its own hreflang entry, og:locale is fa_IR', () => {
    state.language = 'fa';
    renderHook(() => useSEO(config));
    expect(canonicalHref()).toBe('https://vireek.com/pricing?lang=fa');
    expect(hreflangs().find((l) => l.hreflang === 'fa')?.href).toBe(canonicalHref());
    expect(document.querySelector('meta[property="og:locale"]')?.getAttribute('content')).toBe('fa_IR');
    expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(
      'https://vireek.com/pricing?lang=fa',
    );
  });

  it('removes hreflang links on unmount', () => {
    const { unmount } = renderHook(() => useSEO(config));
    expect(hreflangs().length).toBeGreaterThan(0);
    unmount();
    expect(hreflangs()).toHaveLength(0);
  });
});
