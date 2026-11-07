// Shared caller check for tenant-export / tenant-import: signed-in user, account owner/admin only.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export const CORS = {
  "Access-Control-Allow-Origin": "*", // bearer-JWT endpoint; no cookies are involved
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
export const jsonRes = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export async function authorizeOwner(req: Request): Promise<
  { ok: true; ownerId: string; actorId: string; admin: SupabaseClient } | { ok: false; res: Response }
> {
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = req.headers.get("Authorization") ?? "";
  if (!url || !anon || !svc) return { ok: false, res: jsonRes({ error: "server_not_configured" }, 500) };
  if (!auth.startsWith("Bearer ")) return { ok: false, res: jsonRes({ error: "unauthorized" }, 401) };
  const caller = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u, error } = await caller.auth.getUser();
  if (error || !u.user) return { ok: false, res: jsonRes({ error: "unauthorized" }, 401) };
  // Same gate the Agent Network UI uses: owner/admin of the account, resolved server-side.
  const [{ data: isAdmin }, { data: ownerId }] = await Promise.all([caller.rpc("agent_network_is_admin"), caller.rpc("get_account_owner_id")]);
  if (isAdmin !== true || typeof ownerId !== "string") return { ok: false, res: jsonRes({ error: "forbidden" }, 403) };
  return { ok: true, ownerId, actorId: u.user.id, admin: createClient(url, svc, { auth: { persistSession: false, autoRefreshToken: false } }) };
}
