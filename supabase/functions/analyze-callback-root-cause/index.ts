// supabase/functions/analyze-callback-root-cause/index.ts
//
// On-demand (same shape as capacity-demand-insight/index.ts): runs AS the
// authenticated user, not service role. Loads ONE callback job + the
// original job it's paired with via jobs.rework_of_job_id (already
// detected server-side — nothing here re-detects or can spoof "is this a
// callback"), plus the technician, equipment and parts tied to both
// visits, hands that to the AI root-cause layer, and persists the result
// in callback_root_cause_analyses under RLS.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { analyzeCallbackRootCause } from "../_shared/ai-core/callbackRootCauseAnalysis.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: jsonHeaders });
    }

    let body: { callback_job_id?: string } = {};
    try {
      body = await req.json();
    } catch {
      // no body
    }
    const callbackJobId = body.callback_job_id;
    if (!callbackJobId) {
      return new Response(JSON.stringify({ error: "callback_job_id is required." }), { status: 400, headers: jsonHeaders });
    }

    const { data: callbackJob, error: cbErr } = await authClient
      .from("jobs")
      .select("id, service_type, technician_diagnosis, assigned_technician_id, is_rework, rework_of_job_id")
      .eq("id", callbackJobId)
      .maybeSingle();
    if (cbErr) throw cbErr;
    if (!callbackJob) {
      return new Response(JSON.stringify({ error: "Job not found." }), { status: 404, headers: jsonHeaders });
    }
    if (!callbackJob.is_rework || !callbackJob.rework_of_job_id) {
      return new Response(
        JSON.stringify({ error: "That job is not flagged as a callback (jobs.is_rework)." }),
        { status: 400, headers: jsonHeaders },
      );
    }

    const { data: originalJob, error: origErr } = await authClient
      .from("jobs")
      .select("id, service_type, technician_diagnosis, assigned_technician_id")
      .eq("id", callbackJob.rework_of_job_id)
      .maybeSingle();
    if (origErr) throw origErr;

    const technicianId: string | null = callbackJob.assigned_technician_id ?? null;
    let technicianName: string | null = null;
    if (technicianId) {
      const { data: tech } = await authClient
        .from("team_members")
        .select("member_name, member_email")
        .eq("id", technicianId)
        .maybeSingle();
      technicianName = tech?.member_name ?? tech?.member_email ?? null;
    }

    const { data: equipmentLinks } = await authClient
      .from("job_equipment")
      .select("equipment_id, equipment:equipment_id(id, equipment_type, make, model)")
      .eq("job_id", callbackJobId);
    const equipment = (equipmentLinks ?? []).map((r: Record<string, unknown>) => r.equipment).filter(Boolean) as
      { id: string; equipment_type: string; make: string | null; model: string | null }[];

    const { data: partsUsed } = await authClient
      .from("job_parts_required")
      .select("status, part:part_id(id, name, part_number, category)")
      .eq("job_id", callbackJob.rework_of_job_id)
      .eq("status", "installed");
    const originalParts = (partsUsed ?? []).map((r: Record<string, unknown>) => r.part).filter(Boolean) as
      { id: string; name: string | null; part_number: string | null; category: string | null }[];

    const result = await analyzeCallbackRootCause({
      callback_job: { service_type: callbackJob.service_type, diagnosis: callbackJob.technician_diagnosis },
      original_job: { service_type: originalJob?.service_type ?? null, diagnosis: originalJob?.technician_diagnosis ?? null },
      technician_name: technicianName,
      equipment: equipment.map((e) => ({ type: e.equipment_type, make: e.make, model: e.model })),
      parts_installed_on_original_visit: originalParts.map((p) => ({ name: p.name, part_number: p.part_number, category: p.category })),
    });

    if (!result) {
      return new Response(JSON.stringify({ error: "Analysis failed — could not produce a grounded root cause. Try again." }), {
        status: 502,
        headers: jsonHeaders,
      });
    }

    const payload = {
      user_id: user.id,
      callback_job_id: callbackJobId,
      original_job_id: callbackJob.rework_of_job_id,
      technician_id: technicianId,
      equipment_id: equipment[0]?.id ?? null,
      part_id: originalParts[0]?.id ?? null,
      service_type: callbackJob.service_type,
      root_cause_category: result.root_cause_category,
      confidence: result.confidence,
      ai_summary: result.ai_summary,
      recommended_prevention_action: result.recommended_prevention_action,
    };

    const { data: saved, error: saveErr } = await authClient
      .from("callback_root_cause_analyses")
      .upsert(payload, { onConflict: "callback_job_id" })
      .select()
      .single();
    if (saveErr) throw saveErr;

    return new Response(JSON.stringify({ analysis: saved }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
