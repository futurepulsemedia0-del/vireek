import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import type { Job } from '@/lib/supabase';
import type { RiskReport } from '@/lib/riskIntelligence';
import { assessJobsRisk } from '@/lib/dispatchIntelligenceApi';

/**
 * Risk Intelligence score for every job on a board, computed in one batch
 * (a fixed number of queries no matter how many jobs). Returns an empty map
 * while loading or if risk data is unavailable, so callers can render nothing.
 */
export function useJobRiskMap(jobs: Job[]): Record<string, RiskReport> {
  const { isOwner, profile, teamMember } = useAuth();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const [map, setMap] = useState<Record<string, RiskReport>>({});

  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  // Everything that can change a job's risk.
  const key = jobs
    .map((j) =>
      [j.id, j.job_status, j.assigned_technician_id ?? '', j.invoice_amount ?? '', j.scheduled_datetime ?? '', j.service_type ?? '', j.address ?? ''].join(':'),
    )
    .join('|');

  useEffect(() => {
    if (!ownerId || jobsRef.current.length === 0) {
      setMap({});
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      assessJobsRisk(jobsRef.current, ownerId)
        .then((r) => {
          if (!cancelled) setMap(r);
        })
        .catch(() => {
          if (!cancelled) setMap({});
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ownerId, key]);

  return map;
}
