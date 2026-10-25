// supabase/functions/ovb-run/index.ts
//
// Open Voice Benchmark orchestrator. Staff JWT (profiles.is_staff) OR X-Cron-Secret.
// Resumable: call "start" once, then "continue" (or "tick") until remaining = 0.
//   { action: "start", agent_slug?, suite_version?, purpose?, include_held_out?, agent_version?, vendor_secret?, budget_seconds? }
//   { action: "continue", run_id, vendor_secret?, budget_seconds? }
//   { action: "tick", budget_seconds? }                  -> advances open runs (bundles, phone, first-party)
//   { action: "finalize", run_id }                       -> recompute scores (after human reviews)
//   { action: "sync_mirror", suite_version, account_id? } -> mirror public scenarios into the eval plane
//   { action: "status", run_id }
// Deploy: supabase functions deploy ovb-run --no-verify-jwt   (auth is checked in here)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { countOpen, createRun, finalizeRun, processRun, syncEvalMirror } from "../_shared/ovb/runtime.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const budget = (v: unknown, d = 90) => Math.min(120, Math.max(20, Number(v) || d)) * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  // --- auth: cron secret or staff -------------------------------------------------
  let userId: string | null = null;
  const cron = Deno.env.get("CRON_SECRET");
  const sent = req.headers.get("x-cron-secret") ?? "";
  if (!(cron && sent && safeEqual(sent, cron))) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "Invalid session" }, 401);
    const { data: prof } = await admin.from("profiles").select("is_staff").eq("id", user.id).maybeSingle();
    if (!prof?.is_staff) return json({ error: "Staff only" }, 403);
    userId = user.id;
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  try {
    switch (body.action) {
      case "start": {
        const slug = typeof body.agent_slug === "string" ? body.agent_slug : "vireek";
        const purpose = body.purpose === "regression" ? "regression" : "certification";
        const { data: agent } = await admin.from("ovb_agents").select("interface_kind, api_base_url, phone_number, is_first_party").eq("slug", slug).maybeSingle();
        if (!agent) return json({ error: "Unknown agent" }, 404);
        if (agent.interface_kind === "api" && (typeof body.vendor_secret !== "string" || !body.vendor_secret || !agent.api_base_url)) return json({ error: "API agents need vendor_secret and an api_base_url" }, 400);
        if (agent.interface_kind === "phone" && !agent.phone_number) return json({ error: "Phone agents need a phone number" }, 400);
        if (agent.interface_kind === "harness") return json({ error: "Harness agents submit bundles via ovb-public" }, 400);
        const includeHeldOut = typeof body.include_held_out === "boolean" ? body.include_held_out : purpose === "certification";
        const { runId, scenarioCount } = await createRun(admin, {
          agentSlug: slug, suiteVersion: typeof body.suite_version === "string" ? body.suite_version : undefined, purpose, includeHeldOut,
          agentVersion: typeof body.agent_version === "string" ? body.agent_version : undefined, triggeredBy: userId,
        });
        const r = await processRun(admin, runId, { budgetMs: budget(body.budget_seconds), vendorSecret: typeof body.vendor_secret === "string" ? body.vendor_secret : undefined });
        return json({ ...r, scenarioCount });
      }
      case "continue": {
        if (typeof body.run_id !== "string" || !UUID.test(body.run_id)) return json({ error: "run_id required" }, 400);
        return json(await processRun(admin, body.run_id, { budgetMs: budget(body.budget_seconds), vendorSecret: typeof body.vendor_secret === "string" ? body.vendor_secret : undefined }));
      }
      case "tick": {
        const { data: runs } = await admin.from("ovb_runs").select("id, agent_id").eq("visibility", "private").in("status", ["queued", "running"]).order("started_at").limit(5);
        const { data: agents } = await admin.from("ovb_agents").select("id, interface_kind").in("id", (runs ?? []).map((r) => r.agent_id));
        const kind = new Map((agents ?? []).map((a) => [a.id, a.interface_kind]));
        const total = budget(body.budget_seconds);
        const started = Date.now();
        const out = [];
        for (const r of runs ?? []) {
          if (kind.get(r.agent_id) === "api") continue; // needs the vendor secret, which is never stored
          const left = total - (Date.now() - started);
          if (left < 10000) break;
          out.push(await processRun(admin, r.id, { budgetMs: left }));
        }
        return json({ processed: out });
      }
      case "finalize": {
        if (typeof body.run_id !== "string" || !UUID.test(body.run_id)) return json({ error: "run_id required" }, 400);
        return json(await finalizeRun(admin, body.run_id));
      }
      case "sync_mirror": {
        if (typeof body.suite_version !== "string") return json({ error: "suite_version required" }, 400);
        const account = typeof body.account_id === "string" ? body.account_id : userId;
        if (!account) return json({ error: "account_id required for cron calls" }, 400);
        return json(await syncEvalMirror(admin, body.suite_version, account, userId));
      }
      case "status": {
        if (typeof body.run_id !== "string" || !UUID.test(body.run_id)) return json({ error: "run_id required" }, 400);
        const { data: run } = await admin.from("ovb_runs").select("id, status, visibility, scores, scenario_count").eq("id", body.run_id).maybeSingle();
        if (!run) return json({ error: "Unknown run" }, 404);
        return json({ ...run, remaining: await countOpen(admin, run.id, true) });
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error("[ovb-run]", e instanceof Error ? e.message : e);
    return json({ error: e instanceof Error ? e.message.slice(0, 300) : "Internal error" }, 500);
  }
});
