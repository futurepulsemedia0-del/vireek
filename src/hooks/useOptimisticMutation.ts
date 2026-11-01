import { useCallback, useRef } from 'react';
import { useTrustT } from '@/hooks/useTrustT';
import { useToast } from '@/contexts/ToastContext';
import { captureIncident } from '@/lib/incidentReporting';
import type { AppError } from '@/lib/trust/appError';
import { mutationRunner, type MutationResult, type OptimisticSpec } from '@/lib/trust/optimistic';

type Spec<V, T, S> = Omit<OptimisticSpec<V, T, S>, 'rollback'> & {
  rollback: OptimisticSpec<V, T, S>['rollback'];
  /** Skip the failure toast (e.g. the caller shows its own ErrorPanel). */
  silent?: boolean;
  /** Domain-specific handling (quality gates, conflict dialog…). Return true if you showed your own message. */
  onFailure?: (error: AppError, cause: unknown) => boolean;
};

/**
 * React wiring for the shared optimistic-mutation runner. On failure it rolls
 * back (via the spec), tells the user what happened in plain language with the
 * support reference, and offers Retry (which re-applies the change optimistically).
 */
export function useOptimisticMutation() {
  const { t } = useTrustT();
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const mutate = useCallback(
    function run<V, T, S>(spec: Spec<V, T, S>): Promise<MutationResult<T>> {
      return mutationRunner.mutate(spec).then((result) => {
        if (result.ok) return result;
        const { error, cause } = result;
        if (error.kind === 'server' || error.kind === 'unknown') captureIncident(cause, { incidentId: error.referenceId });
        if (spec.silent || spec.onFailure?.(error, cause) === true) return result;
        const base = `${t('mutation.failedTitle')} ${t('mutation.reverted')} ${t(`error.${error.kind}.title`)}. ${t('reference.label')}: ${error.referenceId}`;
        toastRef.current(base, 'error', {
          durationMs: 10_000,
          action: error.retryable ? { label: t('mutation.retry'), onClick: () => void run(spec) } : undefined,
        });
        return result;
      });
    },
    [t],
  );

  return { mutate };
}
