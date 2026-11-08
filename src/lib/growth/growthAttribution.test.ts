import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTION_STORAGE_KEY,
  ATTRIBUTION_TTL_MS,
  captureLanding,
  cleanToken,
  flushAttribution,
  parseLanding,
  readStored,
  type CaptureDeps,
  type SendArgs,
  type StorageLike,
} from './growthAttribution';

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}
const NOW = 1_800_000_000_000;
const deps = (over: Partial<CaptureDeps> = {}): CaptureDeps => ({
  storage: memStorage(),
  hasConsent: () => true,
  now: () => NOW,
  search: '?utm_source=Google&utm_medium=cpc&utm_campaign=spring-2028',
  referrer: '',
  ownHost: 'vireek.com',
  ...over,
});

describe('cleanToken', () => {
  it('lowercases and trims', () => expect(cleanToken('  Google ')).toBe('google'));
  it('rejects injection-ish and oversized values', () => {
    expect(cleanToken("x'; drop table")).toBeNull();
    expect(cleanToken('<script>')).toBeNull();
    expect(cleanToken('a'.repeat(65))).toBeNull();
    expect(cleanToken('')).toBeNull();
    expect(cleanToken(null)).toBeNull();
  });
});

describe('parseLanding', () => {
  it('reads utm params', () => {
    const a = parseLanding('?utm_source=news&utm_medium=email', '', 'vireek.com', NOW);
    expect(a?.source).toBe('news');
    expect(a?.medium).toBe('email');
  });
  it('keeps only the referrer HOST of external referrers', () => {
    expect(parseLanding('', 'https://www.example.org/path?q=secret', 'vireek.com', NOW)?.referrerHost).toBe('www.example.org');
  });
  it('ignores internal referrers and direct visits', () => {
    expect(parseLanding('', 'https://vireek.com/pricing', 'vireek.com', NOW)).toBeNull();
    expect(parseLanding('', 'https://app.vireek.com/x', 'vireek.com', NOW)).toBeNull();
    expect(parseLanding('', '', 'vireek.com', NOW)).toBeNull();
  });
  it('drops invalid values instead of storing them', () => {
    expect(parseLanding('?utm_source=%3Cscript%3E', '', 'vireek.com', NOW)).toBeNull();
  });
});

describe('captureLanding (consent gate + first touch)', () => {
  it('stores nothing without analytics consent', () => {
    const d = deps({ hasConsent: () => false });
    expect(captureLanding(d)).toBe(false);
    expect((d.storage as ReturnType<typeof memStorage>).data.size).toBe(0);
  });
  it('stores with consent', () => {
    const d = deps();
    expect(captureLanding(d)).toBe(true);
    expect(readStored(d.storage, NOW)?.source).toBe('google');
  });
  it('first touch wins (second landing does not overwrite)', () => {
    const d = deps();
    captureLanding(d);
    expect(captureLanding({ ...d, search: '?utm_source=other' })).toBe(false);
    expect(readStored(d.storage, NOW)?.source).toBe('google');
  });
  it('expires after 30 days and is removed', () => {
    const d = deps();
    captureLanding(d);
    expect(readStored(d.storage, NOW + ATTRIBUTION_TTL_MS + 1)).toBeNull();
    expect((d.storage as ReturnType<typeof memStorage>).data.has(ATTRIBUTION_STORAGE_KEY)).toBe(false);
  });
  it('tolerates corrupt stored JSON', () => {
    const d = deps();
    d.storage.setItem(ATTRIBUTION_STORAGE_KEY, '{nope');
    expect(readStored(d.storage, NOW)).toBeNull();
  });
});

describe('flushAttribution', () => {
  it('sends once, then clears', async () => {
    const d = deps();
    captureLanding(d);
    const sent: SendArgs[] = [];
    expect(await flushAttribution(d, async (a) => void sent.push(a))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].p_source).toBe('google');
    expect(await flushAttribution(d, async (a) => void sent.push(a))).toBe(false);
    expect(sent).toHaveLength(1);
  });
  it('keeps the value when sending fails (retry later)', async () => {
    const d = deps();
    captureLanding(d);
    let threw = false;
    try {
      await flushAttribution(d, async () => {
        throw new Error('network');
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(readStored(d.storage, NOW)?.source).toBe('google');
  });
  it('clears and sends nothing when consent was withdrawn', async () => {
    const d = deps();
    captureLanding(d);
    const sent: SendArgs[] = [];
    expect(await flushAttribution({ ...d, hasConsent: () => false }, async (a) => void sent.push(a))).toBe(false);
    expect(sent).toHaveLength(0);
    expect(readStored(d.storage, NOW)).toBeNull();
  });
});
