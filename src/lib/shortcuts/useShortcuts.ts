import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { SHORTCUT_BY_ID, SHORTCUT_DEFS } from './definitions';
import {
  createMatcher,
  detectPlatform,
  isTypingTarget,
  resolveShortcuts,
  type Overrides,
  type Platform,
  type ResolvedShortcut,
  type ShortcutContext,
} from './registry';
import { shortcutStore } from './store';

/**
 * Global key dispatcher. ONE window listener for the whole app; components
 * register handlers by shortcut id. Which key triggers an id is decided by the
 * registry (defaults + the user's overrides), never by the component.
 *
 * Handler stacks: the most recently registered handler for an id wins, so a
 * page can temporarily take over a shortcut and release it on unmount.
 */
type Handler = () => void;

const stacks = new Map<string, Handler[]>();
const contextCounts = new Map<ShortcutContext, number>();
let listening = false;
let matcher: ReturnType<typeof createMatcher> | null = null;
let cachedFor: Overrides | null = null;
let cached: ResolvedShortcut[] = [];

function getMatcher() {
  matcher ??= createMatcher({
    platform: detectPlatform(),
    canFire: (id) => (stacks.get(id)?.length ?? 0) > 0,
  });
  return matcher;
}

function getResolved(): ResolvedShortcut[] {
  const snapshot = shortcutStore.getSnapshot();
  if (cachedFor !== snapshot) {
    cachedFor = snapshot;
    cached = resolveShortcuts(SHORTCUT_DEFS, snapshot);
    getMatcher().reset();
  }
  return cached;
}

function isDialogOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).some(
    (el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true' && getComputedStyle(el).display !== 'none',
  );
}

function onKeyDown(e: KeyboardEvent) {
  const contexts = new Set<ShortcutContext>(
    Array.from(contextCounts.entries()).filter(([, n]) => n > 0).map(([c]) => c),
  );
  const hit = getMatcher().match(getResolved(), {
    event: e,
    typing: isTypingTarget(e.target),
    dialogOpen: isDialogOpen(),
    contexts,
    now: Date.now(),
  });
  if (!hit) return;
  const stack = stacks.get(hit.def.id);
  const handler = stack?.[stack.length - 1];
  if (!handler) return;
  e.preventDefault();
  handler();
}

function sync() {
  const needed = stacks.size > 0 || Array.from(contextCounts.values()).some((n) => n > 0);
  if (needed && !listening) {
    window.addEventListener('keydown', onKeyDown);
    listening = true;
  } else if (!needed && listening) {
    window.removeEventListener('keydown', onKeyDown);
    getMatcher().reset();
    listening = false;
  }
}

function register(id: string, handler: Handler): () => void {
  const stack = stacks.get(id) ?? [];
  stack.push(handler);
  stacks.set(id, stack);
  sync();
  return () => {
    const current = stacks.get(id) ?? [];
    const i = current.lastIndexOf(handler);
    if (i >= 0) current.splice(i, 1);
    if (current.length === 0) stacks.delete(id);
    sync();
  };
}

/** Test helper: forget every handler/context and detach the listener. */
export function __resetShortcutBusForTests(): void {
  stacks.clear();
  contextCounts.clear();
  matcher = null;
  cachedFor = null;
  sync();
}

/** Registers handlers for shortcut ids while the calling component is mounted. */
export function useShortcutHandlers(handlers: Readonly<Record<string, () => void>>): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  const ids = Object.keys(handlers).sort().join('|');
  useEffect(() => {
    const unregister = ids
      .split('|')
      .filter((id) => id && SHORTCUT_BY_ID.has(id))
      .map((id) => register(id, () => ref.current[id]?.()));
    return () => unregister.forEach((u) => u());
  }, [ids]);
}

/** Marks a context (e.g. 'dashboard') active while mounted. */
export function useShortcutContext(context: ShortcutContext, active = true): void {
  useEffect(() => {
    if (!active) return undefined;
    contextCounts.set(context, (contextCounts.get(context) ?? 0) + 1);
    sync();
    return () => {
      contextCounts.set(context, Math.max(0, (contextCounts.get(context) ?? 1) - 1));
      sync();
    };
  }, [context, active]);
}

/** Scopes customisations to the signed-in user. */
export function useShortcutScope(userId: string | undefined): void {
  useEffect(() => {
    shortcutStore.setScope(userId ?? 'anon');
  }, [userId]);
}

export function useShortcutOverrides(): Overrides {
  return useSyncExternalStore(shortcutStore.subscribe, shortcutStore.getSnapshot, shortcutStore.getSnapshot);
}

export function useResolvedShortcuts(): ResolvedShortcut[] {
  const overrides = useShortcutOverrides();
  return useMemo(() => resolveShortcuts(SHORTCUT_DEFS, overrides), [overrides]);
}

export function useShortcutBinding(id: string | undefined): ResolvedShortcut | undefined {
  const all = useResolvedShortcuts();
  return useMemo(() => (id ? all.find((s) => s.def.id === id) : undefined), [all, id]);
}

export function usePlatform(): Platform {
  return useMemo(() => detectPlatform(), []);
}
