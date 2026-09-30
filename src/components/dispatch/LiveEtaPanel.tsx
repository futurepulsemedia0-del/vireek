import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigation } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import type { Job, TeamMember } from '@/lib/supabase';
import { minutesRemaining, setJobEta } from '@/lib/liveTracking';
import { isValidPoint, liveEtaMinutes, type GeoPoint } from '@/lib/dispatchIntelligence';

interface Row {
  job: Job;
  technicianName: string;
  eta: { minutes: number; miles: number; ageMin: number } | null;
  /** Minutes the customer currently sees, null if none was set. */
  shown: number | null;
  positionAgeMin: number | null;
}

function freshestPosition(job: Job, tech: TeamMember | undefined): { point: GeoPoint; at: string } | null {
  const candidates: { point: GeoPoint; at: string }[] = [];
  if (job.technician_lat != null && job.technician_lng != null && job.location_updated_at) {
    candidates.push({ point: { lat: Number(job.technician_lat), lng: Number(job.technician_lng) }, at: job.location_updated_at });
  }
  if (tech && tech.current_latitude != null && tech.current_longitude != null && tech.location_updated_at) {
    candidates.push({ point: { lat: Number(tech.current_latitude), lng: Number(tech.current_longitude) }, at: tech.location_updated_at });
  }
  const valid = candidates.filter((c) => isValidPoint(c.point) && !Number.isNaN(Date.parse(c.at)));
  valid.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return valid[0] ?? null;
}

export function LiveEtaPanel({ jobs, technicians, onChanged }: { jobs: Job[]; technicians: TeamMember[]; onChanged: () => void | Promise<void> }) {
  const { toast } = useToast();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [auto, setAuto] = useState(false);
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const rows: Row[] = useMemo(() => {
    const byId = new Map(technicians.map((t) => [t.id, t]));
    return jobs
      .filter((j) => j.job_status === 'en_route')
      .map((job) => {
        const tech = job.assigned_technician_id ? byId.get(job.assigned_technician_id) : undefined;
        const pos = freshestPosition(job, tech);
        const dest: GeoPoint | null = job.latitude != null && job.longitude != null ? { lat: Number(job.latitude), lng: Number(job.longitude) } : null;
        const eta = pos ? liveEtaMinutes(pos.point, dest, pos.at, nowMs) : null;
        return {
          job,
          technicianName: tech?.member_name ?? tech?.member_email ?? 'Technician',
          eta,
          shown: minutesRemaining(job.eta_minutes, job.eta_set_at),
          positionAgeMin: pos ? Math.max(0, Math.round((nowMs - Date.parse(pos.at)) / 60000)) : null,
        };
      });
  }, [jobs, technicians, nowMs]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const send = useCallback(
    async (row: Row, silent: boolean) => {
      if (!row.eta) return;
      setSending(row.job.id);
      const ok = await setJobEta(row.job.id, row.eta.minutes);
      setSending(null);
      if (!ok) {
        if (!silent) toast('Could not update the ETA.', 'error');
        return;
      }
      if (!silent) toast(`Customer now sees an ETA of ${row.eta.minutes} min.`, 'success');
      await onChanged();
    },
    [onChanged, toast],
  );

  // Auto mode: refresh the customer-facing ETA every minute, but only when it drifted by 2+ minutes.
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      for (const r of rowsRef.current) {
        if (r.eta && (r.shown === null || Math.abs(r.shown - r.eta.minutes) >= 2)) void send(r, true);
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [auto, send]);

  if (rows.length === 0) return null;

  return (
    <div className="mt-4 rounded-xl border border-border bg-bg-primary p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
          <Navigation size={14} className="text-accent" /> Live ETA — technicians on the way
        </h3>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-secondary">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="h-3.5 w-3.5 rounded border-border accent-accent" />
          Auto-update customer ETA
        </label>
      </div>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li key={r.job.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2 text-xs">
            <div>
              <p className="font-medium text-text-primary">
                {r.job.customer_name} <span className="font-normal text-text-secondary">· {r.technicianName}</span>
              </p>
              <p className="mt-0.5 text-text-secondary">
                {r.eta
                  ? `~${r.eta.minutes} min · ${r.eta.miles} mi away · GPS ${Math.round(r.eta.ageMin)} min old`
                  : r.job.latitude == null
                    ? 'Job location not geocoded yet'
                    : r.positionAgeMin === null
                      ? 'No GPS position from the technician yet'
                      : `GPS is stale (${r.positionAgeMin} min old)`}
                {r.shown !== null ? ` · customer sees ${r.shown} min` : ''}
              </p>
            </div>
            <button
              type="button"
              disabled={!r.eta || sending === r.job.id}
              onClick={() => void send(r, false)}
              className="focus-ring rounded-lg bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {sending === r.job.id ? 'Sending…' : 'Send ETA to customer'}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-text-secondary">Estimated from straight-line distance and average speed; refined ETAs use the technician&apos;s own updates.</p>
    </div>
  );
}
