import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { LoadingScope } from './LoadingScope';
import { Progress } from './Progress';
import { PulseMark } from './PulseMark';
import { Spinner } from './Spinner';
import { useDelayedLoading } from './useDelayedLoading';
import './loading.css';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface OverlayProps {
  open: boolean;
  /** Visible + announced text, e.g. "Processing payment…". */
  label?: string;
  /** Real 0..100 value, or omit for indeterminate. */
  progress?: number | null;
  /** Optional extra content (e.g. a Cancel button). */
  children?: ReactNode;
}

/**
 * BLOCKING overlay for critical actions (payments, submits).
 * It blocks input from the first frame; visuals appear after 150ms and stay >= 400ms.
 * Focus is locked inside, Escape does not dismiss, scroll is locked, focus returns on close.
 */
export function BlockingOverlay({ open, label, progress, children }: OverlayProps) {
  const { t } = useTranslation('common', { useSuspense: false });
  const visible = useDelayedLoading(open);
  const active = open || visible;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    node.focus();

    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Node && !node.contains(e.target)) (focusables()[0] ?? node).focus();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      document.body.style.overflow = prevOverflow;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [active]);

  if (!active) return null;
  const text = label ?? t('loading.processing', 'Processing…');
  return createPortal(
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={text}
      aria-busy="true"
      className="fixed inset-0 z-[2147483000] flex items-center justify-center outline-none"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {visible && (
        <LoadingScope>
          <div className="vrk-fade-in absolute inset-0 bg-bg-primary/85" aria-hidden="true" />
          <div className="vrk-fade-in relative flex w-72 max-w-[90vw] flex-col items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-6 text-center">
            <PulseMark size="md" />
            <p role="status" aria-live="polite" className="text-sm font-medium text-text-primary">
              {text}
            </p>
            {typeof progress === 'number' && <Progress value={progress} label={text} showValue className="w-full" />}
            {children}
          </div>
        </LoadingScope>
      )}
    </div>,
    document.body,
  );
}

interface BackgroundTaskProps {
  open: boolean;
  label: string;
  progress?: number | null;
}

/** NON-blocking toast-style indicator for background work (exports, syncs). */
export function BackgroundTask({ open, label, progress }: BackgroundTaskProps) {
  const visible = useDelayedLoading(open);
  if (!visible) return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="vrk-fade-in fixed z-[2147482000] flex w-72 max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-primary shadow-lg"
      style={{ insetInlineEnd: 16, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}
    >
      <Spinner size={18} className="text-accent" />
      <div className="min-w-0 flex-1">
        <p className="truncate">{label}</p>
        {typeof progress === 'number' && <Progress value={progress} label={label} size="sm" className="mt-2" />}
      </div>
    </div>,
    document.body,
  );
}
