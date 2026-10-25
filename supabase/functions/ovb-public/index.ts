// supabase/functions/ovb-public/index.ts
//
// Public (no-JWT) endpoint of the Open Voice Benchmark.
//   { action: "catalog", version? }                      -> public scenarios + rubric + profile (for the open harness)
//   { action: "recording", run_id, scenario_key }        -> 1h signed URL (published runs with public recordings only)
//   { action: "submit_bundle" } + Authorization: Bearer <submission token> + body bundle  -> vendor-submitted run
// Deploy: supabase functions deploy ovb-public --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { createRun } from "../_shared/ovb/runtime.ts";
import { BUNDLE_LIMITS, parseBundle, sha256Hex, type ScenarioDef } from "../_shared/ovb/logic.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const raw = await req.text();
  if (raw.length > BUNDLE_LIMITS.maxBytes) return json({ error: "PAYLOAD_TOO_LARGE" }, 413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }

  try {
    if (body.action === "catalog") {
      const { data, error } = await admin.rpc("ovb_public_catalog", { p_version: typeof body.version === "string" ? body.version : null });
      if (error) throw error;
      return json(data);
    }

    if (body.action === "recording") {
      if (typeof body.run_id !== "string" || !UUID.test(body.run_id) || typeof body.scenario_key !== "string") return json({ error: "NOT_FOUND" }, 404);
      const { data: run } = await admin.from("ovb_runs").select("id, suite_id, agent_id, visibility").eq("id", body.run_id).in("visibility", ["public", "retracted"]).maybeSingle();
      if (!run) return json({ error: "NOT_FOUND" }, 404);
      const [{ data: agent }, { data: suite }, { data: sc }] = await Promise.all([
        admin.from("ovb_agents").select("listing_status").eq("id", run.agent_id).single(),
        admin.from("ovb_suites").select("held_out_revealed_at").eq("id", run.suite_id).single(),
        admin.from("ovb_scenarios").select("id, is_held_out").eq("suite_id", run.suite_id).eq("scenario_key", body.scenario_key).maybeSingle(),
      ]);
      if (agent?.listing_status !== "listed" || !sc || (sc.is_held_out && !suite?.held_out_revealed_at)) return json({ error: "NOT_FOUND" }, 404);
      const { data: rr } = await admin.from("ovb_run_results").select("recording_path, recording_public").eq("run_id", run.id).eq("scenario_id", sc.id).maybeSingle();
      if (!rr?.recording_public || !rr.recording_path) return json({ error: "NOT_FOUND" }, 404);
      const { data: signed } = await admin.storage.from("ovb-recordings").createSignedUrl(rr.recording_path, 3600);
      return signed?.signedUrl ? json({ url: signed.signedUrl, expires_in: 3600 }) : json({ error: "NOT_FOUND" }, 404);
    }

    if (body.action === "submit_bundle") {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!/^ovb_sub_[0-9a-f]{40}$/.test(token)) return json({ error: "UNAUTHORIZED" }, 401);
      const { data: sub } = await admin.from("ovb_submissions").select("id, agent_id, status, wants_bundle").eq("token_hash", await sha256Hex(token)).maybeSingle();
      if (!sub || sub.status !== "approved" || !sub.agent_id || !sub.wants_bundle) return json({ error: "UNAUTHORIZED" }, 401);
      const { count } = await admin.from("ovb_runs").select("id", { count: "exact", head: true }).eq("submission_id", sub.id).gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
      if ((count ?? 0) >= 1) return json({ error: "RATE_LIMITED", message: "One bundle per submission per 24 hours." }, 429);

      const { data: suite } = await admin.from("ovb_suites").select("id, version, public_manifest_hash").eq("status", "published").order("published_at", { ascending: false }).limit(1).maybeSingle();
      if (!suite) return json({ error: "NO_PUBLISHED_SUITE" }, 409);
      const { data: scenarios } = await admin.from("ovb_scenarios").select("scenario_key, turns, acoustic").eq("suite_id", suite.id).eq("is_held_out", false);
      const parsed = parseBundle(body.bundle ?? body, { version: suite.version, manifestHash: suite.public_manifest_hash ?? "", scenarios: (scenarios ?? []) as unknown as ScenarioDef[] });
      if (!parsed.ok) return json({ error: "INVALID_BUNDLE", details: parsed.errors }, 422);
      const { data: agent } = await admin.from("ovb_agents").select("slug").eq("id", sub.agent_id).single();
      const { runId } = await createRun(admin, { agentSlug: agent!.slug, suiteVersion: suite.version, purpose: "certification", includeHeldOut: false, bundle: parsed.bundle, submissionId: sub.id });
      return json({ run_id: runId, status: "queued_for_scoring", note: "Scoring and human review follow; publication needs your listing consent and staff approval." }, 202);
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("[ovb-public]", e instanceof Error ? e.message : e);
    return json({ error: "Internal error" }, 500);
  }
});
