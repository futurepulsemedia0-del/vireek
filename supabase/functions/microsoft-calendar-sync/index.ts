// Two-way Microsoft 365 / Outlook sync.
//   Outlook -> Vireek : busy/free (calendarView delta) into calendar_busy_blocks, plus reschedules/deletes of job events.
//   Vireek  -> Outlook: job events (create / update / delete) on the technician's and the office calendar.
//
// Callers
//   - pg_cron every 5 minutes with the service-role key (syncs every connected calendar), see the migration header.
//   - The signed-in user ("Sync now" and right after connecting): body { connection_id?: string }.
// Deploy: supabase functions deploy microsoft-calendar-sync

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  buildEventPayload, classifyJob, createTransactionId, hashPayload, MAX_CONSECUTIVE_FAILURES, needsRebaseline,
  normalizeTenant, parseRemoteEvent, planInboundChanges, planPushActions, syncWindow, timingSafeEqual, toBusyBlock, toGraphDateTime,
  type ConnectionInfo, type DesiredEvent, type EventMapRow, type InboundMapEntry, type RemoteEvent, type SyncJob,
} from "../_shared/microsoft-calendar/engine.ts";
import { resolveActorFromJwt } from "../_shared/microsoft-calendar/actor.ts";
import { ensureAccessToken, GraphError, graphRequest, type MsConfig } from "../_shared/microsoft-calendar/graph.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const LOCK_MS = 4 * 60 * 1000;
const BUDGET_MS = 100_000;
const CRON_BATCH = 25;
const JOB_COLUMNS = "id, customer_name, customer_phone, service_type, address, scheduled_datetime, duration_minutes, assigned_technician_id, job_status, dispatch_note";
const FAILURE_KEYS = ["error_code", "error_message", "failed_at", "provider_status", "recovery_hint"];

interface Conn {
  id: string; account_owner_id: string; team_member_id: string | null; scope: "office" | "technician";
  ms_calendar_id: string; status: string; delta_link: string | null; delta_window_end: string | null; consecutive_failures: number;
}
interface RunResult {
  connection_id: string;
  status: "ok" | "partial" | "busy" | "needs_reconnect" | "error";
  created: number; updated: number; deleted: number; blocks: number; reschedules: number; failed: number;
  error_code?: string;
}

const chunk = <T,>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const isCron = !!bearer && !!serviceKey && timingSafeEqual(bearer, serviceKey);
    const body = await req.json().catch(() => ({}));
    const connectionId = typeof body?.connection_id === "string" ? body.connection_id : null;

    let query = admin.from("microsoft_calendar_connections")
      .select("id, account_owner_id, team_member_id, scope, ms_calendar_id, status, delta_link, delta_window_end, consecutive_failures");
    if (isCron) {
      query = query.eq("status", "connected").order("last_synced_at", { ascending: true, nullsFirst: true }).limit(CRON_BATCH);
      if (connectionId) query = query.eq("id", connectionId);
    } else {
      const actor = await resolveActorFromJwt(admin, bearer);
      if (!actor) return json({ error: "Invalid or expired session." }, 401);
      query = query.eq("account_owner_id", actor.accountOwnerId).neq("status", "disconnected");
      if (connectionId) query = query.eq("id", connectionId);
      if (!actor.canManage) query = query.eq("user_id", actor.userId);
    }
    const { data: conns, error } = await query;
    if (error) throw new Error(error.message);

    const cfg: MsConfig = {
      tenant: normalizeTenant(Deno.env.get("MICROSOFT_CALENDAR_TENANT_ID")),
      clientId: Deno.env.get("MICROSOFT_CALENDAR_CLIENT_ID") ?? "",
      clientSecret: Deno.env.get("MICROSOFT_CALENDAR_CLIENT_SECRET") ?? "",
    };
    const appUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

    const started = Date.now();
    const results: RunResult[] = [];
    for (const conn of (conns ?? []) as Conn[]) {
      if (Date.now() - started > BUDGET_MS) break;
      results.push(await syncConnection(admin, conn, cfg, appUrl));
    }
    return json({ results });
  } catch (error) {
    console.error(JSON.stringify({ event: "ms_calendar_sync_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Microsoft 365 sync failed." }, 500);
  }
});

