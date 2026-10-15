import { useEffect, useId, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, PauseCircle, X } from 'lucide-react';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  DEFAULT_WORKFLOW_POLICIES,
  NOTE_MAX,
  OTHER_REASON,
  WORKFLOW_STATUSES,
  WORKFLOW_STATUS_META,
  describePolicy,
  isWorkflowStatus,
  reasonsFor,
  validateHoldInput,
  type HoldErrors,
  type HoldPayload,
  type WorkflowPolicy,
  type WorkflowStatus,
} from '@/lib/jobWorkflow';

export interface JobHoldDialogProps {
  open: boolean;
  /** e.g. customer name — shown in the title for context. */
  jobLabel: string;
  /** Preselects the status (kanban drop / quick action). The user can still change it. */
  initialStatus?: WorkflowStatus | null;
  /** Effective SLA / reminder policy per status (defaults are used when omitted). */
  policies?: Record<WorkflowStatus, WorkflowPolicy>;
  /** Resolves after the request finishes; return an error message to keep the dialog open. */
  onSubmit: (payload: HoldPayload) => Promise<string | null | void>;
  onClose: () => void;
}

const FIELD = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';

/** Dialog that collects the REQUIRED reason when a job moves to a workflow status. */
export function JobHoldDialog({ open, jobLabel, initialStatus = null, policies = DEFAULT_WORKFLOW_POLICIES, onSubmit, onClose }: JobHoldDialogProps) {
  const [status, setStatus] = useState<WorkflowStatus | null>(initialStatus);
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [resumeAt, setResumeAt] = useState('');
  const [errors, setErrors] = useState<HoldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const dialogRef = useFocusTrap(open);
  useEscapeToClose(open && !submitting, onClose);
  const uid = useId();

  // Reset every time the dialog opens so stale input never leaks between jobs.
  useEffect(() => {
    if (!open) return;
    setStatus(initialStatus && isWorkflowStatus(initialStatus) ? initialStatus : null);
    setReasonCode('');
    setNote('');
    setResumeAt('');
    setErrors({});
    setServerError(null);
    setSubmitting(false);
  }, [open, initialStatus]);

  const reasons = useMemo(() => (status ? reasonsFor(status) : []), [status]);
  const policy = status ? policies[status] : null;
  const noteRequired = reasonCode === OTHER_REASON;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const result = validateHoldInput({ status, reasonCode, note, expectedResumeAt: resumeAt });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setServerError(null);
    setSubmitting(true);
    try {
      const message = await onSubmit(result.value);
      if (message) setServerError(message);
    } catch {
      setServerError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={submitting ? undefined : onClose}
            className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${uid}-title`}
            className="fixed left-1/2 top-1/2 z-[120] max-h-[92vh] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-5 shadow-card-hover dark:shadow-card-hover-dark sm:p-6"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning-500/10 text-warning-500">
                <PauseCircle size={20} aria-hidden="true" />
              </span>
              <button type="button" onClick={onClose} disabled={submitting} aria-label="Close" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary">
                <X size={18} />
              </button>
            </div>
            <h2 id={`${uid}-title`} className="mt-3 text-base font-semibold text-text-primary">
              Update status — {jobLabel}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">A reason is required so the team knows why this job is paused.</p>

            <form onSubmit={submit} noValidate className="mt-4 space-y-4">
              <div>
                <label htmlFor={`${uid}-status`} className="mb-1 block text-xs font-medium text-text-secondary">
                  Status
                </label>
                <select
                  id={`${uid}-status`}
                  value={status ?? ''}
                  onChange={(e) => {
                    setStatus(isWorkflowStatus(e.target.value) ? e.target.value : null);
                    setReasonCode('');
                    setErrors({});
                  }}
                  aria-invalid={Boolean(errors.status)}
                  className={FIELD}
                >
                  <option value="">Choose a status…</option>
                  {WORKFLOW_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {WORKFLOW_STATUS_META[s].label}
                    </option>
                  ))}
                </select>
                {status && <p className="mt-1 text-xs text-text-secondary">{WORKFLOW_STATUS_META[status].description}</p>}
                {errors.status && <p role="alert" className="mt-1 text-xs text-danger">{errors.status}</p>}
              </div>

              <div>
                <label htmlFor={`${uid}-reason`} className="mb-1 block text-xs font-medium text-text-secondary">
                  Reason <span className="text-danger" aria-hidden="true">*</span>
                </label>
                <select
                  id={`${uid}-reason`}
                  value={reasonCode}
                  onChange={(e) => {
                    setReasonCode(e.target.value);
                    setErrors((p) => ({ ...p, reason: undefined }));
                  }}
                  disabled={!status}
                  required
                  aria-required="true"
                  aria-invalid={Boolean(errors.reason)}
                  aria-describedby={errors.reason ? `${uid}-reason-err` : undefined}
                  className={`${FIELD} disabled:opacity-50`}
                >
                  <option value="">{status ? 'Choose a reason…' : 'Choose a status first'}</option>
                  {reasons.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
                {errors.reason && <p id={`${uid}-reason-err`} role="alert" className="mt-1 text-xs text-danger">{errors.reason}</p>}
              </div>

              <div>
                <label htmlFor={`${uid}-note`} className="mb-1 block text-xs font-medium text-text-secondary">
                  Note {noteRequired ? <span className="text-danger" aria-hidden="true">*</span> : <span className="font-normal">(optional)</span>}
                </label>
                <textarea
                  id={`${uid}-note`}
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setErrors((p) => ({ ...p, note: undefined }));
                  }}
                  rows={3}
                  maxLength={NOTE_MAX}
                  required={noteRequired}
                  aria-required={noteRequired}
                  aria-invalid={Boolean(errors.note)}
                  aria-describedby={errors.note ? `${uid}-note-err` : undefined}
                  placeholder="e.g. Compressor ordered from Acme, ETA Thursday"
                  className={`${FIELD} resize-y`}
                />
                {errors.note && <p id={`${uid}-note-err`} role="alert" className="mt-1 text-xs text-danger">{errors.note}</p>}
              </div>

              <div>
                <label htmlFor={`${uid}-resume`} className="mb-1 block text-xs font-medium text-text-secondary">
                  Expected to resume <span className="font-normal">(optional — we&apos;ll remind you then)</span>
                </label>
                <input
                  id={`${uid}-resume`}
                  type="datetime-local"
                  value={resumeAt}
                  onChange={(e) => {
                    setResumeAt(e.target.value);
                    setErrors((p) => ({ ...p, resume: undefined }));
                  }}
                  aria-invalid={Boolean(errors.resume)}
                  className={FIELD}
                />
                {errors.resume && <p role="alert" className="mt-1 text-xs text-danger">{errors.resume}</p>}
              </div>

              {policy && (
                <p className="rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary" data-testid="policy-hint">
                  {describePolicy(policy)}
                </p>
              )}

              {serverError && (
                <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
                  {serverError}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  className="focus-ring rounded-xl px-4 py-2.5 text-sm font-semibold text-text-secondary hover:text-text-primary disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="focus-ring inline-flex min-h-[40px] items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-60"
                >
                  {submitting && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                  Update status
                </button>
              </div>
            </form>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
