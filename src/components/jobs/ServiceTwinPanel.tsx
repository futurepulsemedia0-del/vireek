import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, CheckCircle2, Eye, Loader2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import type { Job } from '@/lib/supabase';
import {
  INTERVENTION_LABELS,
  SOURCE_LABELS,
  TWIN_STATUS_META,
  formatCents,
  formatMinutes,
  formatOverrun,
  formatPct,
  setInterventionStatus,
  useServiceTwin,
  type ServiceTwin,
  type TwinStatus,
} from '@/lib/serviceTwin';

const TONE_BOX: Record<'success' | 'warning' | 'danger', string> = {
  success: 'border-success-500/30 bg-success-500/5',
  warning: 'border-warning-500/30 bg-warning-500/5',
  danger: 'border-danger/30 bg-danger/5',
};
const TONE_TEXT: Record<'success' | 'warning' | 'danger', string> = {
  success: 'text-success-500',
  warning: 'text-warning-500',
  danger: 'text-danger',
};

/** One Expected-vs-Actual row with a burn bar (100% = plan). */
export function TwinMetricRow({
  label,
  expected,
  actual,
  ratio,
  worseWhenLower = false,
}: {
  label: string;
  expected: string;
  actual: string;
  ratio: number;
  worseWhenLower?: boolean;
}) {
  const bad = worseWhenLower ? ratio < 0.88 : ratio > 1.1;
  const critical = worseWhenLower ? ratio < 0.65 : ratio > 1.25;
  const fill = Math.min(Math.max(ratio, 0), 1.6) / 1.6;
  const barColor = critical ? 'bg-danger' : bad ? 'bg-warning-500' : 'bg-success-500';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-text-secondary">{label}</span>
        <span className="text-text-primary">
          <span className="text-text-secondary">{expected} plan · </span>
          <span className="font-semibold">{actual}</span>
        </span>
      </div>
      <div
        className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-bg-tertiary"
        role="img"
        aria-label={`${label}: ${actual} against a plan of ${expected}`}
      >
        <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${fill * 100}%` }} />
        <span className="absolute inset-y-0 w-px bg-text-secondary/60" style={{ left: `${(1 / 1.6) * 100}%` }} aria-hidden="true" />
      </div>
    </div>
  );
}

export function TwinStatusBadge({ status }: { status: TwinStatus }) {
  const meta = TWIN_STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE_BOX[meta.tone]} ${TONE_TEXT[meta.tone]}`}>
      {status === 'on_plan' ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
      {meta.label}
    </span>
  );
}

export function TwinMetrics({ twin }: { twin: ServiceTwin }) {
  const live = twin.phase === 'live' || twin.phase === 'closed';
  const v = twin.variance;
  return (
    <div className="space-y-3">
      <TwinMetricRow
        label="Time"
        expected={formatMinutes(twin.expected.duration_minutes)}
        actual={live ? `${formatMinutes(twin.actual.elapsed_minutes)} · projected ${formatMinutes(twin.projected.duration_minutes)} (${formatOverrun(v.time_ratio)})` : 'not started'}
        ratio={live ? v.time_ratio : 0}
      />
      <TwinMetricRow
        label="Cost"
        expected={formatCents(twin.expected.cost_cents)}
        actual={live ? `${formatCents(twin.actual.cost_cents)} · projected ${formatCents(twin.projected.cost_cents)} (${formatOverrun(v.cost_ratio)})` : 'not started'}
        ratio={live ? v.cost_ratio : 0}
      />
      <TwinMetricRow
        label="First-time fix"
        expected={formatPct(twin.expected.ftf_pct)}
        actual={live ? `${formatPct(twin.projected.ftf_pct)} probability` : 'not started'}
        ratio={live ? twin.projected.ftf_pct / Math.max(twin.expected.ftf_pct, 1) : 1}
        worseWhenLower
      />
    </div>
  );
}

export function ServiceTwinPanel({ job }: { job: Job }) {
  const active = job.job_status === 'en_route' || job.job_status === 'in_progress' || job.job_status === 'completed';
  const { twin, interventions, loading, error, reload } = useServiceTwin(job.id, active);
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!active) return null;
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-4 text-xs text-text-secondary">
        <Loader2 size={13} className="animate-spin" /> Loading Service Twin…
      </div>
    );
  }
  if (error || !twin) return null; // never block the job page on the twin

  const meta = TWIN_STATUS_META[twin.status];
  const acknowledge = async (id: string) => {
    setBusyId(id);
    try {
      await setInterventionStatus(id, 'acknowledged');
      await reload();
    } catch {
      toast('Could not acknowledge this alert.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={`rounded-xl border p-4 ${TONE_BOX[twin.phase === 'live' ? meta.tone : 'success']}`} aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Activity size={16} className={TONE_TEXT[twin.phase === 'live' ? meta.tone : 'success']} />
          Service Twin
        </span>
        {twin.phase === 'live' ? (
          <TwinStatusBadge status={twin.status} />
        ) : (
          <span className="text-[11px] font-medium uppercase text-text-secondary">{twin.phase === 'closed' ? 'Final' : 'Waiting to start'}</span>
        )}
      </div>

      <div className="mt-3">
        <TwinMetrics twin={twin} />
      </div>

      {twin.phase === 'live' && twin.ftf_drivers.length > 0 && (
        <p className="mt-3 text-[11px] text-text-secondary">
          FTF drivers: {twin.ftf_drivers.map((d) => `${d.driver} (${d.points})`).join(' · ')}
        </p>
      )}

      {interventions.length > 0 && (
        <ul className="mt-3 space-y-2">
          {interventions.map((iv) => (
            <li key={iv.id} className="rounded-lg border border-border bg-bg-secondary p-3">
              <p className="flex items-start gap-1.5 text-xs font-semibold text-text-primary">
                <AlertTriangle size={12} className={`mt-0.5 shrink-0 ${iv.severity === 'critical' ? 'text-danger' : 'text-warning-500'}`} />
                {INTERVENTION_LABELS[iv.kind]} — {iv.headline}
              </p>
              <p className="mt-1 text-xs text-text-secondary">{iv.recommended_action}</p>
              {iv.status === 'open' ? (
                <button
                  type="button"
                  onClick={() => acknowledge(iv.id)}
                  disabled={busyId === iv.id}
                  className="focus-ring mt-2 flex items-center gap-1 text-[11px] font-medium text-accent hover:underline disabled:opacity-50"
                >
                  {busyId === iv.id ? <Loader2 size={11} className="animate-spin" /> : <Eye size={11} />} I'm on it
                </button>
              ) : (
                <p className="mt-2 text-[11px] text-text-secondary">Acknowledged — still monitoring.</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 flex items-center justify-between gap-2 text-[11px] text-text-secondary">
        <span>
          Plan from {SOURCE_LABELS[twin.baseline.duration_source] ?? twin.baseline.duration_source}; FTF target from{' '}
          {SOURCE_LABELS[twin.baseline.ftf_source] ?? twin.baseline.ftf_source}.
        </span>
        <Link to={`/dashboard/service-twin?job=${job.id}`} className="focus-ring shrink-0 text-accent hover:underline">
          All live twins →
        </Link>
      </p>
    </div>
  );
}
