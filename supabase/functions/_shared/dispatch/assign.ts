// Deno port of src/lib/dispatch.ts's suggestTechnicians() — same ranking,
// but this one WRITES the assignment instead of returning a list to click.
// Keep in sync with src/lib/dispatch.ts if the ranking logic changes.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

interface TeamMemberRow {
  id: string;
  member_name: string | null;
  skills: string[];
  service_area: string | null;
  max_jobs_per_day: number;
}

interface JobRow {
  id: string;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
}

function isSameDay(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export interface AssignResult {
  technicianId: string | null;
  technicianName: string | null;
  reason: string;
}

export async function assignBestTechnician(admin: SupabaseClient, userId: string, job: JobRow): Promise<AssignResult> {
  const { data, error } = await admin.rpc("assign_technician_to_job", { p_job_id: job.id, p_technician_id: null });

  if (error) {
    return { technicianId: null, technicianName: null, reason: error.message };
  }

  const result = data as { status: string; technician_id?: string; technician_name?: string | null; reason?: string };

  if (result.status !== "assigned") {
    return { technicianId: null, technicianName: null, reason: result.reason ?? "No technician available." };
  }

  return {
    technicianId: result.technician_id ?? null,
    technicianName: result.technician_name ?? null,
    reason: result.reason ?? "Assigned by AI Dispatcher — best skill/service-area/capacity match.",
  };
}
