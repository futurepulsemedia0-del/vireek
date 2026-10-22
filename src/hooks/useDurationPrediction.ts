import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import type { DurationPrediction } from '@/lib/durationModel';
import { predictForDraft, type DurationSettings } from '@/lib/durationModelApi';

export interface DurationPredictionInput {
  jobId: string | null;
  serviceType: string | null;
  technicianId: string | null;
  customerId: string | null;
  /** jobs.expected_duration_minutes (explicit plan), if any */
  planMinutes: number | null;
  /** jobs.duration_minutes (the booked slot) */
  slotMinutes: number | null;
}

export interface UseDurationPrediction {
  prediction: DurationPrediction | null;
  settings: DurationSettings | null;
  loading: boolean;
  failed: boolean;
}

/**
 * Live duration prediction for one job / draft. Re-runs when the job type,
 * technician or customer changes (so picking a different technician in a form
 * updates the range). The model itself is cached per account for 5 minutes.
 */
export function useDurationPrediction(input: DurationPredictionInput | null): UseDurationPrediction {
  const { profile, teamMember, isOwner } = useAuth();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const [state, setState] = useState<UseDurationPrediction>({ prediction: null, settings: null, loading: false, failed: false });

  const key = useMemo(
    () => (input ? [input.jobId, input.serviceType, input.technicianId, input.customerId, input.planMinutes, input.slotMinutes].join('|') : ''),
    [input],
  );

  useEffect(() => {
    if (!ownerId || !input) {
      setState({ prediction: null, settings: null, loading: false, failed: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, failed: false }));
    predictForDraft(ownerId, input)
      .then(({ prediction, settings }) => {
        if (!cancelled) setState({ prediction, settings, loading: false, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ prediction: null, settings: null, loading: false, failed: true });
      });
    return () => {
      cancelled = true;
    };
    // `input` is intentionally keyed by its value via `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, key]);

  return state;
}
