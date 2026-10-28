// supabase/functions/siem-stream/index.ts
//
// SIEM log streaming (Splunk HEC / Datadog Logs) for enterprise security events.
//
// Callers
//   * Scheduler : POST {action:"cron"} with header X-Cron-Secret = SIEM_CRON_SECRET
//                 (see the scheduler snippet in 20271231010000_siem_log_streaming.sql)
//   * Dashboard : logged-in ACCOUNT OWNER on a Business/Enterprise plan:
//                 save | test | set_enabled | delete | deliver_now
//
// Delivery model (see migration header): per-destination (created_at, id) cursor over
// audit_log, at-least-once, cursor advances only after a successful send, lease-based
// locking so cron + "send now" never double-send, exponential backoff, and a safety
// valve so a misconfigured destination can never silently drop the backlog.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//                   SIEM_ENCRYPTION_KEY (32 bytes, base64), SIEM_CRON_SECRET
//
// Deploy: supabase functions deploy siem-stream --no-verify-jwt

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  DATADOG_SITES,
  MAX_BATCH_EVENTS,
  MAX_DESTINATIONS_PER_ACCOUNT,
  SEVERITIES,
  SIEM_PLANS,
  buildRequest,
  chunkBySize,
  classifyHttpStatus,
  datadogEndpoint,
  isPrivateIPv4,
  isValidSecret,
  isValidSourcetype,
  isValidSplunkIndex,
  meetsMinSeverity,
  nextAttemptDelayMs,
  sanitizeError,
  statusAfterFailure,
  syntheticTestEvent,
  toSiemEvent,
  validateSplunkUrl,
  type AuditRow,
  type DestinationConfig,
  type HttpClass,
  type Severity,
  type SiemEvent,
} from "../_shared/siem/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const FETCH_TIMEOUT_MS = 10_000;
const LEASE_SECONDS = 120;
const MAX_BATCHES_PER_RUN = 5;
const RUN_BUDGET_MS = 90_000;
const CRON_CONCURRENCY = 4;
const CRON_MAX_DESTINATIONS = 50;
const DROP_BUDGET_PER_RUN = 5;
const LOG_RETENTION_DAYS = 30;

interface DestinationRow extends DestinationConfig {
  id: string;
  user_id: string;
  name: string;
  min_severity: Severity;
  enabled: boolean;
  status: "active" | "degraded" | "failing" | "auth_failed";
  cursor_created_at: string;
  cursor_id: string;
  consecutive_failures: number;
  events_sent_total: number;
  events_dropped_total: number;
}

const DEST_COLUMNS =
  "id, user_id, name, provider, endpoint_url, datadog_site, splunk_index, splunk_sourcetype, min_severity, enabled, status, cursor_created_at, cursor_id, consecutive_failures, events_sent_total, events_dropped_total";

// ------------------------------------------------------------------
// Infra helpers
// ------------------------------------------------------------------

