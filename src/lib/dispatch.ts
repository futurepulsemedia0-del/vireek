import type { Job, TeamMember } from '@/lib/supabase';
import { stockFitBonus, stockFitReason, type StockFitRow } from '@/lib/truckStock';

export interface DispatchSuggestion {
  technician: TeamMember;
  score: number;
  reasons: string[];
}

function isSameDay(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * Ranks available technicians for a job by skill match, service-area match,
 * and today's remaining capacity. Pure client-side heuristic — good enough
 * to run from the dashboard today, and the same shape you'd port into an
 * edge function later so Sarah can call it live during a booking call.
 */
export function suggestTechnicians(
  job: Job,
  technicians: TeamMember[],
  jobsByTechnician: Record<string, Job[]>,
  stockFit: Record<string, StockFitRow> = {}
): DispatchSuggestion[] {
  const candidates = technicians.filter((t) => t.role === 'technician' && t.dispatch_enabled);

  return candidates
    .map((tech) => {
      const reasons: string[] = [];
      const todaysJobs = (jobsByTechnician[tech.id] ?? []).filter((j) =>
        isSameDay(j.scheduled_datetime, job.scheduled_datetime)
      );
      const load = todaysJobs.length;
      const capacity = tech.max_jobs_per_day || 6;

      if (load >= capacity) {
        return { technician: tech, score: -1, reasons: [`At capacity (${load}/${capacity} jobs today)`] };
      }

      let score = (capacity - load) * 2;
      reasons.push(`${load}/${capacity} jobs today`);

      if (job.service_type && tech.skills.includes(job.service_type)) {
        score += 10;
        reasons.push(`Skilled in ${job.service_type}`);
      } else if (job.service_type) {
        reasons.push(`No listed skill match for ${job.service_type}`);
      }

      if (tech.service_area && job.address && job.address.toLowerCase().includes(tech.service_area.toLowerCase())) {
        score += 5;
        reasons.push(`Covers ${tech.service_area}`);
      }
      const fit = stockFit[tech.id];
      score += stockFitBonus(fit);
      const stockReason = stockFitReason(fit);
      if (stockReason) reasons.push(stockReason);
      return { technician: tech, score, reasons };
    })
    .filter((s) => s.score >= 0)
    .sort((a, b) => b.score - a.score);
}
