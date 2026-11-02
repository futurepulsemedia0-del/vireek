// src/hooks/useLongPress.ts — long-press menus.
//   const { handlers, consumeLongPress } = useLongPress(openMenu);
//   <button {...handlers} onClick={() => { if (consumeLongPress()) return; normalTap(); }} />
// consumeLongPress() stops the click that follows a long press from also triggering the normal tap.
// ACCESSIBILITY RULE: every long-press action must also exist as a visible button or menu item
// (switch control / VoiceOver users cannot long-press reliably).

import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';
import { haptic } from '@/lib/native/haptics';

interface Options {
  delayMs?: number;
  /** Finger drift (px) that cancels the press, so scrolling never opens the menu. */
  slopPx?: number;
}

export function useLongPress(onLongPress: () => void, { delayMs = 450, slopPx = 10 }: Options = {}) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  const consumeLongPress = useCallback(() => {
    const was = fired.current;
    fired.current = false;
    return was;
  }, []);

  const handlers = {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        void haptic('impact');
        callback.current();
      }, delayMs);
    },
    onPointerMove: (e: PointerEvent) => {
      const o = origin.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > slopPx) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    /** Stops the OS context menu from stacking on top of ours after a long press. */
    onContextMenu: (e: MouseEvent) => {
      if (fired.current) e.preventDefault();
    },
  };

  return { handlers, consumeLongPress };
}
