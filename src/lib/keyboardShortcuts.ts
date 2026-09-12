// src/lib/keyboardShortcuts.ts
//
// Central registry + hook for dashboard-wide keyboard shortcuts.
// Two shortcut styles are supported:
//
//   1. "combo"    — a single keypress with modifiers, e.g. "mod+k", "?", "mod+s"
//                   ("mod" = Cmd on Mac, Ctrl on Windows/Linux)
//   2. "sequence" — a short chord typed one key at a time, e.g. ["g", "d"]
//                   (press g, then d, within ~800ms) — the "Gmail/Linear/
//                   GitHub" style power-user navigation pattern.
//
// This file has ZERO dependency on any specific page — it only needs
// `useNavigate` from react-router-dom for nav-type shortcuts. Wire it up
// ONCE in your dashboard layout component (e.g. DashboardNav.tsx) so it
// applies across every dashboard page automatically.
//
// Usage in your layout:
//
//   import { useKeyboardShortcuts, DEFAULT_SHORTCUTS } from '@/lib/keyboardShortcuts';
//
//   const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
//   useKeyboardShortcuts(DEFAULT_SHORTCUTS(navigate, () => setShortcutsHelpOpen(true)));
//
// Then render <KeyboardShortcutsModal open={shortcutsHelpOpen} onClose={...} />
// (see src/components/KeyboardShortcutsModal.tsx) somewhere in the layout.

import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComboShortcut {
  type: 'combo';
  /** e.g. "mod+k", "mod+shift+k", "?", "/" */
  combo: string;
  description: string;
  category: string;
  action: () => void;
}

export interface SequenceShortcut {
  type: 'sequence';
  /** e.g. ["g", "d"] — pressed one after another */
  keys: string[];
  description: string;
  category: string;
  action: () => void;
}

export type Shortcut = ComboShortcut | SequenceShortcut;

// ---------------------------------------------------------------------------
// Combo parsing/matching
// ---------------------------------------------------------------------------

function normalizeCombo(combo: string): { key: string; mod: boolean; shift: boolean; alt: boolean } {
  const parts = combo.toLowerCase().split('+').map((p) => p.trim());
  return {
    key: parts[parts.length - 1],
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
}

function comboMatches(e: KeyboardEvent, combo: string): boolean {
  const { key, mod, shift, alt } = normalizeCombo(combo);
  const modPressed = e.metaKey || e.ctrlKey;
  if (mod !== modPressed) return false;
  if (shift !== e.shiftKey) return false;
  if (alt !== e.altKey) return false;
  return e.key.toLowerCase() === key;
}

// Never fire shortcuts while the user is typing in a form field.
function isTypingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The hook — attach once per app (in the dashboard layout)
// ---------------------------------------------------------------------------

const SEQUENCE_TIMEOUT_MS = 800;

export function useKeyboardShortcuts(shortcuts: Shortcut[], enabled = true) {
  const bufferRef = useRef<string[]>([]);
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    function clearBuffer() {
      bufferRef.current = [];
      if (bufferTimerRef.current) {
        clearTimeout(bufferTimerRef.current);
        bufferTimerRef.current = null;
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (isTypingContext(e.target)) return;

      // --- combo shortcuts (checked first; they consume modifier keys) ---
      for (const s of shortcuts) {
        if (s.type === 'combo' && comboMatches(e, s.combo)) {
          e.preventDefault();
          clearBuffer();
          s.action();
          return;
        }
      }

      // Ignore bare modifier presses and anything with mod/alt held down
      // for sequence matching (sequences are plain letters typed in a row).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key.length !== 1) return; // ignore Shift, Tab, arrows, etc.

      bufferRef.current = [...bufferRef.current, key].slice(-3);

      if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = setTimeout(clearBuffer, SEQUENCE_TIMEOUT_MS);

      for (const s of shortcuts) {
        if (s.type !== 'sequence') continue;
        const seq = s.keys.map((k) => k.toLowerCase());
        const tail = bufferRef.current.slice(-seq.length);
        if (tail.length === seq.length && tail.every((k, i) => k === seq[i])) {
          e.preventDefault();
          clearBuffer();
          s.action();
          return;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearBuffer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, shortcuts]);
}

// ---------------------------------------------------------------------------
// Default shortcut set for the dashboard.
//
// IMPORTANT: edit the `path` values below to match your actual routes
// before wiring this in — these are reasonable guesses based on the
// pages you've described (Dashboard, Calls, Jobs, Leads, Business Profile).
// ---------------------------------------------------------------------------

export function DEFAULT_SHORTCUTS(navigate: NavigateFunction, openHelp: () => void): Shortcut[] {
  return [
    {
      type: 'sequence',
      keys: ['g', 'd'],
      description: 'Go to Dashboard',
      category: 'Navigation',
      action: () => navigate('/dashboard'),
    },
    {
      type: 'sequence',
      keys: ['g', 'c'],
      description: 'Go to Calls',
      category: 'Navigation',
      action: () => navigate('/calls'),
    },
    {
      type: 'sequence',
      keys: ['g', 'j'],
      description: 'Go to Jobs',
      category: 'Navigation',
      action: () => navigate('/jobs'),
    },
    {
      type: 'sequence',
      keys: ['g', 'l'],
      description: 'Go to Leads',
      category: 'Navigation',
      action: () => navigate('/leads'),
    },
    {
      type: 'sequence',
      keys: ['g', 'p'],
      description: 'Go to Business Profile',
      category: 'Navigation',
      action: () => navigate('/business-profile'),
    },
    {
      type: 'combo',
      combo: '?',
      description: 'Show keyboard shortcuts',
      category: 'General',
      action: openHelp,
    },
    {
      type: 'combo',
      combo: 'mod+k',
      description: 'Open quick search',
      category: 'General',
      action: () => {
        // Wire this to your search/command-palette trigger once it exists.
        // Left as a no-op placeholder so this file has zero unresolved deps.
      },
    },
  ];
}
