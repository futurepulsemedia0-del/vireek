// supabase/functions/_shared/auth/integrationAccessGuard.ts
//
// Deno wrapper for checkIntegrationAccess: builds a client that acts AS THE CALLER (anon key + their JWT) so that
// get_account_owner_id() / can_manage_integrations() evaluate auth.uid() correctly. Returns the access result or a
// ready-to-return Response (401/403) carrying the caller's CORS headers.
//
// Requires migration 20290304000000_integrations_permission_and_st_flag.sql (defines can_manage_integrations).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { checkIntegrationAccess, type CallerClient } from "./integrationAccess.ts";

export async function requireIntegrationManager(
  req: Request,
  label: string,
  corsHeaders: Record<string, string>,
  verb: "connect" | "disconnect" = "connect",
): Promise<{ userId: string; ownerId: string } | Response> {
  const respond = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return respond(401, "Missing Authorization header.");

  const caller = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const access = await checkIntegrationAccess(caller as unknown as CallerClient, label, verb);
  if (!access.ok) return respond(access.status, access.error);
  return { userId: access.userId, ownerId: access.ownerId };
}
