import { useEffect, useState, useSyncExternalStore } from 'react';
import { getAnnouncement, subscribeAnnouncement } from '@/lib/a11y/announce';
import { isInsideA11yUi } from '@/lib/a11y/pageIndex';

/** Global polite live region (always mounted so shortcuts/voice can announce while the panel is closed). */
export function LiveRegion() {
  const msg = useSyncExternalStore(subscribeAnnouncement, getAnnouncement, () => '');
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-a11y-ui>
      {msg}
    </div>
  );
}

const TEXT_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,a,button,label,td,th,dt,dd,figcaption,summary,span,[role="button"],[role="link"],[role="tab"]';
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 240);

/** Shows enlarged text of the element under the pointer or keyboard focus. Decorative duplicate: aria-hidden. */
export function Magnifier() {
  const [view, setView] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    let raf = 0;
    const pick = (t: EventTarget | null): Element | null => {
      const el = t instanceof Element ? t.closest(TEXT_SELECTOR) : null;
      return el && !isInsideA11yUi(el) ? el : null;
    };
    const textOf = (el: Element): string => clean(el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.textContent ?? '');
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = pick(e.target);
        const text = el ? textOf(el) : '';
        setView(text ? { text, x: e.clientX, y: e.clientY } : null);
      });
    };
    const onFocus = (e: FocusEvent) => {
      const el = pick(e.target);
      const text = el ? textOf(el) : '';
      if (!el || !text) return setView(null);
      const r = el.getBoundingClientRect();
      setView({ text, x: r.left + r.width / 2, y: r.bottom });
    };
    const hide = () => setView(null);
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', hide);
    document.addEventListener('scroll', hide, { passive: true, capture: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  if (!view) return null;
  const above = view.y > window.innerHeight * 0.65;
  const left = Math.min(Math.max(view.x, 220), Math.max(220, window.innerWidth - 220));
  return (
    <div
      aria-hidden="true"
      dir="auto"
      data-a11y-ui
      className="pointer-events-none fixed z-[90] w-max max-w-[min(26rem,92vw)] rounded-xl border-2 border-text-primary bg-bg-secondary px-4 py-3 text-2xl font-semibold leading-snug text-text-primary shadow-card-hover"
      style={{ left, top: above ? view.y - 20 : view.y + 24, transform: `translate(-50%, ${above ? '-100%' : '0'})` }}
    >
      {view.text}
    </div>
  );
}

/** Reading mask (dims all but a band) and/or reading guide (a line) following pointer or keyboard focus. */
export function ReadingAids({ mask, guide }: { mask: boolean; guide: boolean }) {
  const [y, setY] = useState<number>(() => (typeof window === 'undefined' ? 0 : window.innerHeight / 2));
  useEffect(() => {
    let raf = 0;
    const set = (v: number) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setY(v));
    };
    const onMove = (e: PointerEvent) => set(e.clientY);
    const onFocus = (e: FocusEvent) => {
      if (e.target instanceof Element && !isInsideA11yUi(e.target)) {
        const r = e.target.getBoundingClientRect();
        set(r.top + r.height / 2);
      }
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('focusin', onFocus);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('focusin', onFocus);
    };
  }, []);
  const half = 64;
  return (
    <div aria-hidden="true" data-a11y-ui className="pointer-events-none fixed inset-0 z-[70]">
      {mask && (
        <>
          <div className="absolute inset-x-0 top-0 bg-black/70" style={{ height: Math.max(0, y - half) }} />
          <div className="absolute inset-x-0 bottom-0 bg-black/70" style={{ top: y + half }} />
        </>
      )}
      {guide && <div className="absolute inset-x-0 h-1 bg-accent shadow-[0_0_0_2px_rgb(255_255_255)]" style={{ top: y - 2 }} />}
    </div>
  );
}
