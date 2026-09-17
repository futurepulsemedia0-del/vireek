import { useMemo } from 'react';
import { RotateCcw, Info } from 'lucide-react';
import type { Job, TeamMember } from '@/lib/supabase';

interface ReworkIntelligenceProps {
  jobs: Job[];
  technicians: TeamMember[];
}

interface LeaderboardRow {
  key: string;
  label: string;
  reworkedCount: number;
  completedCount: number;
  ratePct: number;
}

// Any technician/service-type with fewer completed jobs than this is left
// out of the leaderboard — a 1-of-1 "100% rework rate" is noise, not signal.
const MIN_COMPLETED_SAMPLE = 3;
const MAX_ROWS = 5;

function buildLeaderboard(
  completedJobs: Job[],
  reworkedOriginalIds: Set<string>,
  keyOf: (job: Job) => string | null,
  labelOf: (key: string) => string,
): LeaderboardRow[] {
  const totals = new Map<string, number>();
  const reworked = new Map<string, number>();

  for (const job of completedJobs) {
    const key = keyOf(job);
    if (!key) continue;
    totals.set(key, (totals.get(key) ?? 0) + 1);
    if (reworkedOriginalIds.has(job.id)) {
      reworked.set(key, (reworked.get(key) ?? 0) + 1);
    }
  }

  return Array.from(totals.entries())
    .filter(([, completedCount]) => completedCount >= MIN_COMPLETED_SAMPLE)
    .map(([key, completedCount]) => {
      const reworkedCount = reworked.get(key) ?? 0;
      return {
        key,
        label: labelOf(key),
        reworkedCount,
        completedCount,
        ratePct: Math.round((reworkedCount / completedCount) * 100),
      };
    })
    .filter((row) => row.reworkedCount > 0)
    .sort((a, b) => b.reworkedCount - a.reworkedCount || b.ratePct - a.ratePct)
    .slice(0, MAX_ROWS);
}

/**
 * Built entirely from `jobs.is_rework` / `jobs.rework_of_job_id`, which are
 * set server-side by the trg_set_job_rework_flag trigger the moment a new
 * job is inserted for a customer + service_type that had a completed job
 * (still under its warranty window, or within the last 45 days) — see
 * 20260923000000_rework_intelligence.sql. This component does no rework
 * detection itself; it only aggregates what the trigger already decided.
 *
 * Deliberately built from the FULL job history, not the page's date-range
 * filter — like CohortLtvSection, a technician's repeat-visit rate is a
 * reputation metric, not something that should reset every time someone
 * picks "Last 7 days".
 */
export function ReworkIntelligence({ jobs, technicians }: ReworkIntelligenceProps) {
  const data = useMemo(() => {
    const completedJobs = jobs.filter((j) => j.job_status === 'completed');
    const reworkJobs = jobs.filter((j) => Boolean(j.is_rework));
    const reworkedOriginalIds = new Set(
      reworkJobs.map((j) => j.rework_of_job_id as string | null).filter((id): id is string => Boolean(id)),
    );

    const techName = (id: string) => {
      const t = technicians.find((t) => t.id === id);
      return t?.member_name || t?.member_email || 'Unnamed technician';
    };

    const byServiceType = buildLeaderboard(
      completedJobs,
      reworkedOriginalIds,
      (j) => (j.service_type ? j.service_type : null),
      (key) => key,
    );

    const byTechnician = buildLeaderboard(
      completedJobs,
      reworkedOriginalIds,
      (j) => (j.assigned_technician_id ? j.assigned_technician_id : null),
      (key) => techName(key),
    );

    return {
      totalCompleted: completedJobs.length,
      totalReworks: reworkJobs.length,
      overallRatePct: completedJobs.length > 0 ? Math.round((reworkJobs.length / completedJobs.length) * 100) : 0,
      byServiceType,
      byTechnician,
    };
  }, [jobs, technicians]);

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning-500/10 text-warning-500">
          <RotateCcw size={18} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Rework Intelligence</h3>
          <p className="text-xs text-text-secondary">Jobs that came back — by service type and technician, all-time</p>
        </div>
        {data.totalCompleted > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-warning-500/10 px-2.5 py-1 text-xs font-semibold text-warning-500">
            {data.overallRatePct}% return rate
          </span>
        )}
      </div>

      {data.totalCompleted === 0 ? (
        <p className="mt-6 text-sm text-text-secondary">No completed jobs yet.</p>
      ) : data.totalReworks === 0 ? (
        <p className="mt-6 text-sm text-text-secondary">
          No repeat visits detected in your job history yet — every completed job has stayed fixed.
        </p>
      ) : (
        <div className="mt-5 grid gap-6 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-medium text-text-secondary">Top service types</p>
            {data.byServiceType.length === 0 ? (
              <p className="text-xs text-text-secondary/70">Not enough completed jobs per service type yet.</p>
            ) : (
              <div className="space-y-2">
                {data.byServiceType.map((row) => (
                  <div key={row.key} className="flex items-center justify-between gap-3 rounded-xl bg-bg-primary px-3 py-2">
                    <span className="truncate text-sm text-text-primary">{row.label}</span>
                    <span className="shrink-0 text-xs font-medium text-text-secondary">
                      {row.reworkedCount}/{row.completedCount} · {row.ratePct}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-text-secondary">Top technicians</p>
            {data.byTechnician.length === 0 ? (
              <p className="text-xs text-text-secondary/70">Not enough completed jobs per technician yet.</p>
            ) : (
              <div className="space-y-2">
                {data.byTechnician.map((row) => (
                  <div key={row.key} className="flex items-center justify-between gap-3 rounded-xl bg-bg-primary px-3 py-2">
                    <span className="truncate text-sm text-text-primary">{row.label}</span>
                    <span className="shrink-0 text-xs font-medium text-text-secondary">
                      {row.reworkedCount}/{row.completedCount} · {row.ratePct}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {data.totalReworks > 0 && (
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-dashed border-border p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
          <p className="text-xs leading-relaxed text-text-secondary">
            A job is flagged as a rework automatically when a new job is booked for the same customer and service
            type while an earlier completed job is still within its warranty window or the last 45 days.
          </p>
        </div>
      )}
    </div>
  );
}
