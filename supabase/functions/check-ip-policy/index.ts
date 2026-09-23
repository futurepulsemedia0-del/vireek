import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = bitsStr ? parseInt(bitsStr, 10) : 32;
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const authHeader = req.headers.get("authorization") ?? "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "Missing Authorization header" }, 401);

  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);

  // Resolve the account owner the same way get_account_owner_id() does.
  const { data: prof } = await admin.from("profiles").select("id, role").eq("id", userData.user.id).maybeSingle();
  let ownerId = prof?.id ?? null;
  if (!prof || prof.role !== "owner") {
    const { data: tm } = await admin.from("team_members").select("account_owner_id").eq("member_email", (userData.user.email ?? "").toLowerCase()).maybeSingle();
    ownerId = tm?.account_owner_id ?? null;
  }
  if (!ownerId) return json({ error: "Account not found" }, 404);

  const { data: policy } = await admin.from("security_policies").select("ip_restriction_enabled").eq("user_id", ownerId).maybeSingle();
  const callerIp = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();

  if (!policy?.ip_restriction_enabled) {
    return json({ ip: callerIp, allowed: true, enforced: false });
  }

  const { data: rules } = await admin.from("ip_allow_rules").select("cidr").eq("user_id", ownerId);
  const allowed = (rules ?? []).some((r) => ipInCidr(callerIp, r.cidr));

  if (!allowed) {
    await admin.rpc("log_audit_event", { p_user_id: ownerId, p_action: "ip_policy_blocked", p_target_table: "ip_allow_rules", p_target_id: callerIp || "unknown" });
  }

  return json({ ip: callerIp, allowed, enforced: true });
});
