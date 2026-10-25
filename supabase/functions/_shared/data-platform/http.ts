// supabase/functions/_shared/data-platform/http.ts
// Small helpers shared by the four Data Platform edge functions.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { safeEqual } from "./secrets.ts";

// deno-lint-ignore no-explicit-any
export type Admin = SupabaseClient<any, any, any>;

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

export const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json", ...extra } });

export function adminClient(): Admin {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false, autoRefreshToken: false } });
}

export interface Caller {
  userId: string;
  ownerId: string;
  email: string | null;
  canManage: boolean;
  canViewBilling: boolean;
}

/** Verifies the JWT and resolves the ACCOUNT OWNER plus the two permissions this feature uses. */
export async function authenticate(req: Request): Promise<{ ok: true; caller: Caller } | { ok: false; res: Response }> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return { ok: false, res: json({ error: "Missing Authorization header." }, 401) };
  const caller = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  });
  const { data: u } = await caller.auth.getUser();
  if (!u?.user) return { ok: false, res: json({ error: "Invalid or expired session." }, 401) };
  const { data: ownerId } = await caller.rpc("get_account_owner_id");
  if (!ownerId) return { ok: false, res: json({ error: "No account found." }, 403) };
  const [{ data: manage }, { data: billing }] = await Promise.all([
    caller.rpc("can_manage_data_platform"),
    caller.rpc("reports_can_access", { p_owner: ownerId }),
  ]);
  return { ok: true, caller: { userId: u.user.id, ownerId: ownerId as string, email: u.user.email ?? null, canManage: manage === true, canViewBilling: billing === true } };
}

export function isCron(req: Request): boolean {
  const secret = Deno.env.get("CRON_SECRET");
  const given = req.headers.get("X-Cron-Secret") ?? "";
  return !!secret && safeEqual(given, secret);
}

export function encryptionKey(): string {
  const k = Deno.env.get("DATA_PLATFORM_ENCRYPTION_KEY");
  if (!k) throw new Error("DATA_PLATFORM_ENCRYPTION_KEY is not configured on the server.");
  return k;
}

export const aad = (kind: "destination" | "embed", id: string) => `dp_${kind}:${id}`;
