import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTabIdentityForTests, adjustTabLiveCalls, composeTabTitle, cssVarToHex, initTabIdentity, setTabUnread, stripTabPrefix,
} from '@/lib/brand/tabIdentity';

const icons = () => Array.from(document.head.querySelectorAll('link[rel~="icon"]'));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.head.innerHTML =
    '<title>Jobs \u00B7 Vireek</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="icon" type="image/png" href="/favicon-96x96.png"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#FDFCFA"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#090A0D">';
  document.title = 'Jobs \u00B7 Vireek';
  // jsdom has no canvas/image decoding: provide just enough for the badge renderer.
  vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { queueMicrotask(() => this.onload?.()); } });
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), set fillStyle(_v: string) {} })) as never;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,AAAA');
});
afterEach(() => {
  __resetTabIdentityForTests();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

describe('title composition', () => {
  it('prefixes unread and live, strips old prefixes, caps at 99+', () => {
    expect(composeTabTitle('Jobs', { unread: 3, live: 0 })).toBe('(3) Jobs');
    expect(composeTabTitle('(3) Jobs', { unread: 120, live: 0 })).toBe('(99+) Jobs');
    expect(composeTabTitle('Jobs', { unread: 3, live: 1 })).toBe('\u25CF Live call \u00B7 Jobs');
    expect(stripTabPrefix('\u25CF Live call \u00B7 (3) Jobs')).toBe('Jobs');
  });
  it('cssVarToHex converts the app\u2019s "r g b" tokens', () => {
    expect(cssVarToHex('253 252 250')).toBe('#FDFCFA');
    expect(cssVarToHex('')).toBeNull();
  });
});

describe('tab identity runtime', () => {
  it('shows unread in the title and clears it', () => {
    setTabUnread(4);
    expect(document.title).toBe('(4) Jobs \u00B7 Vireek');
    setTabUnread(0);
    expect(document.title).toBe('Jobs \u00B7 Vireek');
  });
  it('re-applies the prefix when a page sets its own title', async () => {
    initTabIdentity();
    setTabUnread(2);
    document.title = 'Help \u2014 Vireek';
    await flush();
    expect(document.title).toBe('(2) Help \u2014 Vireek');
  });
  it('live call swaps the favicon for a dotted one and restores originals afterwards', async () => {
    adjustTabLiveCalls(1);
    await flush();
    await flush();
    expect(document.title.startsWith('\u25CF Live call')).toBe(true);
    expect(icons()).toHaveLength(1);
    expect(icons()[0].getAttribute('data-vk-badge')).toBe('1');
    adjustTabLiveCalls(-1);
    await flush();
    expect(icons().map((l) => l.getAttribute('href'))).toEqual(['/favicon.svg', '/favicon-96x96.png']);
  });
  it('ref-counts overlapping live calls', async () => {
    adjustTabLiveCalls(1);
    adjustTabLiveCalls(1);
    adjustTabLiveCalls(-1);
    expect(document.title.startsWith('\u25CF Live call')).toBe(true);
    adjustTabLiveCalls(-1);
    expect(document.title).toBe('Jobs \u00B7 Vireek');
  });
  it('initTabIdentity collapses the static theme-color pair into one synced tag', () => {
    document.documentElement.classList.add('dark'); // jsdom may not resolve CSS vars; the class fallback gives the same hex
    initTabIdentity();
    const metas = document.head.querySelectorAll('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0].getAttribute('content')).toBe('#090A0D');
    expect(metas[0].hasAttribute('media')).toBe(false);
  });
});
