import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGES } from '@/lib/i18n';
import {
  LANG_STORAGE_KEY,
  applyDocumentLanguage,
  buildHreflangLinks,
  clearUrlLanguage,
  localizedUrl,
  normalizeLanguage,
  readUrlLanguage,
  resolveInitialLanguage,
} from './languageSync';

const setUrl = (path: string) => window.history.replaceState(null, '', path);

beforeEach(() => {
  localStorage.clear();
  setUrl('/');
  const root = document.documentElement;
  root.removeAttribute('lang');
  root.removeAttribute('dir');
  root.classList.remove('a11y-rtl');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizeLanguage', () => {
  it.each([
    ['fa', 'fa'],
    ['fa-IR', 'fa'],
    ['AR', 'ar'],
    ['zh_CN', 'zh'],
    [' de ', 'de'],
  ])('maps %s -> %s', (raw, expected) => {
    expect(normalizeLanguage(raw)).toBe(expected);
  });

  it.each([['xx'], [''], [null], [undefined], [42]])('rejects %s', (raw) => {
    expect(normalizeLanguage(raw)).toBeNull();
  });
});

describe('applyDocumentLanguage', () => {
  it.each(LANGUAGES)('syncs lang + dir for $code', (l) => {
    applyDocumentLanguage(l.code);
    const root = document.documentElement;
    expect(root.getAttribute('lang')).toBe(l.code);
    expect(root.getAttribute('dir')).toBe(l.direction);
    expect(root.classList.contains('a11y-rtl')).toBe(l.direction === 'rtl');
  });

  it('flips back from rtl to ltr cleanly', () => {
    applyDocumentLanguage('fa');
    applyDocumentLanguage('en');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.classList.contains('a11y-rtl')).toBe(false);
  });

  it('treats fa and ar as rtl', () => {
    for (const code of ['fa', 'ar'] as const) {
      applyDocumentLanguage(code);
      expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    }
  });
});

describe('readUrlLanguage / resolveInitialLanguage', () => {
  it('reads and validates ?lang=', () => {
    expect(readUrlLanguage('?lang=fa')).toBe('fa');
    expect(readUrlLanguage('?lang=nope')).toBeNull();
    expect(readUrlLanguage('?x=1')).toBeNull();
  });

  it('prefers URL over storage over browser over default', () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('fr-FR');
    expect(resolveInitialLanguage()).toBe('fr');

    localStorage.setItem(LANG_STORAGE_KEY, 'de');
    expect(resolveInitialLanguage()).toBe('de');

    setUrl('/?lang=ar');
    expect(resolveInitialLanguage()).toBe('ar');
  });

  it('ignores an invalid stored value and falls back', () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('xx-XX');
    localStorage.setItem(LANG_STORAGE_KEY, 'klingon');
    expect(resolveInitialLanguage()).toBe('en');
  });
});

describe('clearUrlLanguage', () => {
  it('removes only the lang param and keeps path, other params and hash', () => {
    setUrl('/pricing?lang=fa&ref=x#faq');
    clearUrlLanguage();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/pricing?ref=x#faq',
    );
  });

  it('is a no-op without a lang param', () => {
    setUrl('/pricing?ref=x');
    clearUrlLanguage();
    expect(window.location.search).toBe('?ref=x');
  });
});

describe('localizedUrl / buildHreflangLinks', () => {
  const canonical = 'https://vireek.com/pricing';

  it('keeps the clean URL for English and adds ?lang= for others', () => {
    expect(localizedUrl(canonical, 'en')).toBe(canonical);
    expect(localizedUrl(canonical, 'fa')).toBe('https://vireek.com/pricing?lang=fa');
  });

  it('returns input unchanged when it is not a valid URL', () => {
    expect(localizedUrl('not a url', 'fa')).toBe('not a url');
  });

  it('emits one alternate per language plus x-default, all distinct per language', () => {
    const links = buildHreflangLinks(canonical);
    expect(links).toHaveLength(LANGUAGES.length + 1);
    expect(links.find((l) => l.hreflang === 'x-default')?.href).toBe(canonical);
    expect(links.find((l) => l.hreflang === 'ar')?.href).toBe('https://vireek.com/pricing?lang=ar');
    const hrefs = links.filter((l) => l.hreflang !== 'x-default').map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
