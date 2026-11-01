// src/lib/brand/tabIdentity.ts
//
// Owns everything the browser tab shows besides the page itself:
//   - document.title prefix: "(3) Jobs · Vireek" for unread, "● Live call · Jobs · Vireek" while a call is live
//   - favicon dot (copper = live call, cobalt = unread that arrived while the tab was in the background)
//   - <meta name="theme-color"> synced to the app's real light/dark background
// The title prefix is the accessible signal (screen readers announce title changes); the favicon dot is
// decorative reinforcement. Pages keep setting document.title freely: a MutationObserver re-applies the prefix.

import { BRAND, THEME_COLORS } from '@/lib/brand/brandConfig';

const LIVE_PREFIX = '\u25CF Live call \u00B7 ';
const PREFIX_RE = /^(?:\u25CF Live call \u00B7 |\(\d+\+?\)\s)+/;
const ICON_SRC = '/favicon-96x96.png';

interface TabState {
  unread: number;
  live: number;
  /** Unread rose while the tab was hidden/unfocused; cleared when the user returns. Drives the unread dot only. */
  attention: boolean;
}

let state: TabState = { unread: 0, live: 0, attention: false };
let lastWritten = '';
let initialized = false;
let titleObserver: MutationObserver | null = null;
let themeObserver: MutationObserver | null = null;
let stashedIcons: HTMLLinkElement[] | null = null;
let badgeLink: HTMLLinkElement | null = null;
let renderToken = 0;
const dotCache = new Map<string, string>();

export function stripTabPrefix(title: string): string {
  return title.replace(PREFIX_RE, '');
}

export function composeTabTitle(base: string, s: Pick<TabState, 'unread' | 'live'>): string {
  const clean = stripTabPrefix(base);
  if (s.live > 0) return `${LIVE_PREFIX}${clean}`;
  if (s.unread > 0) return `(${s.unread > 99 ? '99+' : s.unread}) ${clean}`;
  return clean;
}

function applyTitle(): void {
  const next = composeTabTitle(document.title, state);
  lastWritten = next;
  if (next !== document.title) document.title = next;
}

type Dot = 'live' | 'unread' | null;

function wantedDot(): Dot {
  if (state.live > 0) return 'live';
  if (state.unread > 0 && state.attention) return 'unread';
  return null;
}

function iconLinks(): HTMLLinkElement[] {
  return Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')).filter(
    (l) => !l.hasAttribute('data-vk-badge'),
  );
}

async function badgedIcon(dot: 'live' | 'unread'): Promise<string | null> {
  const cached = dotCache.get(dot);
  if (cached) return cached;
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('favicon load failed'));
      img.src = ICON_SRC; // same-origin: canvas stays untainted
    });
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 96, 96);
    const r = 18;
    const cx = 96 - r - 6;
    const cy = r + 6;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
    ctx.fillStyle = BRAND.colors.light.bg; // ring keeps the dot readable on dark and light tab strips
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = dot === 'live' ? BRAND.colors.light.live : BRAND.colors.accent500;
    ctx.fill();
    const url = canvas.toDataURL('image/png');
    dotCache.set(dot, url);
    return url;
  } catch {
    return null; // title prefix still carries the signal
  }
}

function restoreFavicon(): void {
  badgeLink?.remove();
  badgeLink = null;
  if (stashedIcons) {
    stashedIcons.forEach((l) => document.head.appendChild(l));
    stashedIcons = null;
  }
}

async function applyFavicon(): Promise<void> {
  const token = ++renderToken;
  const dot = wantedDot();
  if (!dot) {
    restoreFavicon();
    return;
  }
  const url = await badgedIcon(dot);
  if (token !== renderToken || !url) return; // superseded, or icon unavailable
  if (!stashedIcons) {
    stashedIcons = iconLinks();
    stashedIcons.forEach((l) => l.remove());
  }
  if (!badgeLink) {
    badgeLink = document.createElement('link');
    badgeLink.rel = 'icon';
    badgeLink.type = 'image/png';
    badgeLink.setAttribute('data-vk-badge', '1');
    document.head.appendChild(badgeLink);
  }
  badgeLink.href = url;
}

function refresh(): void {
  applyTitle();
  void applyFavicon();
}

export function setTabUnread(count: number): void {
  const next = Math.max(0, Math.floor(count) || 0);
  const rose = next > state.unread;
  const away = typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
  state = { ...state, unread: next, attention: next === 0 ? false : state.attention || (rose && away) };
  refresh();
}

/** Ref-counted: several live-call cards can mount at once. */
export function adjustTabLiveCalls(delta: number): void {
  state = { ...state, live: Math.max(0, state.live + delta) };
  refresh();
}

function clearAttention(): void {
  if (!state.attention) return;
  state = { ...state, attention: false };
  void applyFavicon();
}

function onVisibility(): void {
  if (!document.hidden) clearAttention();
}

export function cssVarToHex(raw: string): string | null {
  const parts = raw.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  return `#${parts
    .slice(0, 3)
    .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

/** Keeps the browser chrome color equal to the app's actual background (class-based dark mode ignores prefers-color-scheme). */
export function syncThemeColor(): void {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary');
  const hex =
    cssVarToHex(raw) ?? (document.documentElement.classList.contains('dark') ? THEME_COLORS.dark : THEME_COLORS.light);
  const metas = Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  let meta = metas[0];
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  metas.slice(1).forEach((m) => m.remove()); // drop the static media-specific pair once JS owns the value
  meta.removeAttribute('media');
  meta.content = hex;
}

/** Call once at boot (main.tsx). No-op during prerender so static HTML keeps its static tags. */
export function initTabIdentity(): void {
  if (initialized || typeof document === 'undefined') return;
  if ((window as unknown as { __VIREEK_PRERENDER__?: boolean }).__VIREEK_PRERENDER__) return;
  initialized = true;
  const titleEl = document.querySelector('title');
  if (titleEl) {
    titleObserver = new MutationObserver(() => {
      if (document.title !== lastWritten) applyTitle();
    });
    titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
  }
  themeObserver = new MutationObserver(syncThemeColor);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('focus', clearAttention);
  document.addEventListener('visibilitychange', onVisibility);
  syncThemeColor();
  applyTitle();
}

/** Test-only. */
export function __resetTabIdentityForTests(): void {
  titleObserver?.disconnect();
  themeObserver?.disconnect();
  titleObserver = null;
  themeObserver = null;
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', clearAttention);
    document.removeEventListener('visibilitychange', onVisibility);
  }
  restoreFavicon();
  dotCache.clear();
  state = { unread: 0, live: 0, attention: false };
  lastWritten = '';
  initialized = false;
  renderToken = 0;
}
