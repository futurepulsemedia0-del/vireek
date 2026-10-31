import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { useInLoadingScope } from './LoadingScope';
import { useDelayedLoading } from './useDelayedLoading';
import './loading.css';

interface LoadingBoundaryProps {
  isLoading: boolean;
  /** Any truthy value renders the error state. */
  error?: unknown;
  isEmpty?: boolean;
  onRetry?: () => void;
  /** Layout-matching skeleton (see skeletons.tsx). Reserves space so nothing shifts. */
  skeleton: ReactNode;
  /** Rendered when `isEmpty` (e.g. your <EmptyState/>). */
  empty?: ReactNode;
  /** Screen-reader text, e.g. "Loading invoices". */
  label?: string;
  /** Show "still working…" after this many ms of loading. Default 8000. */
  slowAfterMs?: number;
  /** Switch to a timeout error after this many ms. 0 disables. Default 30000. */
  timeoutMs?: number;
  className?: string;
  children: ReactNode;
}

/**
 * One consistent loading / empty / slow / error / timeout / content state machine.
 * Order: error → timeout → loading (skeleton) → empty → content.
 */
export function LoadingBoundary({
  isLoading,
  error,
  isEmpty = false,
  onRetry,
  skeleton,
  empty,
  label,
  slowAfterMs = 8000,
  timeoutMs = 30000,
  className,
  children,
}: LoadingBoundaryProps) {
  const { t } = useTranslation('common', { useSuspense: false });
  const suppressed = useInLoadingScope();
  const visible = useDelayedLoading(isLoading);
  const [slow, setSlow] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setSlow(false);
    setTimedOut(false);
    if (!isLoading) return;
    const slowId = window.setTimeout(() => setSlow(true), slowAfterMs);
    const timeoutId = timeoutMs > 0 ? window.setTimeout(() => setTimedOut(true), timeoutMs) : undefined;
    return () => {
      window.clearTimeout(slowId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [isLoading, slowAfterMs, timeoutMs, attempt]);

  const retry = () => {
    setAttempt((n) => n + 1);
    onRetry?.();
  };

  const failure = (message: string) => (
    <div role="alert" className={`rounded-2xl border border-border bg-bg-secondary p-6 text-center ${className ?? ''}`.trim()}>
      <p className="text-sm font-medium text-text-primary">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={retry}>
          {t('loading.retry', 'Try again')}
        </Button>
      )}
    </div>
  );

  if (error) return failure(t('loading.error', 'Something went wrong.'));
  if (isLoading && timedOut) return failure(t('loading.timeout', 'This is taking longer than expected.'));

  if (isLoading || visible) {
    const shown = visible && !suppressed;
    return (
      <div aria-busy="true" className={className}>
        {/* `invisible` still reserves the skeleton's space during the first 150ms: zero layout shift. */}
        <div className={shown ? 'vrk-fade-in' : 'invisible'}>{skeleton}</div>
        <span role="status" aria-live="polite" className="sr-only">
          {shown ? (slow && isLoading ? t('loading.slow', 'Still working…') : label ?? t('loading.route', 'Loading')) : ''}
        </span>
        {shown && slow && isLoading && (
          <p aria-hidden="true" className="mt-3 text-center text-sm text-text-secondary">
            {t('loading.slow', 'Still working…')}
          </p>
        )}
      </div>
    );
  }

  if (isEmpty) return <>{empty}</>;
  return (
    <div className={`vrk-fade-in ${className ?? ''}`.trim()}>{children}</div>
  );
}
