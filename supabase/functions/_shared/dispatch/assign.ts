// Deno port of src/lib/dispatch.ts's suggestTechnicians() — same ranking,
// but this one WRITES the assignment instead of returning a list to click.
// Keep in sync with src/lib/dispatch.ts if the ranking logic changes.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildDispatchEvidence, recordAiDecision } from "../governance/aiDecisionRecorder.ts";

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

  const technicianId = result.technician_id ?? null;
  const technicianName = result.technician_name ?? null;
  const reason = result.reason ?? "Assigned by AI Dispatcher — best skill/service-area/capacity match.";

  // AI governance audit trail — must never block or fail a dispatch.
  if (technicianId) {
    try {
      const evidence = await buildDispatchEvidence(admin, userId, job, technicianId);
      await recordAiDecision(admin, {
        userId,
        decisionType: "dispatch",
        agentSource: "ai-dispatcher",
        engineKind: "rules",
        modelVersion: "assign_technician_to_job",
        title: `Assigned ${technicianName ?? "technician"} to ${job.service_type ?? "job"}`,
        decision: `Assign technician ${technicianName ?? technicianId} to job ${job.id}`,
        reasoning: reason,
        confidencePct: evidence.confidencePct,
        reasonFactors: evidence.reasonFactors,
        dataUsed: evidence.dataUsed,
        subjectTable: "jobs",
        subjectId: job.id,
        enforcement: "post_execution",
        executed: true,
      });
    } catch (e) {
      console.error(JSON.stringify({ event: "ai_governance_dispatch_record_failed", error: e instanceof Error ? e.message : String(e) }));
    }
  }

  return { technicianId, technicianName, reason };