async function syncConnection(admin: SupabaseClient, conn: Conn, cfg: MsConfig, appUrl: string): Promise<RunResult> {
  const result: RunResult = { connection_id: conn.id, status: "ok", created: 0, updated: 0, deleted: 0, blocks: 0, reschedules: 0, failed: 0 };
  if (conn.status !== "connected") return { ...result, status: "needs_reconnect" };

  // Atomic lock so cron and a manual "Sync now" never run the same connection concurrently
  // (refresh tokens rotate, so two parallel refreshes would invalidate each other).
  const now = new Date();
  const { data: locked } = await admin.from("microsoft_calendar_connections")
    .update({ sync_locked_until: new Date(now.getTime() + LOCK_MS).toISOString() })
    .eq("id", conn.id)
    .or(`sync_locked_until.is.null,sync_locked_until.lt.${now.toISOString()}`)
    .select("id");
  if (!locked?.length) return { ...result, status: "busy" };

  try {
    const token = await ensureAccessToken(admin, conn.id, cfg);
    const info: ConnectionInfo = { scope: conn.scope, teamMemberId: conn.team_member_id };

    const { data: mapData, error: mapError } = await admin.from("microsoft_calendar_event_map")
      .select("job_id, ms_event_id, hash, status, last_pushed_at").eq("connection_id", conn.id);
    if (mapError) throw new Error(mapError.message);
    const mapRows = new Map<string, { jobId: string; msEventId: string; hash: string; status: "synced" | "remote_deleted"; lastPushedAt: Date | null }>(
      (mapData ?? []).map((m) => [m.job_id, { jobId: m.job_id, msEventId: m.ms_event_id, hash: m.hash, status: m.status, lastPushedAt: m.last_pushed_at ? new Date(m.last_pushed_at) : null }]),
    );

    // ---- 1. Outlook -> Vireek --------------------------------------------------------------
    const pulled = await pullDelta(token, conn, now);
    const mapByEventId = new Map<string, InboundMapEntry>([...mapRows.values()].map((m) => [m.msEventId, { jobId: m.jobId, status: m.status, lastPushedAt: m.lastPushedAt }]));
    const mappedJobIds = [...new Set(pulled.events.map((e) => mapByEventId.get(e.id)?.jobId).filter((x): x is string => !!x))];
    const jobsById = await fetchJobsByIds(admin, conn.account_owner_id, mappedJobIds);
    const inbound = planInboundChanges(pulled.events, mapByEventId, jobsById);
    const forceUpdate = inbound.forceUpdateJobIds;

    for (const change of inbound.changes) {
      if (change.kind === "remote_deleted") {
        await admin.from("microsoft_calendar_event_map").update({ status: "remote_deleted" }).eq("connection_id", conn.id).eq("job_id", change.jobId);
        const row = mapRows.get(change.jobId);
        if (row) row.status = "remote_deleted";
        continue;
      }
      // Optimistic update: only if the job still has the time we planned from and is still "scheduled".
      const { data: updated } = await admin.from("jobs")
        .update({ scheduled_datetime: change.newStart, duration_minutes: change.durationMinutes })
        .eq("id", change.jobId).eq("user_id", conn.account_owner_id).eq("job_status", "scheduled").eq("scheduled_datetime", change.expectedStart)
        .select("id");
      if (updated?.length) {
        result.reschedules++;
        const job = jobsById.get(change.jobId);
        if (job) { job.scheduled_datetime = change.newStart; job.duration_minutes = change.durationMinutes; }
      } else forceUpdate.add(change.jobId); // job changed meanwhile: Vireek wins
    }

    result.blocks = await applyBusyBlocks(admin, conn, pulled, new Set([...mapRows.values()].map((m) => m.msEventId)), now);

    // ---- 2. Vireek -> Outlook --------------------------------------------------------------
    const jobs = await fetchJobsForPush(admin, conn, info, [...mapRows.keys()], jobsById, now);
    const desired: DesiredEvent[] = [];
    const removeJobIds: string[] = [];
    for (const [jobId, job] of jobs) {
      const disposition = classifyJob(job, info, now);
      if (disposition === "remove") removeJobIds.push(jobId);
      else if (disposition === "sync") {
        const payload = buildEventPayload(job!, appUrl);
        if (payload) desired.push({ jobId, hash: await hashPayload(payload), payload });
      }
    }
    for (const jobId of mapRows.keys()) if (!jobs.has(jobId)) removeJobIds.push(jobId); // job hard-deleted

    const actions = planPushActions({
      desired, removeJobIds,
      mapped: [...mapRows.values()].map<EventMapRow>((m) => ({ jobId: m.jobId, msEventId: m.msEventId, hash: m.hash, status: m.status })),
      forceUpdate,
    });

    for (const action of actions) {
      try {
        if (action.kind === "create") {
          const created = await graphRequest<{ id: string }>(token, `/me/calendars/${encodeURIComponent(conn.ms_calendar_id)}/events`, {
            method: "POST", body: { ...action.payload, transactionId: createTransactionId(action.jobId, conn.id) },
          });
          if (!created?.id) throw new GraphError("Create returned no id.", 502, undefined);
          await admin.from("microsoft_calendar_event_map").upsert(
            { connection_id: conn.id, job_id: action.jobId, ms_event_id: created.id, hash: action.hash, status: "synced", last_pushed_at: new Date().toISOString() },
            { onConflict: "connection_id,job_id" },
          );
          result.created++;
        } else if (action.kind === "update") {
          try {
            await graphRequest(token, `/me/events/${encodeURIComponent(action.msEventId)}`, { method: "PATCH", body: action.payload });
            await admin.from("microsoft_calendar_event_map").update({ hash: action.hash, status: "synced", last_pushed_at: new Date().toISOString() })
              .eq("connection_id", conn.id).eq("job_id", action.jobId);
            result.updated++;
          } catch (e) {
            if (!(e instanceof GraphError) || e.status !== 404) throw e;
            // Deleted in Outlook before we saw it: respect that until the job changes again.
            await admin.from("microsoft_calendar_event_map").update({ status: "remote_deleted", hash: action.hash }).eq("connection_id", conn.id).eq("job_id", action.jobId);
          }
        } else if (action.kind === "delete") {
          try { await graphRequest(token, `/me/events/${encodeURIComponent(action.msEventId)}`, { method: "DELETE" }); }
          catch (e) { if (!(e instanceof GraphError) || e.status !== 404) throw e; }
          await admin.from("microsoft_calendar_event_map").delete().eq("connection_id", conn.id).eq("job_id", action.jobId);
          result.deleted++;
        } else {
          await admin.from("microsoft_calendar_event_map").delete().eq("connection_id", conn.id).eq("job_id", action.jobId);
        }
      } catch (e) {
        // Auth/permission problems affect every remaining action: stop and surface them.
        if (e instanceof GraphError && (e.status === 401 || e.status === 403)) throw e;
        result.failed++;
        console.error(JSON.stringify({ event: "ms_calendar_push_action_failed", connection_id: conn.id, kind: action.kind, job_id: action.jobId, error: e instanceof Error ? e.message : String(e) }));
      }
    }

    if (result.failed > 0 || actions.length >= 80) result.status = "partial";

    await admin.from("microsoft_calendar_connections").update({
      delta_link: pulled.deltaLink,
      delta_window_end: pulled.deltaLink ? syncWindow(now).end.toISOString() : null,
      last_synced_at: new Date().toISOString(),
      last_error_code: null, last_error_message: null, consecutive_failures: 0, status: "connected",
    }).eq("id", conn.id);
    if (conn.scope === "office") await setOfficeIntegration(admin, conn.account_owner_id, { healthy: true });
    return result;
  } catch (e) {
    return await recordFailure(admin, conn, result, e);
  } finally {
    await admin.from("microsoft_calendar_connections").update({ sync_locked_until: null }).eq("id", conn.id);
  }
}

