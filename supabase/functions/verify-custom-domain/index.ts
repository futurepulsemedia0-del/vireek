// Verifies ownership of the custom domain claimed in brand_settings.
//
// Ownership proof = a DNS TXT record at _vireek-verify.<domain> whose value is
// `vireek-verify=<token>` (token generated server-side by the brand_settings
// trigger). We also report whether the CNAME points at our edge, but only the
// TXT record decides "verified" — the CNAME may legitimately be added after.
//
// Auth: caller must be signed in AND pass public.can_manage_branding().
// Writes use the service role, which is the only role the brand_settings guard
// trigger lets change verification state.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const TXT_PREFIX = "_vireek-verify";
const CNAME_TARGET = "cname.vercel-dns.com";
const MIN_SECONDS_BETWEEN_CHECKS = 10;

const WHITE_LABEL_PLANS = ["business", "enterprise"]; // keep in sync with brand_plan_is_white_label()
const RESERVED_DOMAIN_SUFFIXES = ["vireek.com", "vireek.app", "vercel.app", "supabase.co", "localhost"];

// Attaches the verified domain to the Vercel project so TLS can be issued.
// Needs secrets VERCEL_API_TOKEN + VERCEL_PROJECT_ID (and VERCEL_TEAM_ID for team projects).
// Without them the result is "manual" and nothing is attempted.
async function attachToVercel(domain: string): Promise<{ state: "ok" | "manual" | "failed"; error: string | null }> {
  const token = Deno.env.get("VERCEL_API_TOKEN");
  const projectId = Deno.env.get("VERCEL_PROJECT_ID");
  if (!token || !projectId) return { state: "manual", error: null };
  const team = Deno.env.get("VERCEL_TEAM_ID");
  const qs = team ? `?teamId=${encodeURIComponent(team)}` : "";
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/domains${qs}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: domain }),
      signal: controller.signal,
    });
    if (res.ok) return { state: "ok", error: null };
    if (res.status === 409) {
      // Re-verify of a domain we already attached is fine; another project holding it is not.
      const chk = await fetch(
        `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}${qs}`,
        { headers, signal: controller.signal },
      );
      if (chk.ok) return { state: "ok", error: null };
      return { state: "failed", error: "This domain is already attached elsewhere in our hosting account. Contact support." };
    }
    return { state: "failed", error: "Our hosting provider couldn't activate this domain yet. Press Retry activation in a minute." };
  } catch {
    return { state: "failed", error: "Hosting provider unreachable. Press Retry activation in a minute." };
  } finally {
    clearTimeout(timer);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface DohAnswer { name: string; type: number; data: string }

async function dohQuery(name: string, type: "TXT" | "CNAME"): Promise<{ answers: DohAnswer[]; failed: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: controller.signal },
    );
    if (!res.ok) return { answers: [], failed: true };
    const body = await res.json();
    // Status 0 = NOERROR, 3 = NXDOMAIN (a definitive "no such record", not a lookup failure).
    if (body.Status !== 0 && body.Status !== 3) return { answers: [], failed: true };
    return { answers: (body.Answer ?? []) as DohAnswer[], failed: false };
  } catch {
    return { answers: [], failed: true };
  } finally {
    clearTimeout(timer);
  }
}

