// Required secrets (see docs/MICROSOFT_CALENDAR_SETUP.md):
//   supabase secrets set MICROSOFT_CALENDAR_CLIENT_ID=<Azure Application (client) ID>
//   supabase secrets set MICROSOFT_CALENDAR_CLIENT_SECRET=<Azure client secret VALUE>
//   supabase secrets set MICROSOFT_CALENDAR_STATE_SECRET=$(openssl rand -hex 32)
//   supabase secrets set MICROSOFT_CALENDAR_TENANT_ID=common      # optional: common | organizations | <tenant GUID>
// Azure -> App registration -> Authentication -> Web redirect URI:
//   https://<project-ref>.supabase.co/functions/v1/microsoft-calendar-oauth-callback
// Deploy: supabase functions deploy microsoft-calendar-oauth-start

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildAuthorizeUrl, normalizeTenant, signMsState, type ConnectionScope } from "../_shared/microsoft-calendar/engine.ts";
import { resolveActorFromJwt } from "../_shared/microsoft-calendar/actor.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization header." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const actor = await resolveActorFromJwt(admin, jwt);
    if (!actor) return json({ error: "Invalid or expired session." }, 401);

    const body = await req.json().catch(() => ({}));
    const scope: ConnectionScope = body?.scope === "technician" ? "technician" : "office";
    if (scope === "office" && !actor.canManage) return json({ error: "Only account owners and admins can connect the office calendar." }, 403);
    if (scope === "technician" && !actor.teamMemberId) return json({ error: "Only technicians on the team can connect a personal calendar." }, 403);

    const clientId = Deno.env.get("MICROSOFT_CALENDAR_CLIENT_ID");
    const stateSecret = Deno.env.get("MICROSOFT_CALENDAR_STATE_SECRET");
    if (!clientId || !stateSecret || !Deno.env.get("MICROSOFT_CALENDAR_CLIENT_SECRET")) {
      return json({ error: "Microsoft 365 isn't configured on this server yet." }, 500);
    }

    const url = buildAuthorizeUrl({
      clientId,
      tenant: normalizeTenant(Deno.env.get("MICROSOFT_CALENDAR_TENANT_ID")),
      redirectUri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/microsoft-calendar-oauth-callback`,
      state: await signMsState(actor.userId, scope, stateSecret),
    });
    return json({ url });
  } catch (error) {
    console.error(JSON.stringify({ event: "ms_calendar_oauth_start_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong starting the Microsoft 365 connection." }, 500);
  }
});
