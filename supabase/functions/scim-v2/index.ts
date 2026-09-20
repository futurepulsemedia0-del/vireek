import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/scim+json" },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function scimUser(tm: { id: string; member_email: string; member_name: string | null; invite_status: string }) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: tm.id,
    userName: tm.member_email,
    displayName: tm.member_name ?? tm.member_email,
    active: tm.invite_status === "active",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // --- Authenticate the SCIM client via its bearer token (from the identity
  // provider — Okta/Entra ID), never a normal user session token. ---
  const authHeader = req.headers.get("authorization") ?? "";
  const rawToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!rawToken) return json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "Missing bearer token", status: "401" }, 401);

  const tokenHash = await sha256Hex(rawToken);
  const { data: tokenRow } = await admin
    .from("scim_tokens")
    .select("id, user_id, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (!tokenRow || tokenRow.revoked_at) {
    return json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "Invalid or revoked token", status: "401" }, 401);
  }
  const ownerId = tokenRow.user_id as string;
  await admin.from("scim_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", tokenRow.id);

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean); // [..., "Users", "<id>"?]
  const usersIdx = parts.indexOf("Users");
  const targetId = usersIdx >= 0 ? parts[usersIdx + 1] : undefined;

  // GET /Users or /Users/{id} — list or fetch
  if (req.method === "GET") {
    let query = admin.from("team_members").select("id, member_email, member_name, invite_status").eq("account_owner_id", ownerId);
    if (targetId) query = query.eq("id", targetId);
    const { data, error } = await query;
    if (error) return json({ detail: error.message, status: "500" }, 500);
    if (targetId) {
      if (!data || data.length === 0) return json({ detail: "Not found", status: "404" }, 404);
      return json(scimUser(data[0]));
    }
    return json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: data?.length ?? 0,
      Resources: (data ?? []).map(scimUser),
    });
  }

  // POST /Users — provision a new team member
  if (req.method === "POST" && !targetId) {
    const body = await req.json().catch(() => ({}));
    const email = (body.userName ?? body.emails?.[0]?.value ?? "").toLowerCase().trim();
    const name = body.displayName ?? body.name?.formatted ?? null;
    if (!email) return json({ detail: "userName (email) is required", status: "400" }, 400);

    const { data, error } = await admin
      .from("team_members")
      .insert({
        account_owner_id: ownerId,
        member_email: email,
        member_name: name,
        role: "member",
        invite_status: "active",
        permissions: { can_view_billing: false, can_manage_team: false, can_edit_business_profile: false, can_view_all_jobs: false },
      })
      .select("id, member_email, member_name, invite_status")
      .single();

    if (error) return json({ detail: error.message, status: "409" }, 409);
    await admin.rpc("log_audit_event", { p_user_id: ownerId, p_action: "scim_provisioned_user", p_target_table: "team_members", p_target_id: data.id });
    return json(scimUser(data), 201);
  }

  // PATCH /Users/{id} — most commonly used by IdPs to deactivate a user
  if (req.method === "PATCH" && targetId) {
    const body = await req.json().catch(() => ({}));
    const op = (body.Operations ?? []).find((o: { path?: string }) => o.path === "active");
    const settingActive = op ? Boolean(op.value) : true;

    if (!settingActive) {
      await admin.from("team_members").delete().eq("id", targetId).eq("account_owner_id", ownerId);
      await admin.rpc("log_audit_event", { p_user_id: ownerId, p_action: "scim_deprovisioned_user", p_target_table: "team_members", p_target_id: targetId });
    }
    return json({ id: targetId, active: settingActive });
  }

  // DELETE /Users/{id} — deprovision
  if (req.method === "DELETE" && targetId) {
    await admin.from("team_members").delete().eq("id", targetId).eq("account_owner_id", ownerId);
    await admin.rpc("log_audit_event", { p_user_id: ownerId, p_action: "scim_deprovisioned_user", p_target_table: "team_members", p_target_id: targetId });
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  return json({ detail: "Not implemented", status: "501" }, 501);
});
