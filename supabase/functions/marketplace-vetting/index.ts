// supabase/functions/marketplace-vetting/index.ts
//
// Runs the automated static vetting checks for ONE submitted marketplace agent version and stores the
// result in the append-only marketplace_vetting_reports table. Staff only (checked here AND by RLS on read).
//
//   POST { "versionId": "<uuid>" }   Authorization: Bearer <staff user JWT>
//
// Deploy: supabase functions deploy marketplace-vetting --no-verify-jwt   (auth is enforced in this file)
// Needs the standard SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY secrets. No other secrets.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isUuid } from "../_shared/agent-marketplace/contract.ts";
import { hostOf, runStaticVetting, type DnsAnswer, type ScopeInfo } from "../_shared/agent-marketplace/vetting.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Row = Record<string, unknown>;

async function resolveHost(host: string): Promise<DnsAnswer> {
  const addresses: string[] = [];
  let lastError = "";
  for (const type of ["A", "AAAA"] as const) {
    try {
      addresses.push(...(await Deno.resolveDns(host, type)));
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return addresses.length > 0 ? { ok: true, addresses } : { ok: false, error: lastError || "No A/AAAA records." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !service) return json({ error: "Server is not configured" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return json({ error: "Unauthorized" }, 401);

  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "Unauthorized" }, 401);
  const userId = userData.user.id;

  const admin = createClient(url, service);
  const { data: isStaff } = await admin.rpc("is_vireek_staff", { uid: userId });
  if (isStaff !== true) return json({ error: "Staff only" }, 403);

  let body: { versionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!isUuid(body.versionId)) return json({ error: "versionId must be a uuid" }, 400);

  const { data: version } = await admin.from("marketplace_agent_versions").select("id, agent_id, manifest, manifest_hash, status").eq("id", body.versionId).maybeSingle();
  if (!version) return json({ error: "Version not found" }, 404);
  if ((version as Row).status !== "submitted") return json({ error: "Only versions awaiting review can be vetted" }, 409);

  const { data: agentRow } = await admin.from("marketplace_agents")
    .select("id, slug, name, publisher_id, publisher_name, runtime, endpoint_url").eq("id", (version as Row).agent_id as string).maybeSingle();
  if (!agentRow) return json({ error: "Agent not found" }, 404);
  const agent = agentRow as Row;

  const { data: scopeRows } = await admin.from("marketplace_scopes").select("slug, kind, risk");
  const scopeCatalog = ((scopeRows ?? []) as Row[]).map((s) => ({ slug: s.slug, kind: s.kind, risk: s.risk })) as ScopeInfo[];

  const endpointUrl = (agent.endpoint_url as string | null) ?? null;
  const host = hostOf(endpointUrl);

  const { data: others } = await admin.from("marketplace_agents").select("id, slug, name, publisher_id, endpoint_url").neq("id", agent.id as string).limit(2000);
  const otherRows = (others ?? []) as Row[];
  const differentPublisher = (r: Row) => r.publisher_id === null || r.publisher_id !== agent.publisher_id;
  const hostMatches = host
    ? otherRows.filter((r) => differentPublisher(r) && hostOf((r.endpoint_url as string | null) ?? null) === host).map((r) => String(r.slug))
    : [];
  const firstPartyNames = otherRows.filter((r) => r.publisher_id === null).map((r) => String(r.name));
  const otherAgentNames = otherRows.filter((r) => r.publisher_id !== null && differentPublisher(r)).map((r) => String(r.name));

  const dns = agent.runtime === "webhook" && host ? await resolveHost(host) : undefined;

  const report = runStaticVetting({
    agent: {
      slug: String(agent.slug), name: String(agent.name), publisherName: String(agent.publisher_name),
      publisherId: (agent.publisher_id as string | null) ?? null, runtime: agent.runtime === "builtin" ? "builtin" : "webhook", endpointUrl,
    },
    manifest: (version as Row).manifest,
    scopeCatalog,
    peers: { hostMatches, firstPartyNames, otherAgentNames },
    dns,
  });

  const { data: saved, error } = await admin.from("marketplace_vetting_reports").insert({
    version_id: (version as Row).id,
    manifest_hash: (version as Row).manifest_hash,
    endpoint_url: endpointUrl,
    verdict: report.verdict,
    risk_tier: report.riskTier,
    checks: report.checks,
    data_exposure: report.dataExposure,
    outbound_domains: report.outboundDomains,
    ran_by: userId,
  }).select("*").single();
  if (error) return json({ error: "Could not store the report" }, 500);

  return json({ report: saved });
});
