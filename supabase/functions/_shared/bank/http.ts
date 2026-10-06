// supabase/functions/_shared/bank/http.ts
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
}

export interface Caller { userId: string; ownerId: string; isOwner: boolean; canManage: boolean }

/** Resolves the JWT to the account owner (team members act on the owner's books). */
export async function authenticate(req: Request, db: SupabaseClient): Promise<Caller | Response> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header." }, 401);
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) return json({ error: "Invalid or expired session." }, 401);
  const userId = data.user.id;
  const { data: tm } = await db.from("team_members").select("account_owner_id, role, permissions").eq("user_id", userId).maybeSingle();
  if (tm?.account_owner_id) {
    const canManage = tm.role === "admin" || tm.permissions?.can_view_billing === true;
    return { userId, ownerId: tm.account_owner_id, isOwner: false, canManage };
  }
  return { userId, ownerId: userId, isOwner: true, canManage: true };
}

/** Constant-time compare for the service-role bearer used by cron. */
export function isServiceCall(req: Request): boolean {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const got = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!key || got.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
