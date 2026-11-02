// src/components/mobile/BottomSheet.tsx — modal bottom sheet with snap points, drag handle,
// Escape / backdrop dismissal and a tappable handle for non-gesture users.

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { haptic } from '@/lib/native/haptics';
import { resolveSnap, shouldDismissSheet } from '@/lib/native/gestureMath';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Fractions of the viewport height, ascending (e.g. [0.4, 0.9]). */
  snapPoints?: readonly number[];
  initialSnap?: number;
}

export function BottomSheet({ open, onClose, title, children, snapPoints = [0.5, 0.92], initialSnap = 0 }: Props) {
  const [snap, setSnap] = useState(initialSnap);
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  const drag = useRef<{ y: number; fraction: number; t: number; lastY: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    setSnap(Math.min(initialSnap, snapPoints.length - 1));
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
    // snapPoints identity is intentionally ignored: callers pass literals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSnap, onClose]);

  if (!open) return null;

  const fraction = dragFraction ?? snapPoints[snap] ?? 0.5;

  function down(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, fraction: snapPoints[snap] ?? 0.5, t: e.timeStamp, lastY: e.clientY };
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const delta = (e.clientY - d.y) / window.innerHeight;
    d.lastY = e.clientY;
    setDragFraction(Math.min(1, Math.max(0.05, d.fraction - delta)));
  }
  function up(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const velocityY = (e.clientY - d.y) / Math.max(1, e.timeStamp - d.t);
    const current = dragFraction ?? d.fraction;
    setDragFraction(null);
    if (shouldDismissSheet(snapPoints, current, velocityY)) {
      void haptic('impact');
      onClose();
      return;
    }
    const next = resolveSnap(snapPoints, current, velocityY);
    if (next !== snap) void haptic('selection');
    setSnap(next);
  }

  return (
    <div className="fixed inset-0 z-[120]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 mx-auto flex max-w-lg flex-col rounded-t-2xl border border-border bg-bg-primary shadow-2xl outline-none"
        style={{ height: `${fraction * 100}dvh`, transition: dragFraction === null ? 'height 200ms ease-out' : 'none' }}
      >
        <div
          className="flex min-h-[44px] cursor-grab touch-none items-center justify-center"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          <button
            type="button"
            className="flex h-11 w-24 items-center justify-center"
            aria-label={snapPoints.length === 1 ? 'Close sheet' : snap < snapPoints.length - 1 ? 'Expand sheet' : 'Collapse sheet'}
            onClick={() => (snapPoints.length === 1 ? onClose() : setSnap((s) => (s < snapPoints.length - 1 ? s + 1 : 0)))}
          >
            <span className="h-1.5 w-10 rounded-full bg-border" />
          </button>
        </div>
        <h2 className="px-5 pb-2 text-base font-semibold text-text-primary">{title}</h2>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>
  );
}
