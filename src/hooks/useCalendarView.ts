import { useCallback, useEffect, useState } from 'react';
import {
  CALENDAR_PREFS_KEY,
  parseCalendarPrefs,
  viewForShortcut,
  type AgendaGroupBy,
  type CalendarPrefs,
  type CalendarView,
  type ColorMode,
} from '@/lib/calendarViews';

function readPrefs(): CalendarPrefs {
  try {
    return parseCalendarPrefs(window.localStorage.getItem(CALENDAR_PREFS_KEY));
  } catch {
    return parseCalendarPrefs(null);
  }
}

/** View / colour-mode / agenda-grouping, remembered per browser (storage failures are non-fatal). */
export function useCalendarPrefs() {
  const [prefs, setPrefs] = useState<CalendarPrefs>(readPrefs);

  useEffect(() => {
    try {
      window.localStorage.setItem(CALENDAR_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* private mode / quota — preferences just won't persist */
    }
  }, [prefs]);

  const setView = useCallback((view: CalendarView) => setPrefs((p) => ({ ...p, view })), []);
  const setColorMode = useCallback((colorMode: ColorMode) => setPrefs((p) => ({ ...p, colorMode })), []);
  const setAgendaGroupBy = useCallback((agendaGroupBy: AgendaGroupBy) => setPrefs((p) => ({ ...p, agendaGroupBy })), []);

  return { ...prefs, setView, setColorMode, setAgendaGroupBy };
}

interface ShortcutHandlers {
  enabled?: boolean;
  onView: (view: CalendarView) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}

/** Slightly longer than the global sequence timeout (800 ms) in lib/keyboardShortcuts.ts. */
const GO_SEQUENCE_WINDOW_MS = 900;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/**
 * Calendar-wide shortcuts: M W D R A switch view · J / K next / previous period · T today.
 * Ignored while typing, with Ctrl/Cmd/Alt held (browser shortcuts stay intact), or when `enabled` is false
 * (e.g. the reschedule drawer is open), or right after a "g" (global go-to sequences). Arrow-key
 * navigation lives on the month grid itself.
 */
export function useCalendarShortcuts({ enabled = true, onView, onPrev, onNext, onToday }: ShortcutHandlers) {
  useEffect(() => {
    if (!enabled) return;
    // The app's global "g then <letter>" navigation (g j, g a, g r, g t …) shares letters with ours.
    // While such a sequence may be in progress, leave the second key alone.
    let lastGAt = Number.NEGATIVE_INFINITY;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      const now = Date.now();
      if (key === 'g') {
        lastGAt = now;
        return;
      }
      if (now - lastGAt < GO_SEQUENCE_WINDOW_MS) return;
      const view = viewForShortcut(key);
      if (view) onView(view);
      else if (key === 'j') onNext();
      else if (key === 'k') onPrev();
      else if (key === 't') onToday();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, onView, onPrev, onNext, onToday]);
}
