import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  // Management API token: create at https://supabase.com/dashboard/account/tokens
  // then `supabase secrets set SUPABASE_MANAGEMENT_TOKEN=... SUPABASE_PROJECT_REF=...`
  const managementToken = Deno.env.get("SUPABASE_MANAGEMENT_TOKEN") ?? "";
  const projectRef = Deno.env.get("SUPABASE_PROJECT_REF") ?? "";
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const authHeader = req.headers.get("authorization") ?? "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "Missing Authorization header" }, 401);

  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);

  // Only the account owner may manage SSO.
  const { data: prof } = await admin.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (!prof || prof.role !== "owner") return json({ error: "Only the account owner can manage SSO." }, 403);

  const body = await req.json().catch(() => ({}));
  const action = body.action as "register" | "remove" | undefined;

  if (!managementToken || !projectRef) {
    return json({ error: "SSO isn't configured on this server yet. Set SUPABASE_MANAGEMENT_TOKEN and SUPABASE_PROJECT_REF as edge function secrets." }, 501);
  }

  const mgmtHeaders = { Authorization: `Bearer ${managementToken}`, "Content-Type": "application/json" };

  if (action === "register") {
    const { domain, metadataUrl } = body as { domain?: string; metadataUrl?: string };
    if (!domain || !metadataUrl) return json({ error: "domain and metadataUrl are required" }, 400);

    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth/sso/providers`, {
      method: "POST",
      headers: mgmtHeaders,
      body: JSON.stringify({
        type: "saml",
        metadata_url: metadataUrl,
        domains: [domain],
      }),
    });
    const providerData = await res.json();
    if (!res.ok) return json({ error: providerData.message ?? "Could not register the SAML provider." }, 502);

    const { error: dbErr } = await admin
      .from("sso_domains")
      .upsert({ user_id: userData.user.id, domain, sso_provider_id: providerData.id, status: "active" }, { onConflict: "domain" });
    if (dbErr) return json({ error: dbErr.message }, 500);

    await admin.rpc("log_audit_event", { p_user_id: userData.user.id, p_action: "sso_domain_registered", p_target_table: "sso_domains", p_target_id: domain });
    return json({ success: true, providerId: providerData.id });
  }

  if (action === "remove") {
    const { domain } = body as { domain?: string };
    if (!domain) return json({ error: "domain is required" }, 400);

    const { data: existing } = await admin.from("sso_domains").select("sso_provider_id").eq("user_id", userData.user.id).eq("domain", domain).maybeSingle();
    if (existing?.sso_provider_id) {
      await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth/sso/providers/${existing.sso_provider_id}`, {
        method: "DELETE",
        headers: mgmtHeaders,
      });
    }
    await admin.from("sso_domains").delete().eq("user_id", userData.user.id).eq("domain", domain);
    await admin.rpc("log_audit_event", { p_user_id: userData.user.id, p_action: "sso_domain_removed", p_target_table: "sso_domains", p_target_id: domain });
    return json({ success: true });
  }

  return json({ error: "Unknown action" }, 400);
});
