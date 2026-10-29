import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { announce } from '@/lib/a11y/announcer';
import {
  createScrollStore,
  decideScroll,
  type LocLike,
  type NavType,
  type ScrollSnapshot,
  type ScrollStore,
} from '@/lib/nav/scrollMemory';

/**
 * Replaces <ScrollToTop />. One component, four jobs:
 *  1. scroll: restore on back/forward, top on new page, keep on same-page param changes,
 *     anchor (#hash) with sticky-header offset, inner containers via [data-scroll-key]
 *  2. focus: main heading (or main) after a page change
 *  3. announce: new document.title to screen readers
 *  4. transition: 160ms opacity/translate on <main>, interruptible, off for reduced motion
 */

let store: ScrollStore | null = null;
const getStore = (): ScrollStore => {
  if (!store) {
    let kv: Storage | null = null;
    try {
      kv = window.sessionStorage;
    } catch {
      kv = null;
    }
    store = createScrollStore(kv);
  }
  return store;
};

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function readSnapshot(): ScrollSnapshot {
  const inner: ScrollSnapshot['inner'] = {};
  document.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((el) => {
    const key = el.dataset.scrollKey;
    if (key) inner[key] = { x: el.scrollLeft, y: el.scrollTop };
  });
  return { window: { x: window.scrollX, y: window.scrollY }, inner };
}

/** Height of a sticky/fixed header: `--sticky-offset` (px) wins, else measure [data-sticky-header]. */
function stickyOffset(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--sticky-offset').trim();
  const fromVar = parseFloat(raw);
  if (Number.isFinite(fromVar)) return fromVar;
  const el = document.querySelector<HTMLElement>('[data-sticky-header]');
  return el ? el.getBoundingClientRect().height : 0;
}

/** Resolve when `find()` returns a value (checked on DOM mutations) or after `timeoutMs`. */
function waitFor<T>(find: () => T | null, timeoutMs: number): { promise: Promise<T | null>; cancel: () => void } {
  let cancel = () => undefined as void;
  const promise = new Promise<T | null>((resolve) => {
    const hit = find();
    if (hit) return resolve(hit);
    const mo = new MutationObserver(() => {
      const v = find();
      if (v) done(v);
    });
    const timer = window.setTimeout(() => done(find()), timeoutMs);
    function done(v: T | null) {
      mo.disconnect();
      window.clearTimeout(timer);
      resolve(v);
    }
    mo.observe(document.body, { childList: true, subtree: true });
    cancel = () => done(null);
  });
  return { promise, cancel: () => cancel() };
}

function restore(snap: ScrollSnapshot, aborted: () => boolean): void {
  const started = performance.now();
  const step = () => {
    if (aborted()) return;
    const maxY = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(snap.window.x, Math.min(snap.window.y, Math.max(0, maxY)));
    let pending = false;
    for (const [key, pos] of Object.entries(snap.inner)) {
      const el = document.querySelector<HTMLElement>(`[data-scroll-key="${CSS.escape(key)}"]`);
      if (!el) {
        pending = true;
        continue;
      }
      el.scrollTo(pos.x, pos.y);
      if (el.scrollHeight - el.clientHeight < pos.y - 1) pending = true;
    }
    const windowDone = maxY >= snap.window.y - 1;
    if ((!windowDone || pending) && performance.now() - started < 1200) requestAnimationFrame(step);
  };
  step();
}

export function RouteEffects() {
  const location = useLocation();
  const navType = useNavigationType() as NavType;
  const { t } = useTranslation();
  const keyRef = useRef(location.key);
  const prevRef = useRef<LocLike | null>(null);
  const firstRef = useRef(true);
  const animRef = useRef<Animation | null>(null);

  useEffect(() => {
    const prevMode = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    let raf = 0;
    const save = () => {
      raf = 0;
      getStore().set(keyRef.current, readSnapshot());
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(save);
    };
    // Snapshot BEFORE navigation swaps the DOM (link click / back button).
    const saveNow = () => getStore().set(keyRef.current, readSnapshot());
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('click', saveNow, true);
    window.addEventListener('popstate', saveNow);
    window.addEventListener('pagehide', saveNow);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('click', saveNow, true);
      window.removeEventListener('popstate', saveNow);
      window.removeEventListener('pagehide', saveNow);
      if (raf) cancelAnimationFrame(raf);
      history.scrollRestoration = prevMode;
    };
  }, []);

  // Before paint: attribute any scroll events from now on to the NEW entry.
  useLayoutEffect(() => {
    keyRef.current = location.key;
  }, [location.key]);

  useEffect(() => {
    const next: LocLike = { pathname: location.pathname, search: location.search, hash: location.hash };
    const prev = prevRef.current;
    prevRef.current = next;
    const first = firstRef.current;
    firstRef.current = false;

    const action = first ? (next.hash ? 'anchor' : 'restore') : decideScroll(navType, prev, next);
    const pageChanged = !first && (!prev || prev.pathname !== next.pathname);

    let userTookOver = false;
    const abort = () => {
      userTookOver = true;
    };
    const abortEvents = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    abortEvents.forEach((e) => window.addEventListener(e, abort, { passive: true, once: true }));
    const waiters: Array<() => void> = [];
    const smooth = reducedMotion() ? 'auto' : 'smooth';

    if (action === 'top') window.scrollTo(0, 0);
    if (action === 'restore') {
      const snap = getStore().get(location.key);
      if (snap) restore(snap, () => userTookOver);
      else if (!first) window.scrollTo(0, 0);
    }
    if (action === 'anchor') {
      const id = (() => {
        try {
          return decodeURIComponent(next.hash.slice(1));
        } catch {
          return next.hash.slice(1);
        }
      })();
      const w = waitFor(() => document.getElementById(id), 1500);
      waiters.push(w.cancel);
      void w.promise.then((el) => {
        if (!el || userTookOver) return;
        const top = el.getBoundingClientRect().top + window.scrollY - stickyOffset();
        window.scrollTo({ top: Math.max(0, top), behavior: smooth });
        if (!el.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el.setAttribute('tabindex', '-1');
        el.focus({ preventScroll: true });
      });
    }

    if (pageChanged) {
      // Safety net: guarantee the skip-link target exists on every layout.
      const w = waitFor(() => document.querySelector<HTMLElement>('main'), 2000);
      waiters.push(w.cancel);
      void w.promise.then((main) => {
        if (!main) return;
        if (!document.getElementById('main-content')) main.id = 'main-content';

        // Transition: opacity/translate only, never below 0.6 opacity so content is never "hidden".
        animRef.current?.cancel();
        if (!reducedMotion() && typeof main.animate === 'function') {
          animRef.current = main.animate(
            [{ opacity: 0.6, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
            { duration: 160, easing: 'ease-out' },
          );
        }

        // Focus + announce (don't steal focus from a field the user is already typing in).
        const active = document.activeElement;
        const typing = active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
        if (action !== 'anchor' && !typing) {
          const heading = main.querySelector<HTMLElement>('[data-route-heading], h1') ?? main;
          heading.setAttribute('tabindex', '-1');
          heading.classList.add('outline-none');
          heading.focus({ preventScroll: true });
        }
        const title = document.title.trim();
        if (title) announce(t('navflow.navigatedTo', { title, defaultValue: 'Navigated to {{title}}' }));
      });
    }

    return () => {
      abortEvents.forEach((e) => window.removeEventListener(e, abort));
      waiters.forEach((cancel) => cancel());
    };
    // location.key changes on every navigation (including same-URL pushes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  return null;
}
