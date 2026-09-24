import { useMemo, useState } from 'react';
import { X, CheckCircle2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { matchJobType, type TradePlaybook } from '@/lib/tradePlaybookCatalog';
import { RESOLUTION_LABELS, recordJobOutcome, type AwaitingJob } from '@/lib/tradePlaybooks';
import type { Resolution } from '@/lib/outcomeLearning';

interface JobOutcomeDialogProps {
  job: AwaitingJob;
  playbook: TradePlaybook;
  ownerId: string;
  onClose: () => void;
  onSaved: () => void;
}

const FIELD =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/70';

/**
 * Captures the outcome of a completed job so the playbook can learn from it.
 * Reusable: the Jobs page can open this for any completed job.
 */
export function JobOutcomeDialog({ job, playbook, ownerId, onClose, onSaved }: JobOutcomeDialogProps) {
  const { toast } = useToast();
  const trapRef = useFocusTrap(true);
  useEscapeToClose(true, onClose);

  const [jobTypeKey, setJobTypeKey] = useState(() => matchJobType(playbook, job.service_type)?.key ?? playbook.jobTypes[0].key);
  const [resolution, setResolution] = useState<Resolution>('fixed_first_visit');
  const [rootCause, setRootCause] = useState('');
  const [done, setDone] = useState<string[]>([]);
  const [parts, setParts] = useState('');
  const [rating, setRating] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const jobType = useMemo(() => playbook.jobTypes.find((j) => j.key === jobTypeKey) ?? playbook.jobTypes[0], [playbook, jobTypeKey]);

  const changeJobType = (key: string) => {
    setJobTypeKey(key);
    setRootCause('');
    setDone([]);
  };

  const toggleItem = (id: string) => setDone((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleSave = async () => {
    setSaving(true);
    try {
      await recordJobOutcome(ownerId, {
        job,
        playbook,
        jobType,
        rootCauseKey: rootCause === '' ? null : rootCause,
        resolution,
        checklistDone: done,
        partsUsed: parts.split(',').map((p) => p.trim()).filter(Boolean).slice(0, 20),
        notes,
        customerRating: rating === '' ? null : Number(rating),
      });
      toast('Outcome recorded.', 'success');
      onSaved();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not record this outcome. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-outcome-title"
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="job-outcome-title" className="text-base font-semibold text-text-primary">Record job outcome</h2>
            <p className="mt-0.5 text-xs text-text-secondary">
              {job.customer_name}
              {job.service_type ? ` · ${job.service_type}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="outcome-job-type" className="mb-1 block text-xs font-semibold text-text-primary">Job type</label>
            <select id="outcome-job-type" value={jobTypeKey} onChange={(e) => changeJobType(e.target.value)} className={FIELD}>
              {playbook.jobTypes.map((j) => (
                <option key={j.key} value={j.key}>{j.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="outcome-resolution" className="mb-1 block text-xs font-semibold text-text-primary">Result</label>
            <select id="outcome-resolution" value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)} className={FIELD}>
              {(Object.keys(RESOLUTION_LABELS) as Resolution[]).map((r) => (
                <option key={r} value={r}>{RESOLUTION_LABELS[r]}</option>
              ))}
            </select>
          </div>

          {jobType.troubleshooting && (
            <div>
              <label htmlFor="outcome-cause" className="mb-1 block text-xs font-semibold text-text-primary">Root cause found</label>
              <select id="outcome-cause" value={rootCause} onChange={(e) => setRootCause(e.target.value)} className={FIELD}>
                <option value="">Not diagnosed / other</option>
                {jobType.troubleshooting.causes.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </div>
          )}

          <fieldset>
            <legend className="mb-1.5 text-xs font-semibold text-text-primary">Checklist steps completed</legend>
            <div className="space-y-1.5">
              {jobType.checklist.map((item) => (
                <label key={item.id} className="flex cursor-pointer items-start gap-2 text-xs text-text-secondary">
                  <input type="checkbox" checked={done.includes(item.id)} onChange={() => toggleItem(item.id)} className="focus-ring mt-0.5 h-4 w-4 rounded border-border accent-accent" />
                  <span>
                    {item.label}
                    {item.critical && <span className="ml-1.5 rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">Critical</span>}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label htmlFor="outcome-parts" className="mb-1 block text-xs font-semibold text-text-primary">Parts used (comma-separated)</label>
              <input id="outcome-parts" value={parts} onChange={(e) => setParts(e.target.value)} maxLength={300} placeholder="Run capacitor, contactor" className={FIELD} />
            </div>
            <div>
              <label htmlFor="outcome-rating" className="mb-1 block text-xs font-semibold text-text-primary">Rating</label>
              <select id="outcome-rating" value={rating} onChange={(e) => setRating(e.target.value)} className={FIELD}>
                <option value="">None</option>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>{n} / 5</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="outcome-notes" className="mb-1 block text-xs font-semibold text-text-primary">Notes</label>
            <textarea id="outcome-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} rows={2} className={FIELD} />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="focus-ring rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary hover:bg-bg-tertiary">
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className="focus-ring flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50">
            <CheckCircle2 size={15} />
            {saving ? 'Saving…' : 'Save outcome'}
          </button>
        </div>
      </div>
    </div>
  );
}
