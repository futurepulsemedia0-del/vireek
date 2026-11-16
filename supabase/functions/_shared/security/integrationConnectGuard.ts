// Authorization guard for the "start OAuth connection" edge functions (Jobber, HubSpot, Google Calendar).
// Same rule as microsoft-calendar-oauth-start: owner, admin, or can_manage_team.
// The returned accountOwnerId is the TENANT id: sign OAuth state with it so credentials land on the right tenant.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { resolveActorFromJwt } from "../microsoft-calendar/actor.ts";

export type IntegrationGuardResult =
  | { ok: true; userId: string; accountOwnerId: string }
  | { ok: false; status: 401 | 403; error: string };

export async function requireIntegrationManager(admin: SupabaseClient, jwt: string): Promise<IntegrationGuardResult> {
  const actor = await resolveActorFromJwt(admin, jwt);
  if (!actor) return { ok: false, status: 401, error: "Invalid or expired session." };
  if (!actor.canManage) {
    return { ok: false, status: 403, error: "Only account owners and admins can connect integrations." };
  }
  return { ok: true, userId: actor.userId, accountOwnerId: actor.accountOwnerId };
}
