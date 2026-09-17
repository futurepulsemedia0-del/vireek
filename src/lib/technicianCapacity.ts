export type CapacityOutcome = 'assigned' | 'at_capacity' | 'no_technician_available' | 'not_found';

export interface AssignTechnicianResult {
  status: CapacityOutcome;
  technician_id?: string;
  technician_name?: string | null;
  day_load?: number;
  capacity?: number;
  reason?: string;
}

export interface TechnicianCapacityEvent {
  id: string;
  job_id: string | null;
  technician_id: string | null;
  technician_name: string | null;
  outcome: CapacityOutcome;
  day_load: number | null;
  capacity: number | null;
  created_at: string;
}

export const OUTCOME_LABELS: Record<CapacityOutcome, string> = {
  assigned: 'Assigned',
  at_capacity: 'Blocked — at capacity',
  no_technician_available: 'No technician available',
  not_found: 'Not found',
};

/** Toast copy for an assignment attempt's result — same message whichever page triggered it. */
export function describeAssignResult(result: AssignTechnicianResult): { message: string; ok: boolean } {
  switch (result.status) {
    case 'assigned':
      return { message: `Assigned to ${result.technician_name ?? 'technician'}.`, ok: true };
    case 'at_capacity':
      return { message: result.reason || 'That technician is already at capacity for that day.', ok: false };
    case 'no_technician_available':
      return { message: result.reason || 'No technician is available for that day.', ok: false };
    default:
      return { message: 'Could not assign this job.', ok: false };
  }
}
