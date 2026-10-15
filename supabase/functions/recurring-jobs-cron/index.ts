// recurring-jobs-cron
//
// Scheduled (hourly) worker for maintenance agreements:
//   1. generate_recurring_jobs()  — creates real jobs inside each agreement's
//      lead-time window (atomic, idempotent, double-booking aware; see the
//      migration for the rules).
//   2. processPendingInvoices()   — invoices completed visits for agreements
//      with auto-invoicing on.
//
// Deploy + secure (fails CLOSED: without the secret every call is rejected):
//   supabase functions deploy recurring-jobs-cron --no-verify-jwt
//   supabase secrets set RECURRING_JOBS_CRON_SECRET=<long-random-string>
// Then schedule it — see the snippet at the top of
// supabase/migrations/20270403000000_recurring_jobs.sql.
//
// Header: X-Cron-Secret: <RECURRING_JOBS_CRON_SECRET>

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { processPendingInvoices } from "../_shared/recurring-jobs/invoice.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const cronSecret = Deno.env.get("RECURRING_JOBS_CRON_SECRET");
  if (!cronSecret) return jsonResponse({ error: "Server misconfiguration: RECURRING_JOBS_CRON_SECRET is not set." }, 500);
  if (!timingSafeEqual(req.headers.get("X-Cron-Secret") ?? "", cronSecret)) return jsonResponse({ error: "Unauthorized." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Server misconfiguration." }, 500);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let generation: unknown = null;
  let invoicing: unknown = null;
  const errors: string[] = [];

  try {
    const { data, error } = await admin.rpc("generate_recurring_jobs");
    if (error) throw error;
    generation = data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`generation: ${message}`);
    console.error(JSON.stringify({ event: "recurring_generation_failed", error: message }));
  }

  // Invoicing is independent of generation — one failing must not block the other.
  try {
    invoicing = await processPendingInvoices(admin);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`invoicing: ${message}`);
    console.error(JSON.stringify({ event: "recurring_invoicing_failed", error: message }));
  }

  console.log(JSON.stringify({ event: "recurring_jobs_cron_complete", generation, invoicing, errors }));
  return jsonResponse({ generation, invoicing, errors }, errors.length > 0 && !generation && !invoicing ? 500 : 200);
});
