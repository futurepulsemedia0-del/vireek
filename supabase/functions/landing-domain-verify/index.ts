// supabase/functions/landing-domain-verify/index.ts
//
// Verifies custom-domain ownership (DNS TXT via DNS-over-HTTPS), then
// (optionally) attaches the domain to the Vercel project. Also handles removal.
//
// Security: the caller's JWT is used to read the row through RLS (account
// scoping) and to check can_manage_landing_pages(). Only AFTER those pass is the
// service-role client used to write verification state, which the DB trigger
// forbids for normal API users.
//
// Optional secrets: VERCEL_API_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID,
// LANDING_CNAME_TARGET (default cname.vercel-dns.com), LANDING_A_RECORD (default 76.76.21.21)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Must match src/lib/landingPageUtils.ts
const TXT_CHALLENGE_PREFIX = "_vireek-challenge";
const TXT_VALUE_PREFIX = "vireek-verify=";

const CNAME_TARGET = (Deno.env.get("LANDING_CNAME_TARGET") ?? "cname.vercel-dns.com").toLowerCase();
const A_TARGET = Deno.env.get("LANDING_A_RECORD") ?? "76.76.21.21";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const DNS_TYPES = { A: 1, CNAME: 5, TXT: 16 } as const;

async function dohQuery(name: string, type: keyof typeof DNS_TYPES): Promise<string[]> {
  const res = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) throw new Error("dns_lookup_failed");
  const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
  return (body.Answer ?? []).filter((a) => a.type === DNS_TYPES[type]).map((a) => String(a.data));
}

async function checkRouting(domain: string): Promise<boolean> {
  try {
    const [cnames, aRecords] = await Promise.all([dohQuery(domain, "CNAME"), dohQuery(domain, "A")]);
    return (
      cnames.some((c) => c.replace(/\.$/, "").toLowerCase() === CNAME_TARGET) ||
      aRecords.includes(A_TARGET)
    );
  } catch {
    return false;
  }
}

function vercelConfig() {
  const token = Deno.env.get("VERCEL_API_TOKEN");
  const project = Deno.env.get("VERCEL_PROJECT_ID");
  if (!token || !project) return null;
  const team = Deno.env.get("VERCEL_TEAM_ID");
  return { token, project, query: team ? `?teamId=${encodeURIComponent(team)}` : "" };
}

async function vercelAttach(domain: string): Promise<{ attempted: boolean; ok: boolean }> {
  const cfg = vercelConfig();
  if (!cfg) return { attempted: false, ok: true };
  try {
    const res = await fetch(`https://api.vercel.com/v10/projects/${cfg.project}/domains${cfg.query}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: domain }),
      signal: AbortSignal.timeout(8000),
    });
    // 409 = already attached to this project, which is fine.
    return { attempted: true, ok: res.ok || res.status === 409 };
  } catch {
    return { attempted: true, ok: false };
  }
}

async function vercelDetach(domain: string): Promise<void> {
  const cfg = vercelConfig();
  if (!cfg) return;
  try {
    await fetch(
      `https://api.vercel.com/v9/projects/${cfg.project}/domains/${encodeURIComponent(domain)}${cfg.query}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(8000) },
    );
  } catch {
    // Best effort — the row is removed regardless so it stops being served.
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  let payload: { action?: string; domain_id?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const { action, domain_id: domainId } = payload ?? {};
  if ((action !== "verify" && action !== "remove") || typeof domainId !== "string") {
    return json({ error: "invalid_request" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData } = await userClient.auth.getUser();
  if (!userData?.user) return json({ error: "unauthorized" }, 401);

  const { data: allowed } = await userClient.rpc("can_manage_landing_pages");
  if (!allowed) return json({ error: "forbidden" }, 403);

  // Read through RLS: proves the row belongs to the caller's account.
  const { data: row, error: rowError } = await userClient
    .from("landing_domains")
    .select("id, domain, status, verification_token, last_checked_at")
    .eq("id", domainId)
    .maybeSingle();
  if (rowError || !row) return json({ error: "not_found" }, 404);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (action === "remove") {
    if (row.status === "verified") await vercelDetach(row.domain);
    const { error } = await admin.from("landing_domains").delete().eq("id", row.id);
    if (error) return json({ error: "delete_failed" }, 500);
    return json({ ok: true });
  }

  // ---- verify ----
  if (row.last_checked_at && Date.now() - new Date(row.last_checked_at).getTime() < 5000) {
    return json({ status: row.status, txt_found: row.status === "verified", routing_ok: false, throttled: true });
  }

  const nowIso = new Date().toISOString();

  if (row.status === "verified") {
    const [attach, routingOk] = await Promise.all([vercelAttach(row.domain), checkRouting(row.domain)]);
    await admin
      .from("landing_domains")
      .update({ last_checked_at: nowIso, last_error: attach.ok ? null : "vercel_attach_failed" })
      .eq("id", row.id);
    return json({ status: "verified", txt_found: true, routing_ok: routingOk, error: attach.ok ? undefined : "vercel_attach_failed" });
  }

  let txtFound = false;
  try {
    const records = await dohQuery(`${TXT_CHALLENGE_PREFIX}.${row.domain}`, "TXT");
    const expected = `${TXT_VALUE_PREFIX}${row.verification_token}`;
    txtFound = records.some((r) => r.replace(/"\s+"/g, "").replace(/^"|"$/g, "").trim() === expected);
  } catch {
    return json({ status: row.status, txt_found: false, routing_ok: false, error: "dns_lookup_failed" });
  }

  if (!txtFound) {
    await admin
      .from("landing_domains")
      .update({ last_checked_at: nowIso, last_error: "txt_not_found" })
      .eq("id", row.id);
    return json({ status: row.status, txt_found: false, routing_ok: false, error: "txt_not_found" });
  }

  const { error: updateError } = await admin
    .from("landing_domains")
    .update({ status: "verified", verified_at: nowIso, last_checked_at: nowIso, last_error: null })
    .eq("id", row.id);

  if (updateError) {
    // 23505 = another account already holds this domain as verified.
    const inUse = updateError.code === "23505";
    await admin
      .from("landing_domains")
      .update({ status: "failed", last_checked_at: nowIso, last_error: inUse ? "domain_in_use" : "update_failed" })
      .eq("id", row.id);
    return json({ status: "failed", txt_found: true, routing_ok: false, error: inUse ? "domain_in_use" : "update_failed" });
  }

  const [attach, routingOk] = await Promise.all([vercelAttach(row.domain), checkRouting(row.domain)]);
  if (!attach.ok) {
    await admin.from("landing_domains").update({ last_error: "vercel_attach_failed" }).eq("id", row.id);
  }
  return json({
    status: "verified",
    txt_found: true,
    routing_ok: routingOk,
    error: attach.ok ? undefined : "vercel_attach_failed",
  });
});
