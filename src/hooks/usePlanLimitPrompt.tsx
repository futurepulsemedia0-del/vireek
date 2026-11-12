import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { PlanLimitDialog } from '@/components/PlanLimitDialog';
import { parsePlanLimitError, type PlanLimitError } from '@/lib/planLimits';

/**
 * const planLimit = usePlanLimitPrompt();
 * catch (err) { if (planLimit.handle(err)) return; ...existing handling... }
 * ...render {planLimit.dialog} once in the component.
 * handle() returns true when the error was a plan limit (the upgrade dialog is now showing).
 */
export function usePlanLimitPrompt(): { handle: (err: unknown) => boolean; dialog: ReactNode } {
  const [error, setError] = useState<PlanLimitError | null>(null);
  const handle = useCallback((err: unknown) => {
    const parsed = parsePlanLimitError(err);
    if (!parsed) return false;
    setError(parsed);
    return true;
  }, []);
  const close = useCallback(() => setError(null), []);
  const dialog = useMemo(() => (error ? <PlanLimitDialog error={error} onClose={close} /> : null), [error, close]);
  return { handle, dialog };
}