function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function isCron(req: Request): boolean {
  const secret = Deno.env.get("SIEM_CRON_SECRET");
  const given = req.headers.get("X-Cron-Secret");
  return !!secret && !!given && safeEqual(secret, given);
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("SIEM_ENCRYPTION_KEY");
  if (!raw) throw new Error("SIEM_ENCRYPTION_KEY is not configured.");
  const bytes = unb64(raw);
  if (bytes.length !== 32) throw new Error("SIEM_ENCRYPTION_KEY must be 32 bytes, base64 encoded.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), new TextEncoder().encode(plain)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

async function decryptSecret(enc: string): Promise<string> {
  const [v, iv, ct] = enc.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unsupported secret format.");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(), unb64(ct));
  return new TextDecoder().decode(pt);
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

/** DNS-rebinding guard (best effort: skipped silently if the runtime denies DNS lookups). */
async function resolvesToPrivate(host: string): Promise<boolean> {
  try {
    const [a, aaaa] = await Promise.all([
      Deno.resolveDns(host, "A").catch(() => [] as string[]),
      Deno.resolveDns(host, "AAAA").catch(() => [] as string[]),
    ]);
    return a.some((ip) => isPrivateIPv4(ip)) || aaaa.some((ip) => isPrivateIPv6(ip));
  } catch {
    return false;
  }
}

function hostOf(cfg: DestinationConfig): string {
  try {
    return cfg.provider === "splunk_hec" ? new URL(cfg.endpoint_url ?? "").hostname : `http-intake.logs.${cfg.datadog_site ?? ""}`;
  } catch {
    return "";
  }
}

async function authenticateOwner(db: SupabaseClient, req: Request): Promise<{ userId: string; plan: string } | Response> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Missing Authorization header" }, 401);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return json({ error: "Invalid or expired session" }, 401);
  const { data: prof } = await db.from("profiles").select("role, plan").eq("id", data.user.id).maybeSingle();
  if (!prof || prof.role !== "owner") return json({ error: "Only the account owner can manage SIEM streaming." }, 403);
  return { userId: data.user.id, plan: String(prof.plan ?? "") };
}

const planAllowed = (plan: string) => SIEM_PLANS.includes(plan);
const PLAN_ERROR = "SIEM log streaming requires a Business or Enterprise plan.";

async function audit(db: SupabaseClient, userId: string, action: string, targetId: string | null, metadata: Record<string, unknown>, actorEmail: string | null = null) {
  // Service role bypasses RLS; log_audit_event() would record a NULL actor here.
  const { error } = await db.from("audit_log").insert({
    user_id: userId,
    actor_id: actorEmail ? userId : null,
    actor_email: actorEmail,
    action,
    target_table: "siem_destinations",
    target_id: targetId,
    metadata,
  });
  if (error) console.error(JSON.stringify({ fn: "siem-stream", event: "audit_failed", action, message: error.message }));
}

// ------------------------------------------------------------------
// Sending
// ------------------------------------------------------------------

type SendResult =
  | { ok: true; sent: number; dropped: number; status: number }
  | { ok: false; klass: Exclude<HttpClass, "ok">; status: number; error: string };

async function postOnce(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, "User-Agent": "Vireek-SIEM/1.0" },
      body,
      signal: ctrl.signal,
      redirect: "manual", // never follow redirects (SSRF)
    });
    const text = (await res.text().catch(() => "")).slice(0, 300);
    return { status: res.status, text };
  } catch (err) {
    const msg = (err as Error)?.name === "AbortError" ? "Request timed out" : (err as Error)?.message ?? "Network error";
    return { status: 0, text: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends events; on a 400/413/422 it bisects to isolate a poison event. A per-run drop
 * budget stops this from ever discarding a backlog because of a systemic misconfiguration.
 */
async function sendEvents(cfg: DestinationConfig, secret: string, events: SiemEvent[], budget: { left: number }): Promise<SendResult> {
  const built = buildRequest(cfg, secret, events);
  if (!built) return { ok: false, klass: "auth", status: 0, error: "Destination configuration is invalid. Edit it and save again." };

  const { status, text } = await postOnce(built.url, built.headers, built.body);
  const klass: HttpClass = status === 0 ? "retry" : classifyHttpStatus(status);
  if (klass === "ok") return { ok: true, sent: events.length, dropped: 0, status };

  const poison = status === 400 || status === 413 || status === 422;
  if (klass === "permanent" && poison) {
    if (events.length === 1) {
      if (budget.left <= 0) return { ok: false, klass: "permanent", status, error: sanitizeError(`Destination keeps rejecting events (HTTP ${status}): ${text}`, secret) };
      budget.left -= 1;
      return { ok: true, sent: 0, dropped: 1, status };
    }
    const mid = Math.ceil(events.length / 2);
    const left = await sendEvents(cfg, secret, events.slice(0, mid), budget);
    if (!left.ok) return left;
    const right = await sendEvents(cfg, secret, events.slice(mid), budget);
    if (!right.ok) return right;
    return { ok: true, sent: left.sent + right.sent, dropped: left.dropped + right.dropped, status: right.status };
  }

  const detail = status === 0 ? text : `HTTP ${status}${text ? `: ${text}` : ""}`;
  // 404 / 3xx / 405 … are configuration problems: halt for attention instead of dropping data.
  return { ok: false, klass: klass === "permanent" ? "auth" : klass, status, error: sanitizeError(detail, secret) };
}

interface RunSummary {
  destinationId: string;
  ok: boolean;
  skipped?: "busy" | "missing";
  sent: number;
  dropped: number;
  error?: string;
}

async function recordFailure(db: SupabaseClient, dest: DestinationRow, klass: Exclude<HttpClass, "ok">, status: number, error: string, sent: number, dropped: number, durationMs: number) {
  const failures = dest.consecutive_failures + 1;
  const newStatus = statusAfterFailure(klass, failures);
  const now = new Date();
  await db
    .from("siem_destinations")
    .update({
      status: newStatus,
      consecutive_failures: failures,
      last_error: error,
      last_error_at: now.toISOString(),
      next_attempt_at: new Date(now.getTime() + nextAttemptDelayMs(failures)).toISOString(),
      lease_until: null,
      updated_at: now.toISOString(),
    })
    .eq("id", dest.id);
  await db.from("siem_delivery_log").insert({
    destination_id: dest.id,
    user_id: dest.user_id,
    kind: "delivery",
    status: "failed",
    event_count: sent,
    dropped_count: dropped,
    http_status: status || null,
    error,
    duration_ms: durationMs,
  });
  if ((newStatus === "failing" || newStatus === "auth_failed") && dest.status !== newStatus) {
    await audit(db, dest.user_id, "siem_destination_failing", dest.id, { name: dest.name, provider: dest.provider, status: newStatus, error });
  }
}

async function deliverDestination(db: SupabaseClient, dest: DestinationRow): Promise<RunSummary> {
  const started = Date.now();
  const fail = async (klass: Exclude<HttpClass, "ok">, status: number, error: string, sent = 0, dropped = 0): Promise<RunSummary> => {
    await recordFailure(db, dest, klass, status, error, sent, dropped, Date.now() - started);
    return { destinationId: dest.id, ok: false, sent, dropped, error };
  };

  // 1. Claim the lease (atomic: only one runner per destination).
  const nowIso = new Date(started).toISOString();
  const { data: claimed } = await db
    .from("siem_destinations")
    .update({ lease_until: new Date(started + LEASE_SECONDS * 1000).toISOString() })
    .eq("id", dest.id)
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .select("id");
  if (!claimed?.length) return { destinationId: dest.id, ok: true, skipped: "busy", sent: 0, dropped: 0 };

  try {
    // 2. Credentials + safety checks.
    const { data: secretRow } = await db.from("siem_destination_secrets").select("secret_enc").eq("destination_id", dest.id).maybeSingle();
    if (!secretRow) return await fail("auth", 0, "No credentials are stored for this destination. Edit it and enter the token again.");
    let secret: string;
    try {
      secret = await decryptSecret(secretRow.secret_enc as string);
    } catch {
      return await fail("auth", 0, "Stored credentials could not be read. Edit the destination and enter the token again.");
    }
    if (!buildRequest(dest, secret, [])) return await fail("auth", 0, "Destination configuration is invalid. Edit it and save again.");
    if (await resolvesToPrivate(hostOf(dest))) return await fail("auth", 0, "The destination host resolves to a private network address.");

    // 3. Drain batches.
    const budget = { left: DROP_BUDGET_PER_RUN };
    let sent = 0;
    let dropped = 0;
    let lastStatus = 0;

    for (let b = 0; b < MAX_BATCHES_PER_RUN && Date.now() - started < RUN_BUDGET_MS; b++) {
      const { data: rows, error } = await db.rpc("siem_fetch_batch", { p_destination_id: dest.id, p_limit: MAX_BATCH_EVENTS });
      if (error) return await fail("retry", 0, sanitizeError(`Could not read audit events: ${error.message}`, secret), sent, dropped);
      const batch = (rows ?? []) as AuditRow[];
      if (batch.length === 0) break;

      const items = batch.map((row) => {
        const event = toSiemEvent(row, dest.user_id);
        return { row, event, size: JSON.stringify(event).length + 300 };
      });

      for (const chunk of chunkBySize(items, (i) => i.size)) {
        const toSend = chunk.filter((i) => meetsMinSeverity(i.event.severity, dest.min_severity)).map((i) => i.event);
        if (toSend.length > 0) {
          const res = await sendEvents(dest, secret, toSend, budget);
          if (!res.ok) {
            // Cursor stays where the last fully delivered chunk ended: nothing is lost.
            return await fail(res.klass, res.status, res.error, sent, dropped);
          }
          sent += res.sent;
          dropped += res.dropped;
          lastStatus = res.status;
        }
        const last = chunk[chunk.length - 1].row;
        await db
          .from("siem_destinations")
          .update({
            cursor_created_at: last.created_at,
            cursor_id: last.id,
            events_sent_total: dest.events_sent_total + sent,
            events_dropped_total: dest.events_dropped_total + dropped,
            updated_at: new Date().toISOString(),
          })
          .eq("id", dest.id);
      }
      if (batch.length < MAX_BATCH_EVENTS) break;
    }

    // 4. Success bookkeeping.
    if (sent > 0 || dropped > 0) {
      const now = new Date().toISOString();
      await db
        .from("siem_destinations")
        .update({
          status: "active",
          consecutive_failures: 0,
          last_error: null,
          last_success_at: sent > 0 ? now : undefined,
          next_attempt_at: null,
          lease_until: null,
          updated_at: now,
        })
        .eq("id", dest.id);
      await db.from("siem_delivery_log").insert({
        destination_id: dest.id,
        user_id: dest.user_id,
        kind: "delivery",
        status: "ok",
        event_count: sent,
        dropped_count: dropped,
        http_status: lastStatus || null,
        duration_ms: Date.now() - started,
      });
    } else {
      await db.from("siem_destinations").update({ lease_until: null }).eq("id", dest.id);
    }
    return { destinationId: dest.id, ok: true, sent, dropped };
  } catch (err) {
    return await fail("retry", 0, sanitizeError(`Unexpected error: ${(err as Error)?.message ?? "unknown"}`, ""));
  }
}

// ------------------------------------------------------------------
// Actions
// ------------------------------------------------------------------

async function loadOwned(db: SupabaseClient, userId: string, id: unknown): Promise<DestinationRow | null> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await db.from("siem_destinations").select(DEST_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  return (data as DestinationRow | null) ?? null;
}

async function actionSave(db: SupabaseClient, userId: string, email: string | null, body: Record<string, unknown>): Promise<Response> {
  const existing = body.id ? await loadOwned(db, userId, body.id) : null;
  if (body.id && !existing) return json({ error: "Destination not found." }, 404);

  const provider = (existing?.provider ?? body.provider) as string;
  if (provider !== "splunk_hec" && provider !== "datadog") return json({ error: "Choose Splunk or Datadog." }, 400);
  if (existing && body.provider && body.provider !== existing.provider) return json({ error: "The provider can't be changed. Create a new destination instead." }, 400);

  const name = String(body.name ?? "").trim();
  if (name.length < 1 || name.length > 80) return json({ error: "Name must be 1–80 characters." }, 400);

  const minSeverity = String(body.min_severity ?? existing?.min_severity ?? "info") as Severity;
  if (!SEVERITIES.includes(minSeverity)) return json({ error: "Invalid minimum severity." }, 400);

  const secret = typeof body.secret === "string" ? body.secret.trim() : "";
  if (!existing && !secret) return json({ error: provider === "datadog" ? "Enter your Datadog API key." : "Enter your Splunk HEC token." }, 400);
  if (secret && !isValidSecret(secret)) return json({ error: "That token doesn't look valid (8–512 characters, no spaces)." }, 400);

  const fields: Record<string, unknown> = { name, min_severity: minSeverity };
  if (provider === "splunk_hec") {
    const check = validateSplunkUrl(String(body.url ?? ""));
    if (!check.ok) return json({ error: check.error }, 400);
    if (await resolvesToPrivate(new URL(check.url).hostname)) return json({ error: "That host resolves to a private network address." }, 400);
    const index = String(body.index ?? "").trim();
    const sourcetype = String(body.sourcetype ?? "").trim();
    if (index && !isValidSplunkIndex(index)) return json({ error: "Index may only contain letters, numbers, - and _." }, 400);
    if (sourcetype && !isValidSourcetype(sourcetype)) return json({ error: "Sourcetype may only contain letters, numbers, : . - and _." }, 400);
    Object.assign(fields, { endpoint_url: check.url, datadog_site: null, splunk_index: index || null, splunk_sourcetype: sourcetype || null });
  } else {
    const site = String(body.site ?? "").trim().toLowerCase();
    if (!datadogEndpoint(site)) return json({ error: `Choose a Datadog site: ${DATADOG_SITES.join(", ")}.` }, 400);
    Object.assign(fields, { endpoint_url: null, datadog_site: site, splunk_index: null, splunk_sourcetype: null });
  }
  if (typeof body.enabled === "boolean") fields.enabled = body.enabled;

  const now = new Date().toISOString();
  const host = provider === "splunk_hec" ? new URL(String(fields.endpoint_url)).hostname : String(fields.datadog_site);
  let id: string;

  if (existing) {
    id = existing.id;
    if (secret) Object.assign(fields, { status: "active", consecutive_failures: 0, last_error: null, last_error_at: null, next_attempt_at: null });
    const { error } = await db.from("siem_destinations").update({ ...fields, updated_at: now }).eq("id", id).eq("user_id", userId);
    if (error) return json({ error: "Could not save the destination." }, 500);
  } else {
    const { count } = await db.from("siem_destinations").select("id", { count: "exact", head: true }).eq("user_id", userId);
    if ((count ?? 0) >= MAX_DESTINATIONS_PER_ACCOUNT) return json({ error: `You can configure up to ${MAX_DESTINATIONS_PER_ACCOUNT} destinations.` }, 409);
    const { data, error } = await db.from("siem_destinations").insert({ user_id: userId, provider, ...fields }).select("id").single();
    if (error || !data) return json({ error: "Could not create the destination." }, 500);
    id = data.id as string;
  }

  if (secret) {
    try {
      const enc = await encryptSecret(secret);
      const { error } = await db.from("siem_destination_secrets").upsert({ destination_id: id, user_id: userId, secret_enc: enc, updated_at: now }, { onConflict: "destination_id" });
      if (error) throw new Error(error.message);
    } catch (err) {
      if (!existing) await db.from("siem_destinations").delete().eq("id", id);
      const msg = (err as Error).message.includes("SIEM_ENCRYPTION_KEY") ? "SIEM streaming isn't configured on this server yet (missing SIEM_ENCRYPTION_KEY)." : "Could not store the token securely.";
      return json({ error: msg }, 500);
    }
  }

  await audit(db, userId, existing ? "siem_destination_updated" : "siem_destination_created", id, {
    name,
    provider,
    host,
    min_severity: minSeverity,
    enabled: fields.enabled ?? existing?.enabled ?? true,
    secret_rotated: Boolean(secret),
  }, email);
  return json({ ok: true, id });
}

async function actionTest(db: SupabaseClient, userId: string, email: string | null, body: Record<string, unknown>): Promise<Response> {
  const dest = await loadOwned(db, userId, body.id);
  if (!dest) return json({ error: "Destination not found." }, 404);
  const { data: secretRow } = await db.from("siem_destination_secrets").select("secret_enc").eq("destination_id", dest.id).maybeSingle();
  if (!secretRow) return json({ ok: false, error: "No token stored. Edit the destination and enter it again." });

  let secret: string;
  try {
    secret = await decryptSecret(secretRow.secret_enc as string);
  } catch {
    return json({ ok: false, error: "Stored token could not be read. Edit the destination and enter it again." });
  }
  if (await resolvesToPrivate(hostOf(dest))) return json({ ok: false, error: "The destination host resolves to a private network address." });

  const started = Date.now();
  const event = syntheticTestEvent(userId, new Date().toISOString(), crypto.randomUUID());
  const built = buildRequest(dest, secret, [event]);
  let ok = false;
  let status = 0;
  let error = "Destination configuration is invalid. Edit it and save again.";
  if (built) {
    const res = await postOnce(built.url, built.headers, built.body);
    status = res.status;
    ok = status !== 0 && classifyHttpStatus(status) === "ok";
    error = ok ? "" : sanitizeError(status === 0 ? res.text : `HTTP ${status}${res.text ? `: ${res.text}` : ""}`, secret);
  }
  const duration = Date.now() - started;
  await db.from("siem_delivery_log").insert({
    destination_id: dest.id,
    user_id: userId,
    kind: "test",
    status: ok ? "ok" : "failed",
    event_count: ok ? 1 : 0,
    http_status: status || null,
    error: ok ? null : error,
    duration_ms: duration,
  });
  await audit(db, userId, "siem_destination_tested", dest.id, { name: dest.name, ok, http_status: status || null }, email);
  return json({ ok, http_status: status || null, duration_ms: duration, error: ok ? undefined : error });
}

async function actionSetEnabled(db: SupabaseClient, userId: string, email: string | null, body: Record<string, unknown>): Promise<Response> {
  const dest = await loadOwned(db, userId, body.id);
  if (!dest) return json({ error: "Destination not found." }, 404);
  if (typeof body.enabled !== "boolean") return json({ error: "enabled must be true or false." }, 400);
  const patch: Record<string, unknown> = { enabled: body.enabled, updated_at: new Date().toISOString() };
  if (body.enabled) Object.assign(patch, { status: "active", consecutive_failures: 0, next_attempt_at: null, lease_until: null });
  const { error } = await db.from("siem_destinations").update(patch).eq("id", dest.id).eq("user_id", userId);
  if (error) return json({ error: "Could not update the destination." }, 500);
  await audit(db, userId, body.enabled ? "siem_destination_resumed" : "siem_destination_paused", dest.id, { name: dest.name }, email);
  return json({ ok: true });
}

async function actionDelete(db: SupabaseClient, userId: string, email: string | null, body: Record<string, unknown>): Promise<Response> {
  const dest = await loadOwned(db, userId, body.id);
  if (!dest) return json({ error: "Destination not found." }, 404);
  await audit(db, userId, "siem_destination_deleted", dest.id, { name: dest.name, provider: dest.provider, host: hostOf(dest) }, email);
  const { error } = await db.from("siem_destinations").delete().eq("id", dest.id).eq("user_id", userId);
  if (error) return json({ error: "Could not delete the destination." }, 500);
  return json({ ok: true });
}

async function actionDeliverNow(db: SupabaseClient, userId: string, body: Record<string, unknown>): Promise<Response> {
  const dest = await loadOwned(db, userId, body.id);
  if (!dest) return json({ error: "Destination not found." }, 404);
  const summary = await deliverDestination(db, dest);
  if (summary.skipped === "busy") return json({ ok: false, error: "A delivery is already running. Try again in a moment." });
  return json({ ok: summary.ok, sent: summary.sent, dropped: summary.dropped, error: summary.error });
}

async function actionCron(db: SupabaseClient): Promise<Response> {
  const started = Date.now();
  const nowIso = new Date(started).toISOString();
  const { data, error } = await db
    .from("siem_destinations")
    .select(DEST_COLUMNS)
    .eq("enabled", true)
    .neq("status", "auth_failed")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .order("updated_at", { ascending: true })
    .limit(CRON_MAX_DESTINATIONS);
  if (error) return json({ error: error.message }, 500);

  let due = (data ?? []) as DestinationRow[];
  if (due.length) {
    const owners = [...new Set(due.map((d) => d.user_id))];
    const { data: profs } = await db.from("profiles").select("id, plan").in("id", owners);
    const eligible = new Set((profs ?? []).filter((p) => planAllowed(String(p.plan ?? ""))).map((p) => p.id as string));
    due = due.filter((d) => eligible.has(d.user_id));
  }

  const summaries: RunSummary[] = [];
  const queue = [...due];
  const worker = async () => {
    while (queue.length && Date.now() - started < RUN_BUDGET_MS) {
      const dest = queue.shift()!;
      summaries.push(await deliverDestination(db, dest));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CRON_CONCURRENCY, due.length) }, worker));

  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString();
  await db.from("siem_delivery_log").delete().lt("created_at", cutoff);

  const result = {
    processed: summaries.length,
    sent: summaries.reduce((n, s) => n + s.sent, 0),
    failed: summaries.filter((s) => !s.ok).length,
    skipped: summaries.filter((s) => s.skipped).length,
  };
  console.log(JSON.stringify({ fn: "siem-stream", event: "cron", ...result }));
  return json({ ok: true, ...result });
}

// ------------------------------------------------------------------
// Entry
// ------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const db = adminClient();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");

  if (action === "cron") {
    if (!isCron(req)) return json({ error: "Unauthorized" }, 401);
    return await actionCron(db);
  }

  const auth = await authenticateOwner(db, req);
  if (auth instanceof Response) return auth;
  const { data: u } = await db.auth.admin.getUserById(auth.userId);
  const email = u?.user?.email ?? null;

  if (action === "delete") return await actionDelete(db, auth.userId, email, body);
  if (!planAllowed(auth.plan)) return json({ error: PLAN_ERROR }, 403);

  switch (action) {
    case "save":
      return await actionSave(db, auth.userId, email, body);
    case "test":
      return await actionTest(db, auth.userId, email, body);
    case "set_enabled":
      return await actionSetEnabled(db, auth.userId, email, body);
    case "deliver_now":
      return await actionDeliverNow(db, auth.userId, body);
    default:
      return json({ error: "Unknown action" }, 400);
  }
});
