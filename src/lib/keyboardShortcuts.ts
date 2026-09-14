// src/lib/keyboardShortcuts.ts
//
// Central registry + hook for dashboard-wide keyboard shortcuts.
// Two shortcut styles are supported:
//
//   1. "combo"    — a single keypress with modifiers, e.g. "?", "mod+s"
//                   ("mod" = Cmd on Mac, Ctrl on Windows/Linux)
//   2. "sequence" — a short chord typed one key at a time, e.g. ["g", "d"]
//                   (press g, then d, within ~800ms) — the "Gmail/Linear/
//                   GitHub" style power-user navigation pattern.
//
// NOTE: Cmd/Ctrl+K is intentionally NOT defined here — this project already
// has a <CommandPalette /> component mounted in DashboardLayout, which very
// likely owns that shortcut internally. Defining it again here would risk
// a double-handler conflict. If CommandPalette does NOT already listen for
// mod+k, add it back here once confirmed.
//
// This file has ZERO dependency on any specific page — it only needs
// `useNavigate` from react-router-dom for nav-type shortcuts. It's wired up
// ONCE inside DashboardNav.tsx so it applies across every dashboard page
// automatically (see that file for the integration).

import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComboShortcut {
  type: 'combo';
  /** e.g. "mod+shift+k", "?", "/" */
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
// The hook — attach once per app (inside DashboardNav.tsx)
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
  }, [enabled, shortcuts]);
}

// ---------------------------------------------------------------------------
// Default shortcut set for the dashboard.
// Routes matched exactly against PRIMARY_ITEMS / ACCOUNT_ITEMS in
// DashboardNav.tsx as of this integration.
// ---------------------------------------------------------------------------

export function DEFAULT_SHORTCUTS(navigate: NavigateFunction, openHelp: () => void): Shortcut[] {
  return [
    { type: 'sequence', keys: ['g', 'o'], description: 'Go to Overview', category: 'Navigation', action: () => navigate('/dashboard') },
    { type: 'sequence', keys: ['g', 'c'], description: 'Go to Calendar', category: 'Navigation', action: () => navigate('/dashboard/calendar') },
    { type: 'sequence', keys: ['g', 'j'], description: 'Go to My Jobs', category: 'Navigation', action: () => navigate('/dashboard/jobs') },
    { type: 'sequence', keys: ['g', 'h'], description: 'Go to Call History', category: 'Navigation', action: () => navigate('/dashboard/calls') },
    { type: 'sequence', keys: ['g', 'v'], description: 'Go to Voicemails', category: 'Navigation', action: () => navigate('/dashboard/voicemails') },
    { type: 'sequence', keys: ['g', 'l'], description: 'Go to Leads', category: 'Navigation', action: () => navigate('/dashboard/leads') },
    { type: 'sequence', keys: ['g', 'a'], description: 'Go to Analytics', category: 'Navigation', action: () => navigate('/dashboard/analytics') },
    { type: 'sequence', keys: ['g', 'i'], description: 'Go to Insights', category: 'Navigation', action: () => navigate('/dashboard/insights') },
    { type: 'sequence', keys: ['g', 'r'], description: 'Go to Reviews', category: 'Navigation', action: () => navigate('/dashboard/reviews') },
    { type: 'sequence', keys: ['g', 'p'], description: 'Go to Business Profile', category: 'Navigation', action: () => navigate('/dashboard/business-profile') },
    { type: 'sequence', keys: ['g', 't'], description: 'Go to Team', category: 'Navigation', action: () => navigate('/dashboard/team') },
    { type: 'sequence', keys: ['g', 'b'], description: 'Go to Billing', category: 'Navigation', action: () => navigate('/dashboard/billing') },
    { type: 'sequence', keys: ['g', 's'], description: 'Go to Settings', category: 'Navigation', action: () => navigate('/dashboard/settings') },
    { type: 'combo', combo: '?', description: 'Show keyboard shortcuts', category: 'General', action: openHelp },
  ];
}
