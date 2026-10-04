import { useEffect, useState } from 'react';
import { Satellite } from 'lucide-react';
import type { Job } from '@/lib/supabase';
import { FLAG_LABELS, fetchJobVisit, type JobVisit } from '@/lib/telematics';

type Truth = Awaited<ReturnType<typeof fetchJobVisit>>['truth'];

/** Read-only proof panel on a job: GPS-verified arrival/departure and the operational-integrity score. Renders nothing when the job has no telematics data. */
export function JobTelematicsPanel({ job }: { job: Job }) {
  const [visit, setVisit] = useState<JobVisit | null>(null);
  const [truth, setTruth] = useState<Truth>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    fetchJobVisit(job.id)
      .then((r) => { if (!cancelled) { setVisit(r.visit); setTruth(r.truth); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [job.id]);

  if (!loaded || !visit) return null;

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—');
  const late = visit.minutes_late;

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Satellite size={14} className="text-accent" /> Vehicle GPS proof</h4>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <div><dt className="text-text-secondary">Arrived</dt><dd className="font-medium text-text-primary">{fmt(visit.arrived_at)}</dd></div>
        <div><dt className="text-text-secondary">Departed</dt><dd className="font-medium text-text-primary">{visit.departed_at ? fmt(visit.departed_at) : 'On site'}</dd></div>
        <div><dt className="text-text-secondary">On-time</dt><dd className={`font-medium ${late != null && late > 10 ? 'text-warning-500' : 'text-text-primary'}`}>{late == null ? '—' : late <= 0 ? 'Early' : `${late} min late`}</dd></div>
        <div><dt className="text-text-secondary">On site</dt><dd className="font-medium text-text-primary">{visit.onsite_seconds != null ? `${Math.round(visit.onsite_seconds / 60)} min` : '—'}</dd></div>
      </dl>
      {truth && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="text-xs text-text-secondary">Integrity</span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${truth.integrity_score >= 80 ? 'bg-success-500/10 text-success-500' : truth.integrity_score >= 60 ? 'bg-warning-500/10 text-warning-500' : 'bg-danger-500/10 text-danger-500'}`}>{Math.round(truth.integrity_score)}/100</span>
          {truth.flags.map((f) => <span key={f} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">{FLAG_LABELS[f] ?? f}</span>)}
        </div>
      )}
    </div>
  );
}
