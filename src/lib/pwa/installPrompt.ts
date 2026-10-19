import { isNative } from '@/lib/native/platform';

/**
 * Install-prompt store. `beforeinstallprompt` fires once, early — so
 * initInstallPrompt() must run at app boot (main.tsx), not when a component mounts.
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export interface InstallState {
  /** A native install prompt is available (Chromium/Android/desktop). */
  canPrompt: boolean;
  /** Already running as an installed app (or inside the Capacitor shell). */
  installed: boolean;
  /** iOS/iPadOS: no prompt API — user must use Share → Add to Home Screen. */
  ios: boolean;
  dismissedAt: number | null;
  /** Number of distinct browser sessions seen on this device. */
  visits: number;
}

export const INSTALL_DISMISS_KEY = 'vireek.pwa.install.dismissedAt';
export const INSTALL_VISITS_KEY = 'vireek.pwa.install.visits';
const SESSION_COUNTED_KEY = 'vireek.pwa.install.sessionCounted';
export const INSTALL_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
export const INSTALL_MIN_VISITS = 2;

const DEFAULT_STATE: InstallState = Object.freeze({
  canPrompt: false,
  installed: false,
  ios: false,
  dismissedAt: null,
  visits: 0,
});

let state: InstallState = DEFAULT_STATE;
let deferred: BeforeInstallPromptEvent | null = null;
let initialized = false;
let cleanup: (() => void) | null = null;
const listeners = new Set<() => void>();

const local = () => window.localStorage;
const session = () => window.sessionStorage;

function safeGet(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

function safeSet(store: () => Storage, key: string, value: string): void {
  try {
    store().setItem(key, value);
  } catch {
    /* private mode / quota */
  }
}

function emit(): void {
  listeners.forEach((l) => l());
}

function setState(patch: Partial<InstallState>): void {
  const next = { ...state, ...patch };
  const changed = (Object.keys(next) as (keyof InstallState)[]).some((k) => next[k] !== state[k]);
  if (!changed) return;
  state = next;
  emit();
}

export function isIosDevice(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  // iPadOS 13+ reports a desktop Safari UA.
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  const mql = typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;
  return Boolean(mql?.matches) || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function shouldShowInstallBanner(s: InstallState, now: number): boolean {
  if (s.installed) return false;
  if (!s.canPrompt && !s.ios) return false;
  if (s.visits < INSTALL_MIN_VISITS) return false;
  if (s.dismissedAt !== null && now - s.dismissedAt < INSTALL_COOLDOWN_MS) return false;
  return true;
}

function readInitialState(): InstallState {
  const dismissed = Number(safeGet(local, INSTALL_DISMISS_KEY));
  let visits = Number(safeGet(local, INSTALL_VISITS_KEY)) || 0;
  if (!safeGet(session, SESSION_COUNTED_KEY)) {
    visits += 1;
    safeSet(local, INSTALL_VISITS_KEY, String(visits));
    safeSet(session, SESSION_COUNTED_KEY, '1');
  }
  return {
    canPrompt: false,
    installed: isStandaloneDisplay() || isNative(),
    ios: isIosDevice(navigator.userAgent, navigator.maxTouchPoints),
    dismissedAt: Number.isFinite(dismissed) && dismissed > 0 ? dismissed : null,
    visits,
  };
}

export function initInstallPrompt(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  state = readInitialState();

  const onBeforeInstall = (e: Event) => {
    e.preventDefault(); // keep the event so we can prompt from our own UI
    deferred = e as BeforeInstallPromptEvent;
    setState({ canPrompt: true });
  };
  const onInstalled = () => {
    deferred = null;
    setState({ canPrompt: false, installed: true });
  };
  const mql = typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;
  const onDisplayMode = () => {
    if (isStandaloneDisplay()) setState({ installed: true });
  };

  window.addEventListener('beforeinstallprompt', onBeforeInstall);
  window.addEventListener('appinstalled', onInstalled);
  mql?.addEventListener?.('change', onDisplayMode);
  cleanup = () => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstall);
    window.removeEventListener('appinstalled', onInstalled);
    mql?.removeEventListener?.('change', onDisplayMode);
  };
  emit();
}

export function getInstallState(): InstallState {
  return state;
}

export function subscribeInstallState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissInstallPrompt(now: number = Date.now()): void {
  safeSet(local, INSTALL_DISMISS_KEY, String(now));
  setState({ dismissedAt: now });
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null; // the event can be used only once
  setState({ canPrompt: false });
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === 'dismissed') dismissInstallPrompt();
    return outcome;
  } catch {
    return 'unavailable';
  }
}

/** Test-only. */
export function __resetInstallPromptForTests(): void {
  cleanup?.();
  cleanup = null;
  initialized = false;
  deferred = null;
  state = DEFAULT_STATE;
  listeners.clear();
}
