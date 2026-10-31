// src/components/ui/Tooltip.tsx
//
// The one Tooltip. Supplementary info only — never the sole carrier of
// essential information (touch + screen-reader users get it too, see below).
//
//  - Mouse/pen: opens after `delayMs` (instantly if another tooltip closed <300ms ago).
//    Stays open while the pointer is over the bubble (WCAG 1.4.13 hoverable).
//  - Keyboard: opens on :focus-visible, no delay.
//  - Touch: no hover, so with `openOnTap` a tap toggles it (auto-closes after 4s
//    or on any outside tap).
//  - Escape dismisses without moving focus (and swallows that Escape, so a
//    dialog behind it doesn't also close).
//  - Screen readers: aria-describedby always points at an sr-only copy of the
//    content, so the description is announced regardless of the visual state.
import {
  Children,
  ReactElement,
  ReactNode,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

let lastClosedAt = 0;
const GROUP_WINDOW_MS = 300;
const TOUCH_AUTOCLOSE_MS = 4000;
const GAP = 8;
const EDGE = 8;

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  /** Preferred side; flips automatically when there is no room. */
  side?: 'top' | 'bottom';
  delayMs?: number;
  maxWidth?: number;
  /** Let a tap open it on touch devices (use for disabled-with-reason controls). */
  openOnTap?: boolean;
  disabled?: boolean;
}

export function Tooltip({
  content,
  children,
  side = 'top',
  delayMs = 500,
  maxWidth = 280,
  openOnTap = false,
  disabled = false,
}: TooltipProps) {
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const touchTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(touchTimer.current);
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    setOpen((was) => {
      if (was) lastClosedAt = Date.now();
      return false;
    });
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  const show = useCallback(
    (immediate: boolean) => {
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(openTimer.current);
      const wait = immediate || Date.now() - lastClosedAt < GROUP_WINDOW_MS ? 0 : delayMs;
      openTimer.current = window.setTimeout(() => setOpen(true), wait);
    },
    [delayMs],
  );

  // Position (viewport-clamped, flips when out of room) before paint.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = wrapRef.current?.firstElementChild as HTMLElement | null;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;
    const a = anchor.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const fitsTop = a.top - b.height - GAP >= EDGE;
    const placeTop = side === 'top' ? fitsTop : !(a.bottom + b.height + GAP <= window.innerHeight - EDGE);
    const top = placeTop ? a.top - b.height - GAP : a.bottom + GAP;
    const left = Math.min(Math.max(a.left + a.width / 2 - b.width / 2, EDGE), window.innerWidth - b.width - EDGE);
    setPos({ top, left });
  }, [open, side, content]);

  // Escape, outside tap and scroll dismissal while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        hide();
      }
    };
    const onOutside = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node) && !bubbleRef.current?.contains(e.target as Node)) hide();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);

  if (!isValidElement(children)) return <>{children}</>;
  const hasContent = content !== null && content !== undefined && content !== false && content !== '';
  if (disabled || !hasContent) return children;

  const child = Children.only(children) as ReactElement<Record<string, unknown>>;
  const describedBy = [child.props['aria-describedby'] as string | undefined, id].filter(Boolean).join(' ');

  return (
    <span
      ref={wrapRef}
      className="contents"
      onPointerEnter={(e) => {
        if (e.pointerType !== 'touch') show(false);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'touch') return;
        window.clearTimeout(openTimer.current);
        closeTimer.current = window.setTimeout(hide, 100);
      }}
      onFocus={(e) => {
        let visible = true;
        try {
          visible = (e.target as HTMLElement).matches(':focus-visible');
        } catch {
          /* old engines: treat any focus as visible */
        }
        if (visible) show(true);
      }}
      onBlur={hide}
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch' || !openOnTap) return;
        if (open) hide();
        else {
          show(true);
          touchTimer.current = window.setTimeout(hide, TOUCH_AUTOCLOSE_MS);
        }
      }}
    >
      {cloneElement(child, { 'aria-describedby': describedBy })}
      <span id={id} className="sr-only">
        {content}
      </span>
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            aria-hidden="true"
            onPointerEnter={() => window.clearTimeout(closeTimer.current)}
            onPointerLeave={() => {
              closeTimer.current = window.setTimeout(hide, 100);
            }}
            style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, maxWidth }}
            className={`pointer-events-auto z-[400] rounded-lg border border-border bg-bg-secondary px-3 py-2 text-xs leading-relaxed text-text-primary shadow-card transition-opacity duration-fast motion-reduce:transition-none dark:shadow-card-dark ${
              pos ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
