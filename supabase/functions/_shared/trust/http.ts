// supabase/functions/_shared/trust/http.ts — request plumbing shared by the Trust Pack functions.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json", ...extra } });
}

export interface Caller {
  caller: SupabaseClient;
  admin: SupabaseClient;
  userId: string;
  ownerId: string;
  isOwner: boolean;
  isStaff: boolean;
}

/** Authenticates from the caller's own JWT. The client never sends an account id. */
export async function authenticate(req: Request): Promise<Caller | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data: userData, error: userErr } = await caller.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Not authenticated" }, 401);
  const { data: ownerData, error: ownerErr } = await caller.rpc("get_account_owner_id");
  if (ownerErr || !ownerData) return json({ error: "Could not resolve your account." }, 401);
  const { data: staff } = await caller.rpc("is_vireek_staff", { uid: user.id });
  return { caller, admin, userId: user.id, ownerId: ownerData as string, isOwner: ownerData === user.id, isStaff: staff === true };
}

/** Constant-time compare for the scheduler secret. */
export function cronAuthorized(req: Request): boolean {
  const secret = Deno.env.get("TRUST_CRON_SECRET");
  const given = req.headers.get("X-Cron-Secret");
  if (!secret || !given || secret.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Best-effort audit entry written AS the caller (log_audit_event records auth.uid()). */
export async function audit(c: Caller, action: string, table: string | null, targetId: string | null, metadata?: Record<string, unknown>): Promise<void> {
  try {
    await c.caller.rpc("log_audit_event", { p_user_id: c.ownerId, p_action: action, p_target_table: table, p_target_id: targetId, p_metadata: metadata ?? null });
  } catch {
    /* audit must never break the user's action */
  }
}
