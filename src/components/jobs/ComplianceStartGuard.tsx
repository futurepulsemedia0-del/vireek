import { useCallback, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ShieldAlert, X } from 'lucide-react';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { useToast } from '@/contexts/ToastContext';
import {
  acknowledgeComplianceReview,
  fetchStartStatus,
  generateComplianceReview,
  type StartStatus,
} from '@/lib/permitCompliance';

interface Pending {
  jobId: string;
  unresolved: StartStatus['unresolved'];
}

const MIN_REASON = 8;

/**
 * Pre-start compliance guard. Call `guardStart(jobId)` before moving a job to
 * en_route / in_progress: it resolves `true` when the job may proceed and
 * `false` when the user backed out.
 *
 * - No blockers, or blockers already acknowledged → resolves true instantly.
 * - Unresolved blockers → shows a dialog that requires a written reason; the
 *   acknowledgement (who / when / why) is recorded server-side + audit-logged.
 * - The guard FAILS OPEN on any technical error (offline, quota, AI down) so
 *   a compliance-service hiccup can never stop a crew from working.
 */
export function useComplianceStartGuard(): {
  guardStart: (jobId: string) => Promise<boolean>;
  complianceDialog: ReactNode;
} {
  const { toast } = useToast();
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const dialogRef = useFocusTrap(pending !== null);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setPending(null);
    setReason('');
    setSubmitting(false);
  }, []);

  useEscapeToClose(pending !== null, () => settle(false));

  const guardStart = useCallback(async (jobId: string): Promise<boolean> => {
    try {
      let status = await fetchStartStatus(jobId);
      if (!status.has_review) {
        // First time this job is starting: build the review now (rules are instant, AI is best-effort).
        await generateComplianceReview(jobId);
        status = await fetchStartStatus(jobId);
      }
      if (!status.needs_ack) return true;
      return await new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setPending({ jobId, unresolved: status.unresolved });
      });
    } catch {
      return true; // fail open
    }
  }, []);

  const confirm = async () => {
    if (!pending || submitting || reason.trim().length < MIN_REASON) return;
    setSubmitting(true);
    try {
      await acknowledgeComplianceReview(pending.jobId, reason.trim());
      settle(true);
    } catch (err) {
      setSubmitting(false);
      toast(err instanceof Error ? err.message : 'Could not record your acknowledgement.', 'error');
    }
  };

  const complianceDialog = (
    <AnimatePresence>
      {pending && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => settle(false)}
            className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            ref={dialogRef}
            tabIndex={-1}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="compliance-guard-title"
            aria-describedby="compliance-guard-description"
            className="fixed left-1/2 top-1/2 z-[120] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger">
                <ShieldAlert size={20} />
              </span>
              <button
                type="button"
                onClick={() => settle(false)}
                aria-label="Cancel"
                className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"
              >
                <X size={18} />
              </button>
            </div>
            <h2
              id="compliance-guard-title"
              className="mt-4 text-base font-semibold text-text-primary"
            >
              Compliance items still open
            </h2>
            <p
              id="compliance-guard-description"
              className="mt-1.5 text-sm leading-relaxed text-text-secondary"
            >
              This job has{' '}
              {pending.unresolved.length === 1
                ? 'an unresolved item'
                : `${pending.unresolved.length} unresolved items`}{' '}
              that should normally be handled before work starts. You can resolve them in the job's
              Permit &amp; Compliance panel, or continue with a recorded reason.
            </p>
            <ul className="mt-3 space-y-1.5">
              {pending.unresolved.slice(0, 5).map((u) => (
                <li key={u.key} className="flex items-start gap-1.5 text-sm text-text-primary">
                  <ShieldAlert size={13} className="mt-0.5 shrink-0 text-danger" />
                  {u.title}
                </li>
              ))}
              {pending.unresolved.length > 5 && (
                <li className="text-xs text-text-secondary">
                  + {pending.unresolved.length - 5} more
                </li>
              )}
            </ul>
            <div className="mt-4">
              <label
                htmlFor="compliance-guard-reason"
                className="mb-1.5 block text-xs font-medium text-text-secondary"
              >
                Why is it OK to proceed? (recorded in the audit log)
              </label>
              <textarea
                id="compliance-guard-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="e.g. Permit already filed by the GC — number pending."
                className="focus-ring w-full resize-none rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60"
              />
            </div>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => settle(false)}
                className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary"
              >
                Go back
              </button>
              <button
                type="button"
                disabled={submitting || reason.trim().length < MIN_REASON}
                onClick={confirm}
                className="focus-ring flex-1 rounded-xl bg-danger px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Recording…' : 'Acknowledge & start'}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );

  return { guardStart, complianceDialog };
}
