// supabase/functions/status-feed/index.ts
//
// Public status feed (no auth). GET /status-feed            -> JSON
//                                GET /status-feed?format=atom -> Atom feed of incidents
// Data comes from public_status_feed(): no phone numbers, no tenants, no regions.
// Deploy: supabase functions deploy status-feed --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

interface FeedIncident {
  id: string; title: string; impact: string; status: string; summary: string;
  started_at: string; resolved_at: string | null;
  updates: { status: string; message: string; at: string }[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function atom(incidents: FeedIncident[], siteUrl: string): string {
  const updated = incidents[0]?.started_at ?? new Date().toISOString();
  const entries = incidents.map((i) => {
    const last = i.updates[0];
    return `<entry><id>urn:vireek:incident:${esc(i.id)}</id><title>${esc(`[${i.status}] ${i.title}`)}</title>` +
      `<updated>${esc(last?.at ?? i.started_at)}</updated><published>${esc(i.started_at)}</published>` +
      `<link href="${esc(siteUrl)}/status"/><summary>${esc(last?.message ?? i.summary)}</summary></entry>`;
  }).join("");
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>urn:vireek:status</id>` +
    `<title>Vireek Status</title><updated>${esc(updated)}</updated><link href="${esc(siteUrl)}/status"/>${entries}</feed>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response("Server not configured", { status: 500, headers: cors });
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await admin.rpc("public_status_feed");
  if (error || !data) return new Response(JSON.stringify({ error: "Status temporarily unavailable" }), { status: 503, headers: { ...cors, "Content-Type": "application/json" } });

  const headers = { ...cors, "Cache-Control": "public, max-age=60, s-maxage=60" };
  if (new URL(req.url).searchParams.get("format") === "atom") {
    const site = Deno.env.get("SITE_URL") ?? "https://vireek.com";
    return new Response(atom((data as { incidents: FeedIncident[] }).incidents ?? [], site), { headers: { ...headers, "Content-Type": "application/atom+xml; charset=utf-8" } });
  }
  return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
});
