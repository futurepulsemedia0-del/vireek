// supabase/functions/api-v1/index.ts
//
// The real, public Vireek API — documented in /docs. Authenticated with a
// customer-issued API key (see api_keys table + src/pages/ApiKeysPage.tsx),
// NOT a Supabase auth JWT. The key is verified by hashing the presented
// value with the same SHA-256 the frontend used at creation time and
// looking up the hash — the raw key is never stored anywhere.
//
// Routes:
//   GET /api-v1/calls          list  (scope: calls:read)
//   GET /api-v1/calls/:id      one   (scope: calls:read)
//   GET /api-v1/leads          list  (scope: leads:read)
//   GET /api-v1/leads/:id      one   (scope: leads:read)
//   GET /api-v1/jobs           list  (scope: jobs:read)
//   GET /api-v1/jobs/:id       one   (scope: jobs:read)
//
// Deploy:
//   supabase functions deploy api-v1 --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TABLE_BY_RESOURCE: Record<string, { table: string; scope: string }> = {
  calls: { table: "calls", scope: "calls:read" },
  leads: { table: "leads", scope: "leads:read" },
  jobs: { table: "jobs", scope: "jobs:read" },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // ---- Authenticate the API key -----------------------------------------
  const authHeader = req.headers.get("Authorization") || "";
  const rawKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!rawKey) {
    return json({ error: "Missing Authorization header. Use: Authorization: Bearer vrk_live_..." }, 401);
  }

  const keyHash = await sha256Hex(rawKey);
  const { data: keyRow } = await admin
    .from("api_keys")
    .select("id, user_id, scopes, revoked_at")
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (!keyRow || keyRow.revoked_at) {
    return json({ error: "Invalid or revoked API key" }, 401);
  }

  // Fire-and-forget last_used_at update — doesn't block the response.
  admin.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyRow.id).then(() => {});

  // ---- Route -------------------------------------------------------------
  const url = new URL(req.url);
  const segments = url.pathname.replace(/^\/api-v1\/?/, "").split("/").filter(Boolean);
  const [resource, id] = segments;

  const resourceConfig = resource ? TABLE_BY_RESOURCE[resource] : undefined;
  if (!resourceConfig) {
    return json({ error: "Not found. Available resources: calls, leads, jobs" }, 404);
  }
  if (!(keyRow.scopes as string[]).includes(resourceConfig.scope)) {
    return json({ error: `This key is missing the required scope: ${resourceConfig.scope}` }, 403);
  }

  let query = admin.from(resourceConfig.table).select("*").eq("user_id", keyRow.user_id);

  if (id) {
    const { data, error } = await query.eq("id", id).maybeSingle();
    if (error) return json({ error: "Query failed" }, 500);
    if (!data) return json({ error: `${resource} not found` }, 404);
    return json({ data });
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 25, 1), 100);
  const before = url.searchParams.get("before");
  query = query.order("created_at", { ascending: false }).limit(limit);
  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) return json({ error: "Query failed" }, 500);
  return json({ data, has_more: data.length === limit, next_before: data.length ? data[data.length - 1].created_at : null });
});