async function recordFailure(admin: SupabaseClient, conn: Conn, result: RunResult, e: unknown): Promise<RunResult> {
  const failure = e instanceof GraphError ? e.failure : { errorCode: "unknown", recoverable: true, resetDelta: false };
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  const consecutive = conn.consecutive_failures + 1;
  const dead = !failure.recoverable || consecutive >= MAX_CONSECUTIVE_FAILURES;
  console.error(JSON.stringify({ event: "ms_calendar_sync_connection_failed", connection_id: conn.id, error_code: failure.errorCode, dead, error: message }));

  await admin.from("microsoft_calendar_connections").update({
    last_error_code: failure.errorCode, last_error_message: message, consecutive_failures: consecutive,
    status: dead ? "error" : "connected",
    ...(failure.resetDelta ? { delta_link: null, delta_window_end: null } : {}),
  }).eq("id", conn.id);
  if (dead && conn.scope === "office") await setOfficeIntegration(admin, conn.account_owner_id, { healthy: false, errorCode: failure.errorCode, message });
  return { ...result, status: dead ? "needs_reconnect" : "error", error_code: failure.errorCode };
}

/** Keeps the Integrations card honest: error -> recovery banner; healthy again -> cleared. Same config keys as integrationRecovery.ts. */
async function setOfficeIntegration(admin: SupabaseClient, owner: string, s: { healthy: boolean; errorCode?: string; message?: string }) {
  const { data: row } = await admin.from("integrations").select("id, status, config").eq("user_id", owner).eq("integration_type", "microsoft_calendar").maybeSingle();
  if (!row) return;
  const config = { ...(row.config ?? {}) } as Record<string, unknown>;
  if (s.healthy) {
    if (row.status !== "error") return;
    for (const k of FAILURE_KEYS) delete config[k];
    await admin.from("integrations").update({ status: "connected", config }).eq("id", row.id);
  } else {
    await admin.from("integrations").update({
      status: "error",
      config: { ...config, error_code: s.errorCode, error_message: s.message, failed_at: new Date().toISOString(), recovery_hint: "Reconnect Microsoft 365" },
    }).eq("id", row.id);
  }
}

