import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CircleCheck as CheckCircle2, CircleAlert as AlertCircle, Info, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { announce } from '@/lib/a11y/announcer';
import { haptic } from '@/lib/native/haptics';
import { ToastItem, ToastType, defaultDuration, initialToastState, toastKey, toastReducer } from '@/contexts/toastReducer';

export type { ToastType } from '@/contexts/toastReducer';

interface ToastOptions {
  action?: { label: string; onClick: () => void };
  durationMs?: number;
  sticky?: boolean;
  id?: string;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const iconMap: Record<ToastType, typeof CheckCircle2> = { success: CheckCircle2, error: AlertCircle, info: Info, warning: TriangleAlert };
const colorMap: Record<ToastType, string> = { success: 'text-success-500', error: 'text-danger', info: 'text-accent', warning: 'text-warning-500' };

function useAutoDismiss(durationMs: number | null, paused: boolean, bump: number, onExpire: () => void) {
  const remaining = useRef(durationMs ?? 0);
  const startedAt = useRef(0);
  const expire = useRef(onExpire);
  expire.current = onExpire;

  useEffect(() => {
    remaining.current = durationMs ?? 0;
  }, [durationMs, bump]);

  useEffect(() => {
    if (durationMs === null || paused) return;
    startedAt.current = Date.now();
    const id = window.setTimeout(() => expire.current(), remaining.current);
    return () => {
      window.clearTimeout(id);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    };
  }, [durationMs, paused, bump]);
}

function ToastCard({ item, onDismiss, reduceMotion }: { item: ToastItem; onDismiss: (id: string) => void; reduceMotion: boolean }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const dismiss = useCallback(() => onDismiss(item.id), [onDismiss, item.id]);
  useAutoDismiss(item.durationMs, hovered || focused || hidden, item.bump, dismiss);

  const Icon = iconMap[item.type];
  return (
    <motion.div
      layout={!reduceMotion}
      initial={{ opacity: 0, y: reduceMotion ? 0 : -12, scale: reduceMotion ? 1 : 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.97, transition: { duration: 0.15 } }}
      transition={{ duration: reduceMotion ? 0.01 : 0.22, ease: [0.16, 1, 0.3, 1] }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') dismiss();
      }}
      data-toast-type={item.type}
      className="pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-bg-secondary/95 p-4 shadow-card backdrop-blur-md dark:shadow-card-dark"
    >
      <Icon size={20} aria-hidden="true" className={`mt-0.5 shrink-0 ${colorMap[item.type]}`} />
      <p className="flex-1 text-sm leading-relaxed text-text-primary">
        {item.message}
        {item.count > 1 && <span className="ms-2 rounded-full bg-bg-tertiary px-1.5 py-0.5 text-xs font-semibold tabular-nums text-text-secondary">×{item.count}</span>}
      </p>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            item.action?.onClick();
            dismiss();
          }}
          className="focus-ring shrink-0 rounded-md px-2 py-1 text-sm font-semibold text-accent hover:bg-accent/10"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('ui.dismiss', { defaultValue: 'Dismiss' })}
        className="focus-ring shrink-0 rounded text-text-secondary transition-colors hover:text-text-primary"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </motion.div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion() ?? false;
  const [state, dispatch] = useReducer(toastReducer, initialToastState);
  const recentlyAnnounced = useRef(new Map<string, number>());
  const seq = useRef(0);

  const dismiss = useCallback((id: string) => dispatch({ type: 'dismiss', id }), []);
  const dismissAll = useCallback(() => dispatch({ type: 'clear' }), []);

  const toast = useCallback((message: string, type: ToastType = 'success', options?: ToastOptions) => {
    const key = toastKey(type, message);
    const id = options?.id ?? `toast-${++seq.current}`;
    const durationMs = options?.durationMs ?? defaultDuration(type, message, !!options?.action, options?.sticky);
    dispatch({ type: 'add', toast: { id, key, type, message, action: options?.action, durationMs, count: 1, bump: 0 } });
    const now = Date.now();
    const last = recentlyAnnounced.current.get(key);
    if (last === undefined || now - last > 1500) {
      recentlyAnnounced.current.set(key, now);
      announce(message, type === 'error' || type === 'warning' ? 'assertive' : 'polite');
      if (type === 'error') void haptic('error');
    }
    return id;
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toast, dismiss, dismissAll }), [toast, dismiss, dismissAll]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="region"
        aria-label={t('ui.notifications', { defaultValue: 'Notifications' })}
        className="pointer-events-none fixed inset-x-4 top-[max(1rem,env(safe-area-inset-top))] z-[300] flex flex-col gap-3 sm:inset-x-auto sm:end-6 sm:top-6 sm:w-[380px]"
      >
        <AnimatePresence initial={false}>
          {state.visible.map((item) => (
            <ToastCard key={item.id} item={item} onDismiss={dismiss} reduceMotion={reduceMotion} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within a ToastProvider');
  return context;
}
