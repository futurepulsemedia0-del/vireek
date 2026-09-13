import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { assignBestTechnician } from "../_shared/dispatch/assign.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);
  const userId = userData.user.id;

  const { data: unassigned, error } = await admin
    .from("jobs")
    .select("id, service_type, address, scheduled_datetime")
    .eq("user_id", userId)
    .in("job_status", ["scheduled", "en_route", "in_progress"])
    .is("assigned_technician_id", null);

  if (error) return jsonResponse({ error: error.message }, 500);

  const results = [];
  for (const job of unassigned ?? []) {
    const result = await assignBestTechnician(admin, userId, job);
    results.push({ job_id: job.id, ...result });
  }

  return jsonResponse({ assigned: results.filter((r) => r.technicianId).length, total: results.length, results });
});
