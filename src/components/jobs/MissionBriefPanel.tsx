import { useCallback, useEffect, useState } from 'react';
import { Sparkles, RefreshCw, Loader2, Truck, AlertTriangle, CheckCircle2, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Job } from '@/lib/supabase';
import {
  fetchMissionBrief,
  generateMissionBrief,
  formatEstimatedValue,
  formatEstimatedDuration,
  formatConfidence,
  PART_NECESSITY_LABELS,
  WARRANTY_STATUS_META,
  MISSION_BRIEF_ELIGIBLE_STATUSES,
  type MissionBrief,
} from '@/lib/missionBrief';

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color = pct >= 65 ? 'bg-success-500' : pct >= 35 ? 'bg-warning-500' : 'bg-text-secondary';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-tertiary">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-text-secondary">{formatConfidence(confidence)} confidence</span>
    </div>
  );
}

export function MissionBriefPanel({ job }: { job: Job }) {
  const { toast } = useToast();
  const [brief, setBrief] = useState<MissionBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setBrief(await fetchMissionBrief(job.id));
    } catch {
      // panel just stays empty — not worth a toast on a background load
    } finally {
      setLoading(false);
    }
  }, [job.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const result = await generateMissionBrief(job.id);
      setBrief(result);
      setExpanded(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not generate the mission brief.', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const eligible = MISSION_BRIEF_ELIGIBLE_STATUSES.has(job.job_status);
  if (loading) return null;
  if (!brief && !eligible) return null;

  // No brief yet — a compact prompt to generate one.
  if (!brief) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-4">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Sparkles size={16} className="text-accent" />
          No mission brief yet for this job.
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating}
          className="focus-ring flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {generating ? 'Building brief...' : 'Generate mission brief'}
        </button>
      </div>
    );
  }

  const warranty = WARRANTY_STATUS_META[brief.warranty_status];

  return (
    <div className="rounded-xl border border-accent/20 bg-accent/5 p-4">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="focus-ring flex w-full items-center justify-between gap-2 text-left">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
          <Sparkles size={16} className="shrink-0 text-accent" />
          <span className="truncate">Mission Brief — {brief.predicted_issue}</span>
        </span>
        <span className="shrink-0 text-xs text-text-secondary">{expanded ? 'Hide' : 'Details'}</span>
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <ConfidenceBar confidence={brief.confidence} />
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${warranty.className}`}>
          {brief.warranty_status === 'active' ? <ShieldCheck size={11} /> : <ShieldAlert size={11} />}
          {warranty.label}
        </span>
        {brief.customer_previously_declined && (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning-500/10 px-2 py-0.5 text-xs font-medium text-warning-500">
            <AlertTriangle size={11} /> Previously declined
          </span>
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-4 border-t border-border/60 pt-3">
          {brief.reasoning && <p className="text-xs text-text-secondary">{brief.reasoning}</p>}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <p className="text-[11px] uppercase text-text-secondary">Last service</p>
              <p className="text-sm text-text-primary">
                {brief.last_service_days_ago !== null ? `${brief.last_service_days_ago} days ago` : 'No history'}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase text-text-secondary">Est. value</p>
              <p className="text-sm text-text-primary">{formatEstimatedValue(brief.estimated_value)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase text-text-secondary">Est. duration</p>
              <p className="text-sm text-text-primary">{formatEstimatedDuration(brief.estimated_duration_minutes)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase text-text-secondary">Model</p>
              <p className="text-sm text-text-primary">{brief.model ?? '—'}</p>
            </div>
          </div>

          {brief.last_service_summary && (
            <p className="text-xs text-text-secondary">
              <span className="font-medium text-text-primary">Last visit: </span>
              {brief.last_service_summary}
            </p>
          )}

          {brief.customer_decline_context && (
            <p className="text-xs text-warning-500">
              <AlertTriangle size={11} className="mr-1 inline" />
              {brief.customer_decline_context}
            </p>
          )}

          {brief.risk_flags.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-text-secondary">Risk flags</p>
              <ul className="space-y-1">
                {brief.risk_flags.map((flag, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-text-primary">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warning-500" /> {flag}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {brief.parts.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-text-secondary">Likely parts</p>
              <ul className="space-y-1.5">
                {brief.parts.map((part, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-sm text-text-primary">
                    <span>
                      {part.quantity > 1 ? `${part.quantity}× ` : ''}
                      {part.name}
                      <span className="ml-1.5 text-xs text-text-secondary">({PART_NECESSITY_LABELS[part.necessity]})</span>
                    </span>
                    {part.in_van_stock ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-success-500">
                        <Truck size={12} /> In van{part.stock_qty !== null ? ` (${part.stock_qty})` : ''}
                      </span>
                    ) : (
                      <span className="shrink-0 text-xs text-warning-500">Not in van stock</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {brief.before_leaving_checklist.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-text-secondary">Before leaving</p>
              <ul className="space-y-1">
                {brief.before_leaving_checklist.map((item, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-sm text-text-primary">
                    <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-text-secondary" /> {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {brief.on_arrival_checklist.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-text-secondary">When arriving</p>
              <ul className="space-y-1">
                {brief.on_arrival_checklist.map((item, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-sm text-text-primary">
                    <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-text-secondary" /> {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            {generating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {generating ? 'Regenerating...' : 'Regenerate brief'}
          </button>
        </div>
      )}
    </div>
  );
}
