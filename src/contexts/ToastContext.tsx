import {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CircleCheck as CheckCircle2, CircleAlert as AlertCircle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastOptions {
  action?: ToastAction;
  durationMs?: number;
}
interface Toast {
  id: string;
  type: ToastType;
  message: string;
  action?: ToastAction;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const iconMap: Record<ToastType, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const colorMap: Record<ToastType, string> = {
  success: 'text-success-500',
  error: 'text-danger',
  info: 'text-accent',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = 'success', options?: ToastOptions) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((prev) => [...prev, { id, type, message, action: options?.action }]);
      setTimeout(() => dismiss(id), options?.durationMs ?? 4000);
    },
    [dismiss]
  );
  
  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <role="status" aria-live="polite" flex flex-col gap-3 sm:right-6 sm:top-6">
        <AnimatePresence>
          {toasts.map((t) => {
            const Icon = iconMap[t.type];
            return (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, x: 100, scale: 0.95 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 100, scale: 0.95 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                className="flex items-start gap-3 rounded-xl border border-border bg-bg-secondary/95 p-4 shadow-card backdrop-blur-md dark:shadow-card-dark"
                style={{ minWidth: 280, maxWidth: 380 }}
              >
                <Icon size={20} className={`mt-0.5 shrink-0 ${colorMap[t.type]}`} />
                <p className="flex-1 text-sm leading-relaxed text-text-primary">{t.message}</p>
                {t.action && (
  <button
    type="button"
    onClick={() => {
      t.action?.onClick();
      dismiss(t.id);
    }}
    className="focus-ring shrink-0 rounded-md px-2 py-1 text-sm font-semibold text-accent hover:bg-accent/10"
  >
    {t.action.label}
  </button>
)}
                <button
                  type="button"
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss"
                  className="focus-ring shrink-0 rounded text-text-secondary transition-colors hover:text-text-primary"
                >
                  <X size={16} />
                </button>
              </motion.div>
            );
          })}
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
