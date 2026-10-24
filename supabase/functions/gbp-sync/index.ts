// gbp-sync — applies an OWNER-APPROVED services proposal to Google Business Profile.
//   POST { proposal_id }   (user JWT required)
//
// Safety rails (nothing reaches Google unless ALL hold):
//   1. GBP_APPLY_ENABLED=true   (off by default — flip only after Google grants Business Profile API access)
//   2. the proposal is 'approved' by an owner/admin and the source data has not changed since (gbp_begin_apply)
//   3. an integrations row (integration_type='google_business_profile', status='connected') holds a token + location_name
// Additive only: existing Google service items are never removed or edited.
// Service-area proposals need Google place IDs and are applied manually (409 manual_only).
//
// Secrets: GBP_APPLY_ENABLED, GOOGLE_BUSINESS_CLIENT_ID, GOOGLE_BUSINESS_CLIENT_SECRET
// Deploy: supabase functions deploy gbp-sync

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

const LOCATION_RE = /^locations\/\d+$/;
const MAX_NEW_ITEMS = 50;
const API = "https://mybusinessbusinessinformation.googleapis.com/v1";

interface GbpConfig {
  access_token?: string;
  refresh_token?: string | null;
  expires_at?: string;
  location_name?: string;
}

async function freshToken(admin: ReturnType<typeof createClient>, userId: string, cfg: GbpConfig): Promise<string | null> {
  const expiresAt = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (cfg.access_token && expiresAt > Date.now() + 60_000) return cfg.access_token;
  const clientId = Deno.env.get("GOOGLE_BUSINESS_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_BUSINESS_CLIENT_SECRET");
  if (!cfg.refresh_token || !clientId || !clientSecret) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, refresh_token: cfg.refresh_token, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;
  const tok = await res.json();
  if (!tok.access_token) return null;
  await admin.from("integrations").update({
    config: { ...cfg, access_token: tok.access_token, expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString() },
  }).eq("user_id", userId).eq("integration_type", "google_business_profile");
  return tok.access_token as string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (Deno.env.get("GBP_APPLY_ENABLED") !== "true") return json({ ok: false, code: "apply_disabled" }, 409);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth) return json({ error: "unauthorized" }, 401);

  let proposalId = "";
  try {
    const body = await req.json();
    proposalId = typeof body?.proposal_id === "string" ? body.proposal_id : "";
  } catch { /* handled below */ }
  if (!/^[0-9a-f-]{36}$/i.test(proposalId)) return json({ error: "bad_request" }, 400);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const begin = await userClient.rpc("gbp_begin_apply", { p_id: proposalId });
  if (begin.error) return json({ error: begin.error.message.includes("forbidden") ? "forbidden" : "unauthorized" }, begin.error.message.includes("forbidden") ? 403 : 401);
  const ctx = begin.data as { ok: boolean; code?: string; owner_id?: string; kind?: string; desired?: unknown };
  if (!ctx?.ok) return json({ ok: false, code: ctx?.code ?? "unknown" }, 409);

  const finish = (status: "applied" | "approved" | "failed", error?: string) =>
    admin.rpc("gbp_finish_apply", { p_id: proposalId, p_status: status, p_error: error ?? null });

  try {
    if (ctx.kind !== "services") {
      await finish("approved", "manual_only");
      return json({ ok: false, code: "manual_only" }, 409);
    }

    const { data: integ } = await admin.from("integrations").select("status, config")
      .eq("user_id", ctx.owner_id).eq("integration_type", "google_business_profile").maybeSingle();
    const cfg = (integ?.config ?? {}) as GbpConfig;
    if (!integ || integ.status !== "connected" || !cfg.location_name || !LOCATION_RE.test(cfg.location_name)) {
      await finish("approved", "not_connected");
      return json({ ok: false, code: "not_connected" }, 409);
    }
    const token = await freshToken(admin, ctx.owner_id as string, cfg);
    if (!token) {
      await finish("approved", "token_unavailable");
      return json({ ok: false, code: "token_unavailable" }, 409);
    }
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const getRes = await fetch(`${API}/${cfg.location_name}?readMask=categories,serviceItems`, { headers });
    if (!getRes.ok) {
      await finish("approved", `google_read_${getRes.status}`);
      return json({ ok: false, code: "google_read_failed", status: getRes.status }, 502);
    }
    const loc = await getRes.json();
    const category: string | undefined = loc?.categories?.primaryCategory?.name;
    if (!category) {
      await finish("approved", "no_primary_category");
      return json({ ok: false, code: "no_primary_category" }, 409);
    }

    const existing: Record<string, unknown>[] = Array.isArray(loc.serviceItems) ? loc.serviceItems : [];
    const have = new Set(existing.map((i) => {
      const ff = i.freeFormServiceItem as { label?: { displayName?: string } } | undefined;
      return (ff?.label?.displayName ?? "").trim().toLowerCase();
    }).filter(Boolean));
    const wanted = (Array.isArray(ctx.desired) ? ctx.desired : []).filter((x): x is string => typeof x === "string");
    const additions = wanted
      .filter((name) => !have.has(name.trim().toLowerCase()))
      .slice(0, MAX_NEW_ITEMS)
      .map((name) => ({ freeFormServiceItem: { category, label: { displayName: name.slice(0, 140), languageCode: "en" } } }));

    if (additions.length > 0) {
      const patch = await fetch(`${API}/${cfg.location_name}?updateMask=serviceItems`, {
        method: "PATCH", headers, body: JSON.stringify({ serviceItems: [...existing, ...additions] }),
      });
      if (!patch.ok) {
        await finish("failed", `google_write_${patch.status}`);
        return json({ ok: false, code: "google_write_failed", status: patch.status }, 502);
      }
    }
    await finish("applied");
    return json({ ok: true, added: additions.length });
  } catch (error) {
    await finish("failed", "unexpected_error");
    console.error(JSON.stringify({ event: "gbp_sync_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ ok: false, code: "unexpected_error" }, 500);
  }
});