async function pullDelta(token: string, conn: Conn, now: Date, forceRebase = false): Promise<{ events: RemoteEvent[]; deltaLink: string | null; complete: boolean; rebased: boolean }> {
  const win = syncWindow(now);
  const rebase = forceRebase || needsRebaseline({ deltaLink: conn.delta_link, windowEnd: conn.delta_window_end }, now);
  let url = rebase
    ? `/me/calendars/${encodeURIComponent(conn.ms_calendar_id)}/calendarView/delta?startDateTime=${encodeURIComponent(win.start.toISOString())}&endDateTime=${encodeURIComponent(win.end.toISOString())}`
    : conn.delta_link!;
  const events: RemoteEvent[] = [];
  let deltaLink: string | null = null;
  let complete = false;
  try {
    for (let page = 0; page < 50; page++) {
      const res = await graphRequest<Record<string, any>>(token, url, { prefer: "odata.maxpagesize=100" });
      for (const raw of res?.value ?? []) { const ev = parseRemoteEvent(raw); if (ev) events.push(ev); }
      if (res?.["@odata.nextLink"]) url = res["@odata.nextLink"];
      else { deltaLink = res?.["@odata.deltaLink"] ?? null; complete = !!deltaLink; break; }
    }
  } catch (e) {
    if (e instanceof GraphError && e.failure.resetDelta && !rebase) return pullDelta(token, conn, now, true); // delta token expired
    throw e;
  }
  return { events, deltaLink: complete ? deltaLink : null, complete, rebased: rebase };
}

