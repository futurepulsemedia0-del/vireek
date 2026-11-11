// supabase/functions/import-framework/index.ts
//
// POST { action: "dry_run" | "start" | "rollback" | "status", scope_key, ... } — see
// _shared/import-framework/handler.ts and docs/platform/18-ma-readiness.md.
// Uses the CALLER's JWT (same model as data-import-run): RLS + can_run_data_imports() + the
// `import_framework` module gate apply to every statement. No service-role client, no secrets.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (both already provided to edge functions).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { handleFrameworkRequest } from "../_shared/import-framework/handler.ts";
import { IMPORT_ENTITIES } from "../_shared/import-framework/entities.ts";
import { createSupabaseSink } from "../_shared/import-framework/supabaseSink.ts";
import { createSupabaseStore } from "../_shared/import-framework/supabaseStore.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const MAX_BODY_BYTES = 30 * 1024 * 1024;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "unauthorized" }, 401);
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  const client = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: u } = await client.auth.getUser();
  if (!u?.user) return json({ error: "unauthorized" }, 401);
  const { data: owner } = await client.rpc("get_account_owner_id");
  if (!owner) return json({ error: "unauthorized" }, 401);
  const ownerId = owner as string;
  const [{ data: enabled }, { data: allowed }] = await Promise.all([client.rpc("import_framework_enabled"), client.rpc("can_run_data_imports")]);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const res = await handleFrameworkRequest({
    tenantId: ownerId, actorId: u.user.id, moduleEnabled: enabled === true, canImport: allowed === true,
    store: createSupabaseStore(client, ownerId), defs: IMPORT_ENTITIES,
    makeSink: (scope) => createSupabaseSink(client, ownerId, IMPORT_ENTITIES, scope),
  }, body);
  return json(res.body, res.status);
});
