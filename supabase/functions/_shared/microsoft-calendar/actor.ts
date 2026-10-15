// Resolves who is calling and which account they act for. Mirrors the app's model:
// a team_members row (user_id = auth user) means "team member of account_owner_id"; otherwise the user is the owner.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { canManageCalendars } from "./engine.ts";

export interface Actor { userId: string; email: string | null; accountOwnerId: string; teamMemberId: string | null; canManage: boolean }

export async function resolveActorById(admin: SupabaseClient, userId: string): Promise<Actor | null> {
  const { data: tms } = await admin
    .from("team_members")
    .select("id, account_owner_id, role, permissions")
    .eq("user_id", userId)
    .limit(1);
  const tm = tms?.[0];
  if (tm) {
    return {
      userId, email: null, accountOwnerId: tm.account_owner_id, teamMemberId: tm.id,
      canManage: canManageCalendars({ role: tm.role, permissions: tm.permissions }),
    };
  }
  const { data: profile } = await admin.from("profiles").select("id").eq("id", userId).maybeSingle();
  return profile ? { userId, email: null, accountOwnerId: userId, teamMemberId: null, canManage: true } : null;
}

export async function resolveActorFromJwt(admin: SupabaseClient, jwt: string): Promise<Actor | null> {
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return null;
  const actor = await resolveActorById(admin, data.user.id);
  return actor ? { ...actor, email: data.user.email ?? null } : null;
}