async function applyBusyBlocks(
  admin: SupabaseClient, conn: Conn,
  pulled: { events: RemoteEvent[]; complete: boolean; rebased: boolean },
  vireekEventIds: Set<string>, now: Date,
): Promise<number> {
  const runAt = new Date().toISOString();
  const upserts: Record<string, unknown>[] = [];
  const removals: string[] = [];
  for (const ev of pulled.events) {
    const block = toBusyBlock(ev, vireekEventIds);
    if (!block) { removals.push(ev.id); continue; }
    upserts.push({
      account_owner_id: conn.account_owner_id, connection_id: conn.id, team_member_id: conn.team_member_id, ms_event_id: block.msEventId,
      starts_at: block.startsAt, ends_at: block.endsAt, show_as: block.showAs, is_all_day: block.isAllDay, blocking: block.blocking, updated_at: runAt,
    });
  }
  for (const part of chunk(upserts, 200)) {
    const { error } = await admin.from("calendar_busy_blocks").upsert(part, { onConflict: "connection_id,ms_event_id" });
    if (error) throw new Error(error.message);
  }
  for (const part of chunk(removals, 100)) await admin.from("calendar_busy_blocks").delete().eq("connection_id", conn.id).in("ms_event_id", part);
  // A full re-baseline saw every live event: anything not touched this run no longer exists in Outlook.
  if (pulled.rebased && pulled.complete) await admin.from("calendar_busy_blocks").delete().eq("connection_id", conn.id).lt("updated_at", runAt);
  await admin.from("calendar_busy_blocks").delete().eq("connection_id", conn.id).lt("ends_at", new Date(now.getTime() - 2 * 86_400_000).toISOString());
  return upserts.length;
}

async function fetchJobsByIds(admin: SupabaseClient, owner: string, ids: string[]): Promise<Map<string, SyncJob>> {
  const out = new Map<string, SyncJob>();
  for (const part of chunk(ids, 100)) {
    const { data } = await admin.from("jobs").select(JOB_COLUMNS).eq("user_id", owner).in("id", part);
    for (const j of (data ?? []) as SyncJob[]) out.set(j.id, j);
  }
  return out;
}

/** Upcoming jobs for this calendar + every job we already mapped (so cancelled/reassigned/moved ones get cleaned up). */
async function fetchJobsForPush(
  admin: SupabaseClient, conn: Conn, _info: ConnectionInfo, mappedIds: string[], known: Map<string, SyncJob>, now: Date,
): Promise<Map<string, SyncJob | null>> {
  const out = new Map<string, SyncJob | null>();
  let q = admin.from("jobs").select(JOB_COLUMNS).eq("user_id", conn.account_owner_id)
    .not("scheduled_datetime", "is", null).gte("scheduled_datetime", toGraphDateTime(syncWindow(now).start) + "Z")
    .order("scheduled_datetime", { ascending: true }).limit(1000);
  if (conn.scope === "technician") q = q.eq("assigned_technician_id", conn.team_member_id);
  const { data } = await q;
  for (const j of (data ?? []) as SyncJob[]) out.set(j.id, j);
  const missing = mappedIds.filter((id) => !out.has(id));
  const fromKnown = missing.filter((id) => known.has(id));
  for (const id of fromKnown) out.set(id, known.get(id)!);
  const rest = await fetchJobsByIds(admin, conn.account_owner_id, missing.filter((id) => !known.has(id)));
  for (const [id, j] of rest) out.set(id, j);
  return out;
}
