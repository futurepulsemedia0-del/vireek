// supabase/functions/_shared/pay/http.ts — auth + response helpers for the Pay/Capital functions.
// Same conventions as _shared/bank/http.ts, with a STRICTER manager check for money actions.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import type { PayProduct, ProductState } from "./types.ts";

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

export interface PayCaller {
  userId: string;
  ownerId: string;
  teamMemberId: string | null;
  memberName: string | null;
  /** Owner, profile-admin, or an ACTIVE team admin (mirrors SQL tech_pay_can_manage()). */
  canManage: boolean;
}

export async function authenticate(req: Request, db: SupabaseClient): Promise<PayCaller | Response> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header." }, 401);
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) return json({ error: "Invalid or expired session." }, 401);
  const userId = data.user.id;

  const { data: tm } = await db.from("team_members")
    .select("id, account_owner_id, role, invite_status, member_name").eq("user_id", userId).maybeSingle();
  if (tm?.account_owner_id) {
    return { userId, ownerId: tm.account_owner_id, teamMemberId: tm.id, memberName: tm.member_name ?? null,
      canManage: tm.role === "admin" && tm.invite_status === "active" };
  }
  const { data: profile } = await db.from("profiles").select("role").eq("id", userId).maybeSingle();
  return { userId, ownerId: userId, teamMemberId: null, memberName: null, canManage: profile?.role === "owner" || profile?.role === "admin" };
}

export async function getProductState(db: SupabaseClient, product: PayProduct, ownerId: string): Promise<ProductState> {
  const { data, error } = await db.rpc("pay_product_state", { p_product: product, p_tenant: ownerId });
  // Fail CLOSED: if the control plane cannot be read, the product is unavailable.
  if (error || !data) {
    console.error(JSON.stringify({ event: "pay_product_state_failed", product, error: error?.message }));
    return { available: false, product, mode: "sandbox", reason: "platform_disabled" };
  }
  return data as ProductState;
}

export function unavailable(state: ProductState): Response {
  return json({ error: "unavailable", reason: state.reason, product: state.product }, 403);
}

export function logPay(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
