import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck, ShieldAlert, RefreshCw, Loader2, MapPin, Sparkles, Info } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import {
  fetchComplianceReview,
  generateComplianceReview,
  setComplianceItemProgress,
  complianceCounts,
  hasReviewableScope,
  progressFor,
  isResolved,
  CATEGORY_LABELS,
  COMPLIANCE_ELIGIBLE_STATUSES,
  ITEM_STATUS_LABELS,
  PERMIT_LIKELIHOOD_META,
  SEVERITY_META,
  type ComplianceItem,
  type ComplianceReview,
  type ItemStatus,
} from '@/lib/permitCompliance';

const STATUS_OPTIONS: ItemStatus[] = ['open', 'in_progress', 'satisfied', 'not_applicable'];
const SEVERITY_ORDER: ComplianceItem['severity'][] = ['blocker', 'warning', 'info'];

function ItemRow({
  item,
  review,
  saving,
  onSave,
}: {
  item: ComplianceItem;
  review: ComplianceReview;
  saving: boolean;
  onSave: (
    key: string,
    status: ItemStatus,
    extra: { permitNumber?: string; note?: string },
  ) => void;
}) {
  const progress = progressFor(review, item.key);
  const status: ItemStatus = progress?.status ?? 'open';
  const resolved = isResolved(review, item.key);
  const [permitNumber, setPermitNumber] = useState(progress?.permit_number ?? '');
  const [note, setNote] = useState(progress?.note ?? '');
  const meta = SEVERITY_META[item.severity];
  const showPermitNumber = item.category === 'permit' && item.severity !== 'info';

  const commitText = () => {
    if (
      (progress?.permit_number ?? '') === permitNumber.trim() &&
      (progress?.note ?? '') === note.trim()
    )
      return;
    onSave(item.key, status, { permitNumber, note });
  };

  return (
    <li
      className={`rounded-lg border border-border/70 bg-bg-primary p-3 ${resolved ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>
          {meta.label}
        </span>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">
          {CATEGORY_LABELS[item.category]}
        </span>
        {item.source === 'ai' && (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
            <Sparkles size={10} /> AI-suggested — verify
          </span>
        )}
      </div>
      <p
        className={`mt-1.5 text-sm font-medium text-text-primary ${resolved ? 'line-through' : ''}`}
      >
        {item.title}
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">{item.detail}</p>
      {(item.authority || item.reference) && (
        <p className="mt-1 text-[11px] text-text-secondary">
          {item.authority && <span>Verify with: {item.authority}</span>}
          {item.authority && item.reference && <span> · </span>}
          {item.reference && <span>{item.reference}</span>}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`cs-${item.key}`}>
          Status for {item.title}
        </label>
        <select
          id={`cs-${item.key}`}
          value={status}
          disabled={saving}
          onChange={(e) => onSave(item.key, e.target.value as ItemStatus, { permitNumber, note })}
          className="focus-ring rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary disabled:opacity-50"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {ITEM_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        {showPermitNumber && (
          <input
            value={permitNumber}
            onChange={(e) => setPermitNumber(e.target.value)}
            onBlur={commitText}
            maxLength={60}
            aria-label={`Permit number for ${item.title}`}
            placeholder="Permit #"
            className="focus-ring w-28 rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-secondary/60"
          />
        )}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={commitText}
          maxLength={500}
          aria-label={`Note for ${item.title}`}
          placeholder="Note (optional)"
          className="focus-ring min-w-[8rem] flex-1 rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-secondary/60"
        />
        {saving && <Loader2 size={13} className="animate-spin text-text-secondary" />}
      </div>
    </li>
  );
}

/** Minimal shape so both the dashboard `Job` and the technician job brief can use the panel. */
export interface CompliancePanelJob {
  id: string;
  job_status: string;
  service_type?: string | null;
  dispatch_note?: string | null;
}

export function PermitCompliancePanel({ job }: { job: CompliancePanelJob }) {
  const { toast } = useToast();
  const [review, setReview] = useState<ComplianceReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [jurisdictionInput, setJurisdictionInput] = useState('');
  const autoTried = useRef(false);
  const autoExpanded = useRef(false);

  const eligible = COMPLIANCE_ELIGIBLE_STATUSES.has(job.job_status) && hasReviewableScope(job);

  const run = useCallback(
    async (opts: { force?: boolean; jurisdictionOverride?: string } = {}, silent = false) => {
      setGenerating(true);
      try {
        const result = await generateComplianceReview(job.id, opts);
        setReview(result);
        return true;
      } catch (err) {
        if (!silent)
          toast(
            err instanceof Error ? err.message : 'Could not run the compliance review.',
            'error',
          );
        return false;
      } finally {
        setGenerating(false);
      }
    },
    [job.id, toast],
  );

  // Load whatever exists for this job; reset per-job guards when the job changes.
  useEffect(() => {
    let cancelled = false;
    autoTried.current = false;
    autoExpanded.current = false;
    setReview(null);
    setExpanded(false);
    setLoading(true);
    fetchComplianceReview(job.id)
      .then((r) => !cancelled && setReview(r))
      .catch(() => {
        /* panel just stays empty — not worth a toast on a background load */
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [job.id]);

  // First view of an eligible job with no review yet: build it automatically (rules are free/instant).
  useEffect(() => {
    if (loading || review || !eligible || autoTried.current) return;
    autoTried.current = true;
    void run({}, true);
  }, [loading, review, eligible, run]);

  // Open the panel by default when something needs attention.
  const counts = useMemo(() => (review ? complianceCounts(review) : null), [review]);
  useEffect(() => {
    if (counts && counts.blockers > 0 && !autoExpanded.current) {
      autoExpanded.current = true;
      setExpanded(true);
    }
  }, [counts]);

  const handleSave = async (
    key: string,
    status: ItemStatus,
    extra: { permitNumber?: string; note?: string },
  ) => {
    setSavingKey(key);
    try {
      const entry = await setComplianceItemProgress(job.id, key, status, extra);
      setReview((prev) =>
        prev ? { ...prev, item_progress: { ...prev.item_progress, [key]: entry } } : prev,
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this update.', 'error');
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) return null;
  if (!review && !eligible) return null;

  if (!review) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-4">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          {generating ? (
            <Loader2 size={16} className="animate-spin text-accent" />
          ) : (
            <ShieldCheck size={16} className="text-accent" />
          )}
          {generating
            ? 'Checking permits, codes and safety requirements…'
            : 'No permit & compliance review yet for this job.'}
        </div>
        {!generating && (
          <button
            type="button"
            onClick={() => run()}
            className="focus-ring flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            <ShieldCheck size={13} /> Run compliance check
          </button>
        )}
      </div>
    );
  }

  const likelihood = PERMIT_LIKELIHOOD_META[review.permit_likelihood];
  const c = counts ?? complianceCounts(review);
  const needsAttention = c.blockers > 0;
  const grouped = SEVERITY_ORDER.map((sev) => ({
    sev,
    items: review.requirements.filter((r) => r.severity === sev),
  })).filter((g) => g.items.length > 0);
  const j = review.jurisdiction;
  const lowConfidenceLocation = j.basis !== 'address';

  return (
    <div
      className={`rounded-xl border p-4 ${needsAttention ? 'border-danger/30 bg-danger/5' : 'border-accent/20 bg-accent/5'}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="focus-ring flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
          {needsAttention ? (
            <ShieldAlert size={16} className="shrink-0 text-danger" />
          ) : (
            <ShieldCheck size={16} className="shrink-0 text-accent" />
          )}
          <span className="truncate">Permit &amp; Compliance</span>
        </span>
        <span className="shrink-0 text-xs text-text-secondary">
          {expanded ? 'Hide' : 'Details'}
        </span>
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${likelihood.className}`}>
          {likelihood.label}
        </span>
        {c.blockers > 0 && (
          <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
            {c.blockers} to resolve before starting
          </span>
        )}
        {c.warnings > 0 && (
          <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs font-medium text-warning-500">
            {c.warnings} important
          </span>
        )}
        {c.blockers === 0 && c.warnings === 0 && (
          <span className="rounded-full bg-success-500/10 px-2 py-0.5 text-xs font-medium text-success-500">
            Nothing blocking
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
          <MapPin size={11} /> {j.label}
        </span>
      </div>

      {review.summary && <p className="mt-2 text-xs text-text-secondary">{review.summary}</p>}

      {expanded && (
        <div className="mt-3 space-y-4 border-t border-border/60 pt-3">
          {lowConfidenceLocation && (
            <div className="rounded-lg border border-warning-500/30 bg-warning-500/5 p-3">
              <p className="text-xs text-warning-500">
                <Info size={12} className="mr-1 inline" />
                We couldn't confirm the state from this job's address, so state-specific rules may
                be missing. Enter the job location (e.g. "Austin, TX 78701") to re-run.
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  value={jurisdictionInput}
                  onChange={(e) => setJurisdictionInput(e.target.value)}
                  maxLength={160}
                  aria-label="Job location override"
                  placeholder="City, ST 12345"
                  className="focus-ring min-w-0 flex-1 rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-secondary/60"
                />
                <button
                  type="button"
                  disabled={generating || !jurisdictionInput.trim()}
                  onClick={() =>
                    run({ force: true, jurisdictionOverride: jurisdictionInput.trim() })
                  }
                  className="focus-ring rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  Re-run
                </button>
              </div>
            </div>
          )}

          {review.ai_status === 'unavailable' && (
            <p className="text-xs text-text-secondary">
              <Info size={12} className="mr-1 inline" />
              AI analysis was unavailable — this review uses Vireek's built-in rule library only.
              Regenerate to retry.
            </p>
          )}

          {grouped.map(({ sev, items }) => (
            <div key={sev}>
              <p className="mb-1.5 text-xs font-medium text-text-secondary">
                {SEVERITY_META[sev].label}
              </p>
              <ul className="space-y-2">
                {items.map((item) => (
                  <ItemRow
                    key={item.key}
                    item={item}
                    review={review}
                    saving={savingKey === item.key}
                    onSave={handleSave}
                  />
                ))}
              </ul>
            </div>
          ))}

          {review.requirements.length === 0 && (
            <p className="text-xs text-text-secondary">
              No specific requirements were identified for this job.
            </p>
          )}

          {review.verify_questions.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-text-secondary">Worth confirming</p>
              <ul className="space-y-1">
                {review.verify_questions.map((q, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-sm text-text-primary">
                    <Info size={13} className="mt-0.5 shrink-0 text-text-secondary" /> {q}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-text-secondary">
            Decision support, not legal advice. Permit and code requirements are set by your local
            permitting authority — verify before starting work.
            {review.rules_version ? ` Rules v${review.rules_version}.` : ''}
          </p>

          <button
            type="button"
            onClick={() => run({ force: true })}
            disabled={generating}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            {generating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {generating ? 'Regenerating...' : 'Regenerate review'}
          </button>
        </div>
      )}
    </div>
  );
}
