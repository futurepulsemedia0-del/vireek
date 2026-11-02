// src/components/mobile/SwipeActionRow.tsx — iOS/Android-style swipe actions for list rows.
// Swipe left/right past the threshold to commit; optional Undo through the app's UndoContext.
// Every swipe action is ALSO reachable by screen-reader / keyboard through visually-hidden buttons.

import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useUndo } from '@/contexts/UndoContext';
import { haptic } from '@/lib/native/haptics';
import { isHorizontalIntent, resolveSwipe, rubberBand } from '@/lib/native/gestureMath';
import type { UndoOutcome } from '@/lib/undo/undoEngine';

export interface SwipeAction {
  label: string;
  /** Screen-reader label that says WHICH row it acts on, e.g. "Navigate to Jane Smith". */
  a11yLabel?: string;
  icon?: ReactNode;
  /** Tailwind classes for the revealed background, e.g. "bg-success-500 text-white". */
  className: string;
  onCommit: () => void | Promise<void>;
  /** When set, a toast with Undo is offered after the action. */
  undo?: { message: string; run: () => Promise<UndoOutcome> };
}

interface Props {
  children: ReactNode;
  /** Revealed by swiping the row to the LEFT (trailing side). */
  left?: SwipeAction;
  /** Revealed by swiping the row to the RIGHT (leading side). */
  right?: SwipeAction;
  disabled?: boolean;
}

export function SwipeActionRow({ children, left, right, disabled = false }: Props) {
  const { offerUndo } = useUndo();
  const start = useRef<{ x: number; y: number; t: number; id: number } | null>(null);
  const horizontal = useRef(false);
  const crossed = useRef(false);
  const [dx, setDx] = useState(0);
  const [settling, setSettling] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const width = () => rowRef.current?.offsetWidth ?? 320;

  async function commit(action: SwipeAction) {
    void haptic('success');
    try {
      await action.onCommit();
    } catch {
      void haptic('error');
      return;
    }
    if (action.undo) offerUndo({ message: action.undo.message, undo: action.undo.run });
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (disabled || (!left && !right) || e.pointerType === 'mouse') return;
    start.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
    horizontal.current = false;
    crossed.current = false;
    setSettling(false);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const rawX = e.clientX - s.x;
    const rawY = e.clientY - s.y;
    if (!horizontal.current) {
      if (!isHorizontalIntent(rawX, rawY)) return;
      horizontal.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const allowed = rawX < 0 ? left : right;
    if (!allowed) {
      setDx(0);
      return;
    }
    const limit = width() * 0.6;
    const shown = Math.sign(rawX) * rubberBand(Math.abs(rawX), limit);
    setDx(shown);
    const past = Math.abs(rawX) >= width() * 0.35;
    if (past && !crossed.current) {
      crossed.current = true;
      void haptic('selection');
    } else if (!past) {
      crossed.current = false;
    }
  }

  function end(e: PointerEvent<HTMLDivElement>) {
    const s = start.current;
    start.current = null;
    if (!s || !horizontal.current) return;
    const rawX = e.clientX - s.x;
    const rawY = e.clientY - s.y;
    const velocityX = rawX / Math.max(1, e.timeStamp - s.t);
    const outcome = resolveSwipe({ dx: rawX, dy: rawY, velocityX, width: width() });
    setSettling(true);
    setDx(0);
    if (outcome === 'left' && left) void commit(left);
    else if (outcome === 'right' && right) void commit(right);
  }

  const active = dx < 0 ? left : dx > 0 ? right : null;

  return (
    <div ref={rowRef} className="relative overflow-hidden rounded-xl">
      {active && (
        <div
          aria-hidden="true"
          className={`absolute inset-y-0 flex items-center gap-2 px-5 text-sm font-semibold ${active.className} ${dx < 0 ? 'right-0 justify-end' : 'left-0 justify-start'}`}
          style={{ width: Math.abs(dx) }}
        >
          {active.icon}
          <span className="whitespace-nowrap">{active.label}</span>
        </div>
      )}
      <div
        className="relative bg-bg-primary"
        style={{
          transform: `translateX(${dx}px)`,
          transition: settling ? 'transform 180ms ease-out' : 'none',
          touchAction: 'pan-y',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {children}
      </div>
      {/* Non-gesture access: screen readers, switch control and keyboards. */}
      <div className="sr-only">
        {left && (
          <button type="button" onClick={() => void commit(left)}>
            {left.a11yLabel ?? left.label}
          </button>
        )}
        {right && (
          <button type="button" onClick={() => void commit(right)}>
            {right.a11yLabel ?? right.label}
          </button>
        )}
      </div>
    </div>
  );
}
