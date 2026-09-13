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
  const { data: technicians } = await admin
    .from("team_members")
    .select("id, member_name, skills, service_area, max_jobs_per_day")
    .eq("account_owner_id", userId)
    .eq("role", "technician")
    .eq("invite_status", "active")
    .eq("dispatch_enabled", true);

  if (!technicians || technicians.length === 0) {
    return { technicianId: null, technicianName: null, reason: "No dispatch-enabled technicians on the team." };
  }

  const { data: activeJobs } = await admin
    .from("jobs")
    .select("assigned_technician_id, scheduled_datetime")
    .eq("user_id", userId)
    .not("assigned_technician_id", "is", null)
    .in("job_status", ["scheduled", "en_route", "in_progress"]);

  const loadByTech: Record<string, number> = {};
  for (const j of activeJobs ?? []) {
    if (!isSameDay(j.scheduled_datetime, job.scheduled_datetime)) continue;
    const techId = j.assigned_technician_id as string;
    loadByTech[techId] = (loadByTech[techId] ?? 0) + 1;
  }

  const scored = (technicians as TeamMemberRow[])
    .map((tech) => {
      const load = loadByTech[tech.id] ?? 0;
      const capacity = tech.max_jobs_per_day || 6;
      if (load >= capacity) return { tech, score: -1 };

      let score = (capacity - load) * 2;
      if (job.service_type && tech.skills.includes(job.service_type)) score += 10;
      if (tech.service_area && job.address && job.address.toLowerCase().includes(tech.service_area.toLowerCase())) score += 5;

      return { tech, score };
    })
    .filter((s) => s.score >= 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { technicianId: null, technicianName: null, reason: "Every technician is at capacity for that day." };
  }

  const best = scored[0].tech;
  await admin.from("jobs").update({ assigned_technician_id: best.id }).eq("id", job.id);

  return { technicianId: best.id, technicianName: best.member_name, reason: "Assigned by AI Dispatcher — best skill/service-area/capacity match." };
}
