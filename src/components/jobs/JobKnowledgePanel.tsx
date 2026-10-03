import { useEffect, useMemo, useState } from 'react';
import { Brain, Check, ChevronDown, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import type { Job } from '@/lib/supabase';
import {
  CONFIDENCE_TIER_STYLES,
  confidenceTier,
  equipmentLabel,
  outcomeRate,
} from '@/lib/knowledgeCapture';
import {
  recordApplication,
  searchDeployedRules,
  type DeployedRuleHit,
} from '@/lib/knowledgeCaptureApi';

/**
 * Field panel on a job: surfaces live tribal rules relevant to this job and closes the loop —
 * the technician marks whether a rule fixed the problem, which moves its confidence.
 * Renders nothing when there are no relevant rules (or the engine isn't set up), so it never
 * adds noise to the job view.
 */
export function JobKnowledgePanel({ job }: { job: Job }) {
  const { toast } = useToast();
  const [hits, setHits] = useState<DeployedRuleHit[]>([]);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<Record<string, 'resolved' | 'not_resolved'>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const query = useMemo(() => {
    const text = [job.service_type, job.technician_diagnosis, job.notes, job.work_performed_notes]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .join(' ');
    return text.slice(0, 600);
  }, [job.service_type, job.technician_diagnosis, job.notes, job.work_performed_notes]);

  useEffect(() => {
    let cancelled = false;
    if (query.trim().length < 3) {
      setHits([]);
      return;
    }
    searchDeployedRules(query, undefined, undefined, 4)
      .then((r) => {
        if (!cancelled) setHits(r.filter((h) => h.relevance >= 0.3));
      })
      .catch(() => {
        if (!cancelled) setHits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  if (hits.length === 0) return null;

  const mark = async (rule: DeployedRuleHit, outcome: 'resolved' | 'not_resolved') => {
    setBusy(rule.id);
    try {
      await recordApplication(rule.id, job.id, outcome);
      setDone((d) => ({ ...d, [rule.id]: outcome }));
      toast('Thanks — this helps keep the rule accurate.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not record that.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-accent/25 bg-accent/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center justify-between gap-2 rounded-xl px-4 py-3 text-left text-sm font-semibold text-text-primary"
      >
        <span className="flex items-center gap-2">
          <Brain size={15} className="text-accent" aria-hidden="true" /> Team knowledge for this job
          ({hits.length})
        </span>
        <ChevronDown
          size={14}
          className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ul className="space-y-3 px-4 pb-4">
          {hits.map((h) => {
            const tier = confidenceTier(h.confidence_score);
            const rate = outcomeRate(h);
            return (
              <li key={h.id} className="rounded-lg bg-bg-primary p-3 text-xs">
                <p className="font-semibold text-text-primary">{h.title}</p>
                <p className="mt-0.5 text-text-secondary">
                  {equipmentLabel(h)} ·{' '}
                  <span className={CONFIDENCE_TIER_STYLES[tier]}>
                    {h.confidence_score}% confidence
                  </span>
                  {rate !== null ? ` · fixed it ${rate}% of the time` : ''}
                </p>
                <p className="mt-2 text-text-primary">
                  <span className="font-semibold">Usually:</span> {h.likely_cause}
                </p>
                <p className="mt-1 text-text-primary">
                  <span className="font-semibold">Do this:</span> {h.recommended_action}
                </p>
                {h.caveats && <p className="mt-1 text-warning-500">⚠ {h.caveats}</p>}
                {h.needs_revalidation && (
                  <p className="mt-1 text-text-secondary">
                    This rule has been failing recently — treat with caution.
                  </p>
                )}
                <div className="mt-3 flex items-center gap-2">
                  {done[h.id] ? (
                    <span className="text-text-secondary">
                      Recorded:{' '}
                      {done[h.id] === 'resolved' ? 'it fixed the problem' : "it didn't fix it"}
                    </span>
                  ) : (
                    <>
                      <span className="text-text-secondary">Did it fix it?</span>
                      <button
                        type="button"
                        disabled={busy === h.id}
                        onClick={() => mark(h, 'resolved')}
                        className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 font-medium text-text-primary hover:border-success-500/50 disabled:opacity-50"
                      >
                        <Check size={12} aria-hidden="true" /> Yes
                      </button>
                      <button
                        type="button"
                        disabled={busy === h.id}
                        onClick={() => mark(h, 'not_resolved')}
                        className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 font-medium text-text-primary hover:border-danger/50 disabled:opacity-50"
                      >
                        <X size={12} aria-hidden="true" /> No
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
