// supabase/functions/data-platform-run/index.ts
//
// Runs warehouse syncs, reverse-ETL pushes and the daily metric snapshot.
//
//   { action: "run", destination_id, full?: boolean }  user JWT  -> 202 { run_id }   "Sync now"
//   { action: "snapshots" }                            user JWT  -> { rows }          refresh metric history (last 90 days)
//   { action: "cron" } + header X-Cron-Secret                    -> 202               due destinations + housekeeping
//
// Schedule with the pg_cron snippet at the bottom of migration 20271102000000_data_platform.sql.
// Required secrets: DATA_PLATFORM_ENCRYPTION_KEY, CRON_SECRET (see docs/DATA_PLATFORM.md).
// Deploy: supabase functions deploy data-platform-run --no-verify-jwt
//   (cron calls it with X-Cron-Secret and no JWT; every other action verifies the user's JWT in code.)

import { adminClient, authenticate, corsHeaders, isCron, json, type Admin } from "../_shared/data-platform/http.ts";
import {
  FULL_REFRESH_EVERY_MS, RUN_BUDGET_MS, refreshSnapshots, runReverseEtl, runWarehouseSync, warehouseSettings,
  type Destination, type RunResult,
} from "../_shared/data-platform/runner.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ensureSnapshots(admin: Admin, ownerId: string): Promise<void> {
  const { data } = await admin.from("metric_snapshots").select("computed_at").eq("user_id", ownerId).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const age = data?.computed_at ? Date.now() - Date.parse(data.computed_at as string) : Infinity;
  if (age > 6 * 3600_000) await refreshSnapshots(admin, ownerId, data ? 3 : 90);
}

async function execute(admin: Admin, dest: Destination, trigger: "manual" | "scheduled", forceFull: boolean, runId: string): Promise<void> {
  let result: RunResult;
  try {
    if (dest.role === "warehouse") {
      if (warehouseSettings(dest.settings).datasets.includes("metrics_daily")) await ensureSnapshots(admin, dest.user_id).catch((e) => console.warn("[dp-run] snapshots:", e));
      const { data: st } = await admin.from("dp_sync_state").select("last_full_refresh_at").eq("destination_id", dest.id);
      const lastFull = (st ?? []).map((r: { last_full_refresh_at: string | null }) => (r.last_full_refresh_at ? Date.parse(r.last_full_refresh_at) : 0));
      const stale = !lastFull.length || Math.min(...lastFull) < Date.now() - FULL_REFRESH_EVERY_MS;
      const full = forceFull || (trigger === "scheduled" && stale && lastFull.length > 0);
      if (full) await admin.from("dp_runs").update({ mode: "full" }).eq("id", runId);
      result = await runWarehouseSync(admin, dest, { full, deadline: Date.now() + RUN_BUDGET_MS });
    } else {
      result = await runReverseEtl(admin, dest);
    }
  } catch (e) {
    result = { status: "failed", stats: {}, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
  }

  const now = new Date();
  const failed = result.status === "failed";
  const failures = failed ? dest.consecutive_failures + 1 : 0;
  const delayMin = failed ? Math.min(dest.interval_minutes * 2 ** Math.min(failures, 5), 1440) : dest.interval_minutes;
  await admin.from("dp_runs").update({ status: result.status, stats: result.stats, error: result.error, finished_at: now.toISOString() }).eq("id", runId);
  await admin.from("dp_destinations").update({
    status: failed ? "error" : "connected",
    last_run_at: now.toISOString(),
    ...(failed ? {} : { last_success_at: now.toISOString() }),
    last_error: result.error,
    consecutive_failures: failures,
    next_run_at: result.status === "partial" ? now.toISOString() : new Date(now.getTime() + delayMin * 60_000).toISOString(),
    locked_until: null,
  }).eq("id", dest.id);
}

async function start(admin: Admin, dest: Destination, trigger: "manual" | "scheduled", full: boolean): Promise<string> {
  const { data: run } = await admin.from("dp_runs").insert({ user_id: dest.user_id, destination_id: dest.id, trigger, mode: dest.role === "reverse" ? "reverse" : full ? "full" : "incremental" }).select("id").single();
  const runId = run!.id as string;
  const task = execute(admin, dest, trigger, full, runId).catch((e) => console.error("[dp-run] execute failed:", e));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task); else await task;
  return runId;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine for cron */ }
  const admin = adminClient();

  try {
    if (body.action === "cron") {
      if (!isCron(req)) return json({ error: "Forbidden" }, 403);
      const work = (async () => {
        await admin.from("dp_embed_requests").delete().lt("at", new Date(Date.now() - 2 * 86_400_000).toISOString());
        await admin.from("dp_runs").delete().lt("started_at", new Date(Date.now() - 60 * 86_400_000).toISOString());
        const { data: due } = await admin.rpc("dp_claim_due", { p_limit: 4 });
        for (const d of (due ?? []) as Destination[]) {
          const { data: run } = await admin.from("dp_runs").insert({ user_id: d.user_id, destination_id: d.id, trigger: "scheduled", mode: d.role === "reverse" ? "reverse" : "incremental" }).select("id").single();
          await execute(admin, d, "scheduled", false, run!.id as string);
        }
      })().catch((e) => console.error("[dp-run] cron failed:", e));
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
      return json({ ok: true }, 202);
    }

    const a = await authenticate(req);
    if (!a.ok) return a.res;
    const { caller } = a;

    if (body.action === "snapshots") {
      if (!caller.canViewBilling && !caller.canManage) return json({ error: "Permission required." }, 403);
      const { data } = await admin.from("metric_snapshots").select("computed_at").eq("user_id", caller.ownerId).order("computed_at", { ascending: false }).limit(1).maybeSingle();
      if (data?.computed_at && Date.now() - Date.parse(data.computed_at as string) < 5 * 60_000) return json({ rows: 0, skipped: true });
      return json({ rows: await refreshSnapshots(admin, caller.ownerId, 90) });
    }

    if (body.action === "run") {
      if (!caller.canManage) return json({ error: "You do not have permission to run syncs." }, 403);
      const id = typeof body.destination_id === "string" && UUID_RE.test(body.destination_id) ? body.destination_id : null;
      if (!id) return json({ error: "Invalid destination." }, 400);
      const nowIso = new Date().toISOString();
      const { data: claimed } = await admin.from("dp_destinations")
        .update({ locked_until: new Date(Date.now() + 10 * 60_000).toISOString() })
        .eq("id", id).eq("user_id", caller.ownerId).or(`locked_until.is.null,locked_until.lt.${nowIso}`).select("*").maybeSingle();
      if (!claimed) {
        const { data: exists } = await admin.from("dp_destinations").select("id").eq("id", id).eq("user_id", caller.ownerId).maybeSingle();
        return exists ? json({ error: "A sync is already running for this destination." }, 409) : json({ error: "Destination not found." }, 404);
      }
      const runId = await start(admin, claimed as Destination, "manual", body.full === true);
      return json({ run_id: runId }, 202);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    console.error("[data-platform-run]", err instanceof Error ? err.message : err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
