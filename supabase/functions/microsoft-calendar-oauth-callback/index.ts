// Deploy: supabase functions deploy microsoft-calendar-oauth-callback --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { mapOAuthError, normalizeTenant, verifyMsState } from "../_shared/microsoft-calendar/engine.ts";
import { resolveActorById } from "../_shared/microsoft-calendar/actor.ts";
import { exchangeCode, graphRequest } from "../_shared/microsoft-calendar/graph.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const redirectTo = (params: Record<string, string>) => {
    const dest = new URL(`${siteUrl}/dashboard/integrations`);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
    return Response.redirect(dest.toString(), 302);
  };
  const fail = (reason: string) => redirectTo({ microsoft_calendar: "error", reason });

  const stateSecret = Deno.env.get("MICROSOFT_CALENDAR_STATE_SECRET") ?? "";
  const providerError = url.searchParams.get("error");
  if (providerError) return fail(mapOAuthError(providerError, url.searchParams.get("error_description")));

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return fail("missing_code_or_state");
  const verified = await verifyMsState(state, stateSecret);
  if (!verified) return fail("invalid_state");

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    // Re-authorize here too: the state only proves who started the flow, not that they still may.
    const actor = await resolveActorById(admin, verified.userId);
    if (!actor) return fail("not_authorized");
    const isOffice = verified.scope === "office";
    if (isOffice ? !actor.canManage : !actor.teamMemberId) return fail("not_authorized");

    const cfg = {
      tenant: normalizeTenant(Deno.env.get("MICROSOFT_CALENDAR_TENANT_ID")),
      clientId: Deno.env.get("MICROSOFT_CALENDAR_CLIENT_ID") ?? "",
      clientSecret: Deno.env.get("MICROSOFT_CALENDAR_CLIENT_SECRET") ?? "",
    };
    const tokens = await exchangeCode(cfg, code, `${Deno.env.get("SUPABASE_URL")}/functions/v1/microsoft-calendar-oauth-callback`);
    if (!tokens.refreshToken) return fail("no_refresh_token");

    const me = await graphRequest<{ mail?: string; userPrincipalName?: string }>(tokens.accessToken, "/me?$select=mail,userPrincipalName");
    const calendar = await graphRequest<{ id: string }>(tokens.accessToken, "/me/calendar?$select=id");
    if (!calendar?.id) return fail("calendar_unavailable");
    const msEmail = (me?.mail || me?.userPrincipalName || "").toLowerCase() || null;

    const connectionKey = isOffice ? "office" : actor.teamMemberId!;
    const { data: existing } = await admin
      .from("microsoft_calendar_connections")
      .select("id, ms_email, ms_calendar_id")
      .eq("account_owner_id", actor.accountOwnerId)
      .eq("connection_key", connectionKey)
      .maybeSingle();

    // A different Microsoft account/calendar: the old blocks and event links no longer describe this calendar.
    if (existing && (existing.ms_calendar_id !== calendar.id || existing.ms_email !== msEmail)) {
      await admin.from("calendar_busy_blocks").delete().eq("connection_id", existing.id);
      await admin.from("microsoft_calendar_event_map").delete().eq("connection_id", existing.id);
    }

    const { data: conn, error: upsertError } = await admin
      .from("microsoft_calendar_connections")
      .upsert({
        account_owner_id: actor.accountOwnerId,
        user_id: actor.userId,
        team_member_id: isOffice ? null : actor.teamMemberId,
        scope: verified.scope,
        connection_key: connectionKey,
        ms_email: msEmail,
        ms_calendar_id: calendar.id,
        status: "connected",
        delta_link: null,
        delta_window_end: null,
        last_error_code: null,
        last_error_message: null,
        consecutive_failures: 0,
        sync_locked_until: null,
        connected_at: new Date().toISOString(),
      }, { onConflict: "account_owner_id,connection_key" })
      .select("id")
      .single();
    if (upsertError || !conn) throw new Error(upsertError?.message ?? "Could not save the connection.");

    const { error: secretError } = await admin.from("microsoft_calendar_secrets").upsert({
      connection_id: conn.id,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_at: tokens.expiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: "connection_id" });
    if (secretError) throw new Error(secretError.message);

    if (isOffice) {
      // Shows up in Integrations (status pill, disconnect, recovery banner). Tokens are NOT stored here.
      await admin.from("integrations").upsert({
        user_id: actor.accountOwnerId,
        integration_type: "microsoft_calendar",
        status: "connected",
        config: { connection_id: conn.id, ms_email: msEmail, connected_at: new Date().toISOString() },
      }, { onConflict: "user_id,integration_type" });
    }

    return redirectTo({ microsoft_calendar: "connected", scope: verified.scope });
  } catch (error) {
    console.error(JSON.stringify({ event: "ms_calendar_oauth_callback_failed", user_id: verified.userId, error: error instanceof Error ? error.message : String(error) }));
    return fail("exchange_failed");
  }
});
