import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, Undo2, X } from 'lucide-react';
import { UNDO_WINDOW_MS, type UndoOutcome } from '@/lib/undo/undoEngine';

type Tone = 'success' | 'error' | 'info';

export interface UndoRequest {
  /** What just happened, e.g. "Deleted 3 jobs." */
  message: string;
  /** Performs the inverse. Must never throw; return `{ ok, message }`. */
  undo: () => Promise<UndoOutcome>;
  tone?: Tone;
  /** Defaults to 10 s. */
  windowMs?: number;
}

interface Entry {
  id: string;
  message: string;
  tone: Tone;
  windowMs: number;
  phase: 'pending' | 'working' | 'done';
  outcome?: UndoOutcome;
  paused: boolean;
  undo: () => Promise<UndoOutcome>;
}

interface UndoContextValue {
  offerUndo: (req: UndoRequest) => void;
}

const UndoContext = createContext<UndoContextValue | undefined>(undefined);

const RESULT_VISIBLE_MS = 5_000;
const MAX_ENTRIES = 5;
const MAX_VISIBLE = 3;

interface TimerState {
  handle: number | null;
  deadline: number;
  remaining: number;
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

export function UndoProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const entriesRef = useRef<Entry[]>([]);
  entriesRef.current = entries;
  const timers = useRef(new Map<string, TimerState>());

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t?.handle != null) window.clearTimeout(t.handle);
    timers.current.delete(id);
  }, []);

  const remove = useCallback(
    (id: string) => {
      clearTimer(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    },
    [clearTimer],
  );

  const startTimer = useCallback(
    (id: string, ms: number) => {
      const existing = timers.current.get(id);
      if (existing?.handle != null) window.clearTimeout(existing.handle);
      const handle = window.setTimeout(() => {
        // Never drop a toast while its undo is still in flight.
        const current = entriesRef.current.find((e) => e.id === id);
        if (current?.phase === 'working') return;
        remove(id);
      }, ms);
      timers.current.set(id, { handle, deadline: Date.now() + ms, remaining: ms });
    },
    [remove],
  );

  const pause = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (!t || t.handle == null) return;
    window.clearTimeout(t.handle);
    t.remaining = Math.max(0, t.deadline - Date.now());
    t.handle = null;
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, paused: true } : e)));
  }, []);

  const resume = useCallback(
    (id: string) => {
      const t = timers.current.get(id);
      if (!t || t.handle != null) return;
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, paused: false } : e)));
      startTimer(id, Math.max(250, t.remaining));
    },
    [startTimer],
  );

  const offerUndo = useCallback(
    (req: UndoRequest) => {
      const id = Math.random().toString(36).slice(2);
      const windowMs = req.windowMs ?? UNDO_WINDOW_MS;
      setEntries((prev) => {
        const next = [
          ...prev,
          { id, message: req.message, tone: req.tone ?? 'success', windowMs, phase: 'pending' as const, paused: false, undo: req.undo },
        ];
        // Bound memory: the oldest toasts' undo windows are simply forfeited.
        while (next.length > MAX_ENTRIES) {
          const dropped = next.shift();
          if (dropped) clearTimer(dropped.id);
        }
        return next;
      });
      startTimer(id, windowMs);
    },
    [clearTimer, startTimer],
  );

  const runUndo = useCallback(
    async (id: string) => {
      const entry = entriesRef.current.find((e) => e.id === id);
      if (!entry || entry.phase !== 'pending') return; // double-click / double-shortcut safe
      clearTimer(id);
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, phase: 'working', paused: false } : e)));
      let outcome: UndoOutcome;
      try {
        outcome = await entry.undo();
      } catch (e) {
        outcome = { ok: false, message: e instanceof Error ? e.message : 'Could not undo.' };
      }
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, phase: 'done', outcome } : e)));
      startTimer(id, RESULT_VISIBLE_MS);
    },
    [clearTimer, startTimer],
  );

  // Ctrl/Cmd+Z undoes the most recent pending action (never while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (isEditable(e.target)) return;
      const latest = [...entriesRef.current].reverse().find((x) => x.phase === 'pending');
      if (!latest) return;
      e.preventDefault();
      void runUndo(latest.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runUndo]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => t.handle != null && window.clearTimeout(t.handle));
      map.clear();
    };
  }, []);

  const value = useMemo(() => ({ offerUndo }), [offerUndo]);
  const visible = entries.slice(-MAX_VISIBLE);

  return (
    <UndoContext.Provider value={value}>
      {children}
      <style>{`
        @keyframes vk-undo-shrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }
        @media (prefers-reduced-motion: reduce) { .vk-undo-bar { animation: none !important; } }
      `}</style>
      <div
        aria-label="Undo"
        role="region"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[130] flex flex-col items-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <AnimatePresence>
          {visible.map((e) => (
            <motion.div
              key={e.id}
              role="status"
              aria-live="polite"
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.97 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              onMouseEnter={() => e.phase === 'pending' && pause(e.id)}
              onMouseLeave={() => resume(e.id)}
              onFocusCapture={() => e.phase === 'pending' && pause(e.id)}
              onBlurCapture={() => resume(e.id)}
              className="pointer-events-auto relative w-full max-w-md overflow-hidden rounded-xl border border-border bg-bg-secondary/95 shadow-card backdrop-blur-md dark:shadow-card-dark"
            >
              <div className="flex items-center gap-3 px-4 py-3">
                <p
                  className={`flex-1 text-sm leading-relaxed ${
                    e.phase === 'done' && e.outcome && !e.outcome.ok
                      ? 'text-danger'
                      : e.tone === 'error' && e.phase === 'pending'
                        ? 'text-danger'
                        : 'text-text-primary'
                  }`}
                >
                  {e.phase === 'done' ? e.outcome?.message : e.phase === 'working' ? 'Undoing…' : e.message}
                </p>
                {e.phase === 'pending' && (
                  <button
                    type="button"
                    onClick={() => void runUndo(e.id)}
                    title="Undo (Ctrl/⌘+Z)"
                    className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-semibold text-accent hover:bg-accent/10"
                  >
                    <Undo2 size={15} aria-hidden="true" />
                    Undo
                  </button>
                )}
                {e.phase === 'working' && <Loader2 size={16} className="shrink-0 animate-spin text-text-secondary" aria-hidden="true" />}
                {e.phase !== 'working' && (
                  <button
                    type="button"
                    onClick={() => remove(e.id)}
                    aria-label="Dismiss"
                    className="focus-ring shrink-0 rounded text-text-secondary transition-colors hover:text-text-primary"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              {e.phase === 'pending' && (
                <div className="h-0.5 w-full bg-border/60" aria-hidden="true">
                  <div
                    className="vk-undo-bar h-full origin-left bg-accent"
                    style={{
                      animation: `vk-undo-shrink ${e.windowMs}ms linear forwards`,
                      animationPlayState: e.paused ? 'paused' : 'running',
                    }}
                  />
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </UndoContext.Provider>
  );
}

export function useUndo(): UndoContextValue {
  const ctx = useContext(UndoContext);
  if (!ctx) throw new Error('useUndo must be used within an UndoProvider');
  return ctx;
}
