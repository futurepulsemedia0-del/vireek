// supabase/functions/switching-request/index.ts
//
// Thin, validated wrapper over the switching-request RPCs (migration 20290306000100). Every call runs as the
// CALLER (anon key + the caller's JWT, never the service role); the RPCs themselves enforce who may do what:
//   create | cancel | list   account owner / admin (list is also readable by RLS for the tenant)
//   advance | overdue        Vireek staff (profiles.is_staff)
// POST JSON: { action: "create", targetProvider?, notes? } | { action: "cancel", id, note? } | { action: "list" }
//          | { action: "advance", id, to, note? } | { action: "overdue" }
// Deploy: supabase functions deploy switching-request   (JWT verification stays ON)
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { mapRpcError, parseCommand } from "../_shared/switching/requests.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ ok: false, code: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "", anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  if (!url || !anon) return json({ ok: false, code: "server_not_configured" }, 500);
  if (!auth.startsWith("Bearer ")) return json({ ok: false, code: "unauthorized" }, 401);

  const raw = await req.text();
  if (raw.length > 8 * 1024) return json({ ok: false, code: "too_large" }, 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, code: "invalid_json" }, 400); }
  const cmd = parseCommand(body);
  if (!cmd.ok) return json({ ok: false, code: "validation", message: cmd.error }, 422);

  const db = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u, error: uErr } = await db.auth.getUser();
  if (uErr || !u?.user) return json({ ok: false, code: "unauthorized" }, 401);

  const c = cmd.value;
  let res: { data: unknown; error: { code?: string; message?: string } | null };
  switch (c.action) {
    case "create":
      res = await db.rpc("switching_request_create", { p_target_provider: c.targetProvider, p_notes: c.notes });
      break;
    case "cancel":
      res = await db.rpc("switching_request_cancel", { p_id: c.id, p_note: c.note });
      break;
    case "advance":
      res = await db.rpc("switching_request_advance", { p_id: c.id, p_to: c.to, p_note: c.note });
      break;
    case "overdue":
      res = await db.rpc("switching_requests_overdue");
      break;
    case "list":
      // RLS returns only this account's rows (or all rows for staff).
      res = await db.from("switching_requests")
        .select("id, reference, status, target_provider, requested_at, acknowledge_due_at, export_due_at, acknowledged_at, export_ready_at, completed_at, retrieval_ends_at, cancelled_at")
        .order("requested_at", { ascending: false }).limit(50);
      break;
  }
  if (res.error) {
    const e = mapRpcError(res.error);
    if (e.status === 500) console.error(JSON.stringify({ event: "switching_request_failed", action: c.action, error: res.error.message }));
    return json({ ok: false, code: e.code, message: e.message }, e.status);
  }
  if ((c.action === "cancel" || c.action === "advance") && res.data === false) return json({ ok: false, code: "not_found", message: "Request not found or not changeable." }, 404);
  return json({ ok: true, data: res.data });
});