const unquote = (s: string) => s.replace(/^"|"$/g, "").replace(/"\s+"/g, "");
const stripDot = (s: string) => s.replace(/\.$/, "").toLowerCase();

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  // Caller-scoped client: RLS + can_manage_branding() decide what they may see/do.
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(url, service, { auth: { persistSession: false } });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Invalid or expired session" }, 401);

  const { data: allowed } = await userClient.rpc("can_manage_branding");
  if (allowed !== true) return json({ error: "You don't have permission to manage branding." }, 403);

  const { data: row } = await userClient
    .from("brand_settings")
    .select("user_id, custom_domain, domain_verification_token, domain_last_checked_at")
    .maybeSingle();
  if (!row?.custom_domain || !row.domain_verification_token) {
    return json({ error: "Save a custom domain first." }, 400);
  }

  if (row.domain_last_checked_at) {
    const elapsed = (Date.now() - new Date(row.domain_last_checked_at).getTime()) / 1000;
    if (elapsed < MIN_SECONDS_BETWEEN_CHECKS) {
      return json({ error: `Please wait ${Math.ceil(MIN_SECONDS_BETWEEN_CHECKS - elapsed)}s before checking again.` }, 429);
    }
  }

    const { data: ownerProfile } = await admin.from("profiles").select("plan").eq("id", row.user_id).maybeSingle();
  if (!WHITE_LABEL_PLANS.includes(String(ownerProfile?.plan ?? ""))) {
    return json({ error: "Custom domains need the Business plan or higher.", code: "PLAN_REQUIRED" }, 403);
  }
  const claimed = String(row.custom_domain).toLowerCase();
  if (RESERVED_DOMAIN_SUFFIXES.some((s) => claimed === s || claimed.endsWith(`.${s}`))) {
    return json({ error: "That domain belongs to a platform we host on — use your own domain." }, 400);
  }
  const domain: string = row.custom_domain;
  const expected = `vireek-verify=${row.domain_verification_token}`;

  const [txt, cname] = await Promise.all([
    dohQuery(`${TXT_PREFIX}.${domain}`, "TXT"),
    dohQuery(domain, "CNAME"),
  ]);

  const txtFound = txt.answers.some((a) => a.type === 16 && unquote(a.data) === expected);
  const cnameOk = cname.answers.some((a) => a.type === 5 && stripDot(a.data) === CNAME_TARGET);

  let status: "verified" | "pending" | "failed";
  let error: string | null = null;

  if (txtFound) {
    // Another account may already hold this domain verified (unique partial index).
    status = "verified";
  } else if (txt.failed) {
    status = "pending"; // lookup problem, not proof of absence — don't mark failed
    error = "We couldn't reach DNS just now. Try again in a minute.";
  } else {
    status = "failed";
    error = `TXT record not found yet. DNS changes can take up to a few hours to propagate.`;
  }

  const { error: updErr } = await admin
    .from("brand_settings")
    .update({
      domain_status: status,
      domain_verified_at: status === "verified" ? new Date().toISOString() : null,
      domain_last_checked_at: new Date().toISOString(),
      domain_error: error,
    })
    .eq("user_id", row.user_id)
    .eq("custom_domain", domain); // guards against the domain being changed mid-check

  if (updErr) {
    // 23505 = unique violation → someone else already verified this exact domain.
    if ((updErr as { code?: string }).code === "23505") {
      await admin
        .from("brand_settings")
        .update({
          domain_status: "failed",
          domain_verified_at: null,
          domain_last_checked_at: new Date().toISOString(),
          domain_error: "This domain is already verified by another Vireek account.",
        })
        .eq("user_id", row.user_id);
      return json({
        status: "failed",
        txt_found: txtFound,
        cname_ok: cnameOk,
        error: "This domain is already verified by another Vireek account.",
      });
    }
    return json({ error: "Could not save the verification result." }, 500);
  }

  let provisioning: "ok" | "manual" | "failed" | "n/a" = "n/a";
  let provisionError: string | null = null;
  if (status === "verified") {
    const prov = await attachToVercel(domain);
    provisioning = prov.state;
    provisionError = prov.error;
    await admin
      .from("brand_settings")
      .update({
        domain_provisioned_at: prov.state === "ok" ? new Date().toISOString() : null,
        domain_provision_error: prov.error,
      })
      .eq("user_id", row.user_id)
      .eq("custom_domain", domain);
  }

  return json({ status, txt_found: txtFound, cname_ok: cnameOk, error, provisioning, provision_error: provisionError });
});
