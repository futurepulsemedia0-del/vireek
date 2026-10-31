// src/contexts/toastReducer.ts
//
// Pure toast queue logic (no React) so dedupe / queue / priority / duration
// rules are unit-tested on their own.

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  key: string; // dedupe key: type + message
  type: ToastType;
  message: string;
  action?: ToastAction;
  /** null = stays until dismissed. */
  durationMs: number | null;
  /** How many times this identical toast was raised (shown as ×N). */
  count: number;
  /** Increments on every duplicate; restarts the auto-dismiss timer. */
  bump: number;
}

export interface ToastState {
  visible: ToastItem[];
  queue: ToastItem[];
}

export type ToastReducerAction =
  | { type: 'add'; toast: ToastItem }
  | { type: 'dismiss'; id: string }
  | { type: 'clear' };

export const MAX_VISIBLE = 3;
export const initialToastState: ToastState = { visible: [], queue: [] };

const PRIORITY: Record<ToastType, number> = { error: 3, warning: 2, info: 1, success: 0 };
const BASE_MS: Record<ToastType, number> = { success: 4000, info: 5000, warning: 8000, error: 10000 };

/**
 * Auto-dismiss rules by severity. Longer messages stay longer (+50ms/char past
 * 40, capped at +6s). An error that offers an action never auto-dismisses —
 * the user must be able to act on it (WCAG 2.2.1).
 */
export function defaultDuration(type: ToastType, message: string, hasAction: boolean, sticky = false): number | null {
  if (sticky || (type === 'error' && hasAction)) return null;
  const extra = Math.min(6000, Math.max(0, message.length - 40) * 50);
  return BASE_MS[type] + extra;
}

export function toastKey(type: ToastType, message: string): string {
  return `${type}|${message}`;
}

function promote(state: ToastState): ToastState {
  let { visible, queue } = state;
  while (visible.length < MAX_VISIBLE && queue.length > 0) {
    visible = [...visible, queue[0]];
    queue = queue.slice(1);
  }
  return { visible, queue };
}

function bumpIn(list: ToastItem[], key: string): ToastItem[] | null {
  if (!list.some((t) => t.key === key)) return null;
  return list.map((t) => (t.key === key ? { ...t, count: t.count + 1, bump: t.bump + 1 } : t));
}

export function toastReducer(state: ToastState, action: ToastReducerAction): ToastState {
  switch (action.type) {
    case 'add': {
      const { toast } = action;
      const dupVisible = bumpIn(state.visible, toast.key);
      if (dupVisible) return { ...state, visible: dupVisible };
      const dupQueued = bumpIn(state.queue, toast.key);
      if (dupQueued) return { ...state, queue: dupQueued };
      if (state.visible.length < MAX_VISIBLE) return { ...state, visible: [...state.visible, toast] };
      // Full: queue it behind anything of equal/higher severity, ahead of lower severity.
      const at = state.queue.findIndex((q) => PRIORITY[q.type] < PRIORITY[toast.type]);
      const queue = at === -1 ? [...state.queue, toast] : [...state.queue.slice(0, at), toast, ...state.queue.slice(at)];
      return { ...state, queue };
    }
    case 'dismiss':
      return promote({
        visible: state.visible.filter((t) => t.id !== action.id),
        queue: state.queue.filter((t) => t.id !== action.id),
      });
    case 'clear':
      return initialToastState;
    default:
      return state;
  }
}
