// supabase/functions/pm-sync-run/index.ts
//
// Property-management integrations: Buildium, Propertyware, Rentvine, AppFolio, Yardi.
//
// Actions (POST JSON, user JWT unless noted):
//   { action: "connect",       provider, credentials, customer_id? } -> { connection_id, status, warning? }
//   { action: "preview",       connection_id, entity }               -> { samples: [{ raw, canonical }] }
//   { action: "run",           connection_id }                       -> 202 { run_id }   "Sync now"
//   { action: "save_settings", connection_id, settings, auto_sync?, customer_id? } -> { ok, settings }
//   { action: "retry_item",    queue_id }                            -> { ok }
//   { action: "cancel_item",   queue_id }                            -> { ok }
//   { action: "disconnect",    connection_id }                       -> { ok }
//   { action: "cron" } + header X-Cron-Secret                        -> 202   scheduled sync of all due connections
//
// REQUIRED SECRETS: PM_TOKEN_ENCRYPTION_KEY (32 random bytes, base64: `openssl rand -base64 32`),
//   CRON_SECRET. Optional: PM_EXTRA_ALLOWED_HOSTS (comma separated exact hostnames, e.g. an on-prem Yardi server).
// Schedule with the pg_cron snippet at the bottom of supabase/migrations/20271110000000_pm_integrations.sql.
// Deploy: supabase functions deploy pm-sync-run --no-verify-jwt
//   (pg_cron calls it with X-Cron-Secret and no JWT; every other action verifies the user's JWT in code.)
//
// HOW A RUN WORKS
//   1. PULL  units + tenant contacts (at most hourly), then work orders changed since the watermark.
//      Each work order is reconciled by planWorkOrderSync() (engine.ts) against the last-synced snapshot and
//      written into the existing work_orders table, so the database approval / NTE rules still apply.
//   2. PUSH  drain the retry queue (status updates, invoices) with exponential backoff.
//
// SAFETY
//   - Tenant scope: ownerId comes from get_account_owner_id() (or the connection row for cron) and is applied to every query.
//   - Credentials are AES-GCM encrypted at rest, decrypted only here, only ever sent to allow-listed hosts,
//     never to a redirect target, and scrubbed from every log line.
//   - Writes to the provider are OFF until switched on, and start as a dry run that logs the exact request.
//   - Deletes are never propagated in either direction.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { decryptSecret, encryptSecret } from "../_shared/crm/engine.ts";
import {
  MAX_ATTEMPTS,
  PM_PROVIDERS,
  PROVIDER_META,
  PAGE_SIZE,
  buildNewWorkOrder,
  buildRestRequest,
  buildYardiGetRequests,
  classifyHttp,
  defaultSettings,
  emptyStats,
  endpointFor,
  invoiceVars,
  isAllowedBase,
  listVars,
  missingInvoiceInputs,
  parsePage,
  parseRetryAfter,
  parseTimestamp,
  parseYardiServiceRequests,
  planWorkOrderSync,
  retryDelayMs,
  scrub,
  statusVars,
  toCanonTenant,
  toCanonUnit,
  toCanonWorkOrder,
  toWoValues,
  validateCredentials,
  validateSettings,
  type Credentials,
  type HttpReq,
  type PmProvider,
  type PmSettings,
  type PmStats,
  type WoBase,
  type WoValues,
} from "../_shared/pm/engine.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;
// deno-lint-ignore no-explicit-any
type AnyClient = SupabaseClient<any, any, any>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const RUN_BUDGET_MS = 110_000;
const LOCK_MS = 6 * 60_000;
const LOG_RETENTION_DAYS = 30;
const PAGE_CAP = 25;
const PULL_OVERLAP_MS = 5 * 60_000;
const REFERENCE_REFRESH_MS = 55 * 60_000; // units + tenants at most hourly
const QUEUE_BATCH = 25;
const EXTRA_HOSTS = (Deno.env.get("PM_EXTRA_ALLOWED_HOSTS") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
const UUID = /^[0-9a-f-]{36}$/i;

class AuthError extends Error {}
class RateLimitError extends Error {}

// ============================================================
// TYPES
// ============================================================

interface Cursor {
  since: string | null;
  resume: string | null;
  passStarted: string | null;
}
interface ConnRow {
  id: string;
  user_id: string;
  provider: PmProvider;
  status: string;
  api_base: string;
  customer_id: string | null;
  settings: unknown;
  cursors: Record<string, Cursor> | null;
}
interface LinkRow {
  id: string;
  vireek_id: string;
  external_id: string;
  base: WoBase & { status?: WoValues["status"] };
  meta: Record<string, unknown>;
  ignored: boolean;
}
interface LogEntry {
  entity: "work_order" | "invoice" | "unit" | "tenant" | "queue" | "connection";
  direction: "to_pm" | "from_pm" | "none";
  action: "created" | "updated" | "linked" | "pushed" | "dry_run" | "skipped" | "conflict" | "retry" | "error";
  vireek_id?: string | null;
  external_id?: string | null;
  message: string;
  details?: unknown;
}
interface Ctx {
  admin: AnyClient;
  conn: ConnRow;
  ownerId: string;
  provider: PmProvider;
  apiBase: string;
  creds: Credentials;
  settings: PmSettings;
  cursors: Record<string, Cursor>;
  runId: string | null;
  stats: PmStats;
  logs: Record<string, unknown>[];
  deadline: number;
  lastProgressAt: number;
  warnedStatuses: Set<string>;
}
interface Resp {
  status: number;
  text: string;
  json: unknown;
  retryAfter: number | null;
}

const CONN_COLS = "id, user_id, provider, status, api_base, customer_id, settings, cursors";
const overDeadline = (ctx: Ctx) => Date.now() > ctx.deadline;
const background = (p: Promise<unknown>) => {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(p);
  else void p;
};

// ============================================================
// LOG + RUN PROGRESS
// ============================================================

function log(ctx: Ctx, e: LogEntry) {
  ctx.logs.push({
    user_id: ctx.ownerId,
    connection_id: ctx.conn.id,
    run_id: ctx.runId,
    entity: e.entity,
    direction: e.direction,
    action: e.action,
    vireek_id: e.vireek_id ?? null,
    external_id: e.external_id ?? null,
    message: scrub(e.message, ctx.creds).slice(0, 500),
    details: e.details ?? null,
  });
}
async function flushLogs(ctx: Ctx) {
  if (!ctx.logs.length) return;
  const rows = ctx.logs.splice(0);
  const { error } = await ctx.admin.from("pm_sync_log").insert(rows);
  if (error) console.error("pm-sync log insert failed", error.message);
}
async function touchRun(ctx: Ctx, force = false) {
  if (!ctx.runId) return;
  if (!force && Date.now() - ctx.lastProgressAt < 3000) return;
  ctx.lastProgressAt = Date.now();
  await ctx.admin.from("pm_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
  if (ctx.logs.length >= 40) await flushLogs(ctx);
}

// ============================================================
// PROVIDER HTTP
// ============================================================

async function call(ctx: Ctx, req: HttpReq): Promise<Resp> {
  const inside = req.url === ctx.apiBase || req.url.startsWith(`${ctx.apiBase}/`) || req.url.startsWith(`${ctx.apiBase}?`);
  if (!inside || !isAllowedBase(ctx.provider, ctx.apiBase, EXTRA_HOSTS)) {
    throw new Error("Refusing to call an address outside the connected account.");
  }
  let res: Response;
  try {
    // redirect: "manual" so credentials are never forwarded to another host.
    res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  } catch {
    return { status: 0, text: "", json: null, retryAfter: null };
  }
  const text = (await res.text()).slice(0, 2_000_000);
  let parsed: unknown = null;
  if (/^\s*[[{]/.test(text)) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, text, json: parsed, retryAfter: parseRetryAfter(res.headers.get("retry-after")) };
}

function classify(r: Resp) {
  if (r.status === 0) return { outcome: "retry" as const, message: "Could not reach the provider." };
  return classifyHttp(r.status);
}

/** Pull-side failures become typed errors the run loop understands. */
function raiseForPull(r: Resp, ctx: Ctx, what: string) {
  const c = classify(r);
  if (c.outcome === "ok") return;
  if (c.outcome === "auth") throw new AuthError(c.message);
  if (c.outcome === "retry") throw new RateLimitError(c.message);
  throw new Error(`${what}: ${c.message} ${scrub(r.text.slice(0, 160), ctx.creds)}`.trim());
}

// ============================================================
// LINKS
// ============================================================

async function getLinkByExternal(ctx: Ctx, entity: string, externalId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin
    .from("pm_record_links")
    .select("id, vireek_id, external_id, base, meta, ignored")
    .eq("connection_id", ctx.conn.id)
    .eq("entity", entity)
    .eq("external_id", externalId)
    .maybeSingle();
  return (data as LinkRow | null) ?? null;
}
async function getLinkByVireek(ctx: Ctx, entity: string, vireekId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin
    .from("pm_record_links")
    .select("id, vireek_id, external_id, base, meta, ignored")
    .eq("connection_id", ctx.conn.id)
    .eq("entity", entity)
    .eq("vireek_id", vireekId)
    .maybeSingle();
  return (data as LinkRow | null) ?? null;
}
async function createLink(ctx: Ctx, entity: string, vireekId: string, externalId: string, base: unknown, meta: unknown): Promise<LinkRow | null> {
  const { data, error } = await ctx.admin
    .from("pm_record_links")
    .insert({ user_id: ctx.ownerId, connection_id: ctx.conn.id, entity, vireek_id: vireekId, external_id: externalId, base, meta })
    .select("id, vireek_id, external_id, base, meta, ignored")
    .single();
  if (error) return (await getLinkByExternal(ctx, entity, externalId)) ?? null; // lost a race: use the winner
  return data as LinkRow;
}

// ============================================================
// WORK ORDERS (provider -> Vireek)
// ============================================================

const WO_COLS =
  "id, title, description, po_number, site_name, site_address, site_contact_name, site_contact_phone, site_contact_email, not_to_exceed_cents, approval_status, approver_name, status, work_order_number";

function rowToValues(r: Record<string, unknown>): WoValues {
  const s = (k: string) => (typeof r[k] === "string" && (r[k] as string).trim() ? (r[k] as string) : null);
  return {
    title: (r.title as string) ?? "",
    description: s("description"),
    po_number: s("po_number"),
    site_name: s("site_name"),
    site_address: s("site_address"),
    site_contact_name: s("site_contact_name"),
    site_contact_phone: s("site_contact_phone"),
    site_contact_email: s("site_contact_email"),
    not_to_exceed_cents: typeof r.not_to_exceed_cents === "number" ? r.not_to_exceed_cents : null,
    approval_status: r.approval_status as WoValues["approval_status"],
    approver_name: s("approver_name"),
    status: r.status as WoValues["status"],
  };
}

async function tenantFor(ctx: Ctx, unitExternalId: string | null) {
  if (!unitExternalId || !ctx.settings.pull.tenants) return null;
  const { data } = await ctx.admin
    .from("pm_tenant_contacts")
    .select("name, email, phone")
    .eq("connection_id", ctx.conn.id)
    .eq("external_unit_id", unitExternalId)
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as { name: string | null; email: string | null; phone: string | null } | null;
}

async function enqueue(ctx: Ctx, kind: "push_status" | "push_invoice", subjectId: string) {
  const { error } = await ctx.admin.from("pm_sync_queue").insert({ user_id: ctx.ownerId, connection_id: ctx.conn.id, kind, subject_id: subjectId });
  if (!error) ctx.stats.queued++; // a unique-violation just means one is already waiting
}

async function applyWorkOrder(ctx: Ctx, raw: Record<string, unknown>, sinceMs: number | null) {
  const canon = toCanonWorkOrder(raw, ctx.settings);
  const extId = canon.external_id;
  if (!extId) {
    ctx.stats.skipped++;
    log(ctx, { entity: "work_order", direction: "from_pm", action: "skipped", message: "A provider record had no ID. Check the field mapping." });
    return;
  }
  const updatedMs = parseTimestamp(canon.updated_at);
  if (sinceMs !== null && updatedMs !== null && updatedMs < sinceMs) return; // provider ignored our filter
  const { values: pmRaw, unknownStatus } = toWoValues(canon, ctx.settings);
  if (unknownStatus && !ctx.warnedStatuses.has(unknownStatus)) {
    ctx.warnedStatuses.add(unknownStatus);
    log(ctx, { entity: "work_order", direction: "from_pm", action: "skipped", external_id: extId, message: `Unknown provider status “${unknownStatus}” was treated as ${ctx.settings.unknownStatus}. Add it under Status mapping.` });
  }
  const tenant = pmRaw.site_contact_name ? null : await tenantFor(ctx, canon.unit_id);
  const pm: WoValues = tenant
    ? { ...pmRaw, site_contact_name: tenant.name, site_contact_phone: tenant.phone, site_contact_email: tenant.email }
    : pmRaw;
  const meta = { number: canon.number, property_id: canon.property_id, unit_id: canon.unit_id, priority: canon.priority };

  let link = await getLinkByExternal(ctx, "work_order", extId);
  if (link?.ignored) {
    ctx.stats.skipped++;
    return;
  }

  // ---- brand new -----------------------------------------------------------------------------
  if (!link) {
    // Adopt an existing, unlinked Vireek work order when exactly one has the same PO number.
    let adopt: Record<string, unknown> | null = null;
    if (pm.po_number) {
      const { data: cands } = await ctx.admin.from("work_orders").select(WO_COLS).eq("user_id", ctx.ownerId).eq("po_number", pm.po_number).limit(2);
      if (cands && cands.length === 1) {
        const taken = await getLinkByVireek(ctx, "work_order", cands[0].id as string);
        if (!taken) adopt = cands[0] as Record<string, unknown>;
      }
    }
    if (!adopt) {
      if (!ctx.settings.createWorkOrders) {
        ctx.stats.skipped++;
        return;
      }
      const nv = buildNewWorkOrder(pm);
      const { data: created, error } = await ctx.admin
        .from("work_orders")
        .insert({ user_id: ctx.ownerId, customer_id: ctx.conn.customer_id, ...nv })
        .select("id, work_order_number")
        .single();
      if (error || !created) {
        ctx.stats.failed++;
        log(ctx, { entity: "work_order", direction: "from_pm", action: "error", external_id: extId, message: `Could not create the work order: ${error?.message ?? "unknown error"}` });
        return;
      }
      await createLink(ctx, "work_order", created.id as string, extId, nv, meta);
      ctx.stats.created++;
      log(ctx, { entity: "work_order", direction: "from_pm", action: "created", vireek_id: created.id as string, external_id: extId, message: `Created ${created.work_order_number ?? "work order"} from ${PROVIDER_META[ctx.provider].label} #${canon.number ?? extId}` });
      return;
    }
    link = await createLink(ctx, "work_order", adopt.id as string, extId, {}, meta);
    if (!link) return;
    ctx.stats.linked++;
    log(ctx, { entity: "work_order", direction: "none", action: "linked", vireek_id: adopt.id as string, external_id: extId, message: `Linked existing work order by PO number ${pm.po_number}` });
  }

  // ---- already linked -------------------------------------------------------------------------
  const { data: row } = await ctx.admin.from("work_orders").select(WO_COLS).eq("id", link.vireek_id).eq("user_id", ctx.ownerId).maybeSingle();
  if (!row) {
    await ctx.admin.from("pm_record_links").update({ ignored: true }).eq("id", link.id);
    ctx.stats.skipped++;
    log(ctx, { entity: "work_order", direction: "none", action: "skipped", vireek_id: link.vireek_id, external_id: extId, message: "The Vireek work order was deleted. This record will no longer sync." });
    return;
  }
  const vv = rowToValues(row as Record<string, unknown>);
  const plan = planWorkOrderSync(link.base ?? {}, pm, vv);

  if (Object.keys(plan.patch).length) {
    const { error } = await ctx.admin.from("work_orders").update(plan.patch).eq("id", link.vireek_id).eq("user_id", ctx.ownerId);
    if (error) {
      ctx.stats.failed++;
      log(ctx, { entity: "work_order", direction: "from_pm", action: "error", vireek_id: link.vireek_id, external_id: extId, message: `Update rejected: ${error.message}`, details: { fields: Object.keys(plan.patch) } });
      return; // keep the old base so the change is retried next run
    }
    ctx.stats.updated++;
    log(ctx, { entity: "work_order", direction: "from_pm", action: "updated", vireek_id: link.vireek_id, external_id: extId, message: `Updated ${Object.keys(plan.patch).join(", ")}`, details: { patch: plan.patch } });
  }
  for (const n of plan.notes) log(ctx, { entity: "work_order", direction: "none", action: "conflict", vireek_id: link.vireek_id, external_id: extId, message: n });

  await ctx.admin.from("pm_record_links").update({ base: plan.nextBase, meta: { ...link.meta, ...meta }, last_synced_at: new Date().toISOString() }).eq("id", link.id);

  if (plan.pushStatus && ctx.settings.push.status && link.meta?.dry_run_status !== plan.pushStatus) await enqueue(ctx, "push_status", link.vireek_id);
}

// ============================================================
// UNITS + TENANT CONTACTS
// ============================================================

async function upsertReference(ctx: Ctx, table: "pm_units" | "pm_tenant_contacts", rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await ctx.admin.from(table).upsert(batch, { onConflict: "connection_id,external_id" });
    if (error) {
      ctx.stats.failed += batch.length;
      log(ctx, { entity: table === "pm_units" ? "unit" : "tenant", direction: "from_pm", action: "error", message: `Could not save ${batch.length} records: ${error.message}` });
    } else if (table === "pm_units") ctx.stats.units += batch.length;
    else ctx.stats.tenants += batch.length;
  }
}

// ============================================================
// PULL LOOP
// ============================================================

async function fetchPage(ctx: Ctx, key: "workOrders" | "units" | "tenants", cursor: string | null, since: string | null) {
  if (ctx.provider === "yardi") {
    if (key !== "workOrders") return { items: [] as Record<string, unknown>[], nextCursor: null };
    const items: Record<string, unknown>[] = [];
    for (const req of buildYardiGetRequests(ctx.creds)) {
      const res = await call(ctx, { ...req, url: ctx.apiBase });
      raiseForPull(res, ctx, "Yardi service requests");
      items.push(...parseYardiServiceRequests(res.text));
    }
    return { items, nextCursor: null };
  }
  const spec = endpointFor(ctx.provider, ctx.settings, key);
  if (!spec) return { items: [] as Record<string, unknown>[], nextCursor: null };
  const res = await call(ctx, buildRestRequest(ctx.provider, ctx.creds, ctx.apiBase, spec, listVars(cursor, since)));
  raiseForPull(res, ctx, `${PROVIDER_META[ctx.provider].label} ${key}`);
  return parsePage(res.json, spec, cursor);
}

/** Returns true when the pass finished (false = resume on the next run). */
async function pullEntity(ctx: Ctx, key: "workOrders" | "units" | "tenants", handle: (raw: Record<string, unknown>, sinceMs: number | null) => Promise<void>): Promise<boolean> {
  const cur: Cursor = ctx.cursors[key] ?? { since: null, resume: null, passStarted: null };
  if (key !== "workOrders" && cur.since && !cur.resume && Date.now() - Date.parse(cur.since) < REFERENCE_REFRESH_MS) return true;
  const passStarted = cur.passStarted ?? new Date().toISOString();
  const since = cur.since ?? (key === "workOrders" ? new Date(Date.now() - ctx.settings.backfillDays * 86_400_000).toISOString() : null);
  const sinceMs = key === "workOrders" && since ? Date.parse(since) : null;
  let cursor = cur.resume;

  for (let pages = 0; ; pages++) {
    if (overDeadline(ctx) || pages >= PAGE_CAP) {
      ctx.cursors[key] = { since: cur.since, resume: cursor, passStarted };
      return false;
    }
    const page = await fetchPage(ctx, key, cursor, since);
    for (const raw of page.items) await handle(raw, sinceMs);
    await touchRun(ctx);
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  ctx.cursors[key] = { since: new Date(Date.parse(passStarted) - PULL_OVERLAP_MS).toISOString(), resume: null, passStarted: null };
  return true;
}

const unitHandler = (ctx: Ctx) => {
  const buf: Record<string, unknown>[] = [];
  return {
    handle: (raw: Record<string, unknown>) => {
      const c = toCanonUnit(raw, ctx.settings);
      if (c.external_id) {
        buf.push({
          user_id: ctx.ownerId, connection_id: ctx.conn.id, external_id: c.external_id, external_property_id: c.property_id, property_name: c.property_name?.slice(0, 200) ?? null,
          unit_number: c.unit_number?.slice(0, 60) ?? null, address: c.address?.slice(0, 300) ?? null, city: c.city?.slice(0, 100) ?? null, state: c.state?.slice(0, 60) ?? null,
          postal_code: c.postal_code?.slice(0, 20) ?? null, synced_at: new Date().toISOString(),
        });
      }
      return Promise.resolve();
    },
    flush: () => upsertReference(ctx, "pm_units", buf.splice(0)),
  };
};
const tenantHandler = (ctx: Ctx) => {
  const buf: Record<string, unknown>[] = [];
  return {
    handle: (raw: Record<string, unknown>) => {
      const c = toCanonTenant(raw, ctx.settings);
      if (c.external_id) {
        buf.push({
          user_id: ctx.ownerId, connection_id: ctx.conn.id, external_id: c.external_id, external_unit_id: c.unit_id, name: c.name?.slice(0, 120) ?? null,
          email: c.email?.toLowerCase().slice(0, 200) ?? null, phone: c.phone?.replace(/[^\d+()\-\s.x]/g, "").slice(0, 40) ?? null, status: c.status?.slice(0, 40) ?? null,
          synced_at: new Date().toISOString(),
        });
      }
      return Promise.resolve();
    },
    flush: () => upsertReference(ctx, "pm_tenant_contacts", buf.splice(0)),
  };
};

// ============================================================
// RETRY QUEUE (Vireek -> provider)
// ============================================================

interface QueueRow {
  id: string;
  kind: "push_status" | "push_invoice";
  subject_id: string;
  attempts: number;
  max_attempts: number;
}
type Verdict = { outcome: "done" | "retry" | "failed" | "cancelled" | "auth"; message: string; http?: number; retryAfter?: number | null };

async function pushStatus(ctx: Ctx, q: QueueRow): Promise<Verdict> {
  const link = await getLinkByVireek(ctx, "work_order", q.subject_id);
  if (!link || link.ignored) return { outcome: "cancelled", message: "This work order is not linked to the provider." };
  const { data: wo } = await ctx.admin.from("work_orders").select("status, work_order_number").eq("id", q.subject_id).eq("user_id", ctx.ownerId).maybeSingle();
  if (!wo) return { outcome: "cancelled", message: "The work order no longer exists." };
  const status = wo.status as WoValues["status"];
  if (link.base?.status === status) return { outcome: "done", message: "Already in sync." };
  if (!ctx.settings.push.status) return { outcome: "cancelled", message: "Status updates are switched off for this connection." };
  const spec = endpointFor(ctx.provider, ctx.settings, "pushStatus");
  if (!spec) return { outcome: "failed", message: "No status-update endpoint is configured." };
  const req = buildRestRequest(ctx.provider, ctx.creds, ctx.apiBase, spec, statusVars(ctx.settings, status, { id: link.external_id, number: (link.meta?.number as string | null) ?? null }));

  if (ctx.settings.push.dryRun) {
    log(ctx, { entity: "work_order", direction: "to_pm", action: "dry_run", vireek_id: q.subject_id, external_id: link.external_id, message: `Dry run: would set ${PROVIDER_META[ctx.provider].label} status to “${ctx.settings.statusOut[status]}”`, details: { method: req.method, url: req.url, body: req.body ? JSON.parse(req.body) : null } });
    await ctx.admin.from("pm_record_links").update({ meta: { ...link.meta, dry_run_status: status } }).eq("id", link.id);
    return { outcome: "done", message: "Dry run only. Nothing was sent." };
  }
  const res = await call(ctx, req);
  const c = classify(res);
  if (c.outcome === "ok") {
    const { dry_run_status: _d, ...meta } = link.meta ?? {};
    void _d;
    await ctx.admin.from("pm_record_links").update({ base: { ...link.base, status }, meta, last_synced_at: new Date().toISOString() }).eq("id", link.id);
    ctx.stats.pushed++;
    log(ctx, { entity: "work_order", direction: "to_pm", action: "pushed", vireek_id: q.subject_id, external_id: link.external_id, message: `Set ${PROVIDER_META[ctx.provider].label} status to “${ctx.settings.statusOut[status]}”` });
    return { outcome: "done", message: "Sent.", http: res.status };
  }
  return { outcome: c.outcome === "retry" ? "retry" : c.outcome === "auth" ? "auth" : "failed", message: `${c.message} ${scrub(res.text.slice(0, 160), ctx.creds)}`.trim(), http: res.status, retryAfter: res.retryAfter };
}

async function pushInvoice(ctx: Ctx, q: QueueRow): Promise<Verdict> {
  const { data: visit } = await ctx.admin
    .from("work_order_visits")
    .select("id, work_order_id, visit_number, billing_status, billable_amount_cents, invoice_reference")
    .eq("id", q.subject_id)
    .eq("user_id", ctx.ownerId)
    .maybeSingle();
  if (!visit || !["invoiced", "paid"].includes(visit.billing_status as string)) return { outcome: "cancelled", message: "The visit is no longer invoiced." };
  if (await getLinkByVireek(ctx, "invoice", visit.id as string)) return { outcome: "done", message: "Invoice was already sent." };
  const woLink = await getLinkByVireek(ctx, "work_order", visit.work_order_id as string);
  if (!woLink || woLink.ignored) return { outcome: "cancelled", message: "The work order is not linked to the provider." };
  if (!ctx.settings.push.invoices) return { outcome: "cancelled", message: "Invoice sync is switched off for this connection." };
  const amount = visit.billable_amount_cents as number | null;
  if (!amount || amount <= 0) return { outcome: "failed", message: "The visit has no billable amount." };
  const spec = endpointFor(ctx.provider, ctx.settings, "pushInvoice");
  if (!spec) return { outcome: "failed", message: "No invoice endpoint is configured." };
  const { data: wo } = await ctx.admin.from("work_orders").select("title, work_order_number").eq("id", visit.work_order_id).maybeSingle();
  const number = (visit.invoice_reference as string | null) || `${wo?.work_order_number ?? "WO"}-V${visit.visit_number ?? 1}`;
  const vars = invoiceVars(ctx.settings, {
    amountCents: amount,
    invoiceNumber: number,
    description: `${wo?.title ?? "Work order"} (visit ${visit.visit_number ?? 1})`,
    propertyId: (woLink.meta?.property_id as string | null) ?? null,
    today: new Date(),
  });
  const missing = missingInvoiceInputs(ctx.provider, vars);
  if (missing.length) return { outcome: "failed", message: `Missing ${missing.join(", ")}. Fill these in under Settings → Invoices, then retry.` };
  const req = buildRestRequest(ctx.provider, ctx.creds, ctx.apiBase, spec, vars);

  if (ctx.settings.push.dryRun) {
    log(ctx, { entity: "invoice", direction: "to_pm", action: "dry_run", vireek_id: visit.id as string, message: `Dry run: would send invoice ${number} for ${(amount / 100).toFixed(2)}`, details: { method: req.method, url: req.url, body: req.body ? JSON.parse(req.body) : null } });
    return { outcome: "done", message: "Dry run only. Nothing was sent." };
  }
  const res = await call(ctx, req);
  const c = classify(res);
  if (c.outcome === "ok") {
    const j = (res.json ?? {}) as Record<string, unknown>;
    const ext = String(j.Id ?? j.id ?? j.BillId ?? `sent-${visit.id}`);
    await createLink(ctx, "invoice", visit.id as string, ext, { number, amount_cents: amount }, { work_order_external_id: woLink.external_id });
    ctx.stats.pushed++;
    log(ctx, { entity: "invoice", direction: "to_pm", action: "pushed", vireek_id: visit.id as string, external_id: ext, message: `Sent invoice ${number} to ${PROVIDER_META[ctx.provider].label}` });
    return { outcome: "done", message: "Sent.", http: res.status };
  }
  return { outcome: c.outcome === "retry" ? "retry" : c.outcome === "auth" ? "auth" : "failed", message: `${c.message} ${scrub(res.text.slice(0, 160), ctx.creds)}`.trim(), http: res.status, retryAfter: res.retryAfter };
}

async function drainQueue(ctx: Ctx): Promise<boolean> {
  const nowIso = () => new Date().toISOString();
  await ctx.admin.from("pm_sync_queue").update({ status: "pending", locked_until: null }).eq("connection_id", ctx.conn.id).eq("status", "processing").lt("locked_until", nowIso());
  const { data: due } = await ctx.admin
    .from("pm_sync_queue")
    .select("id, kind, subject_id, attempts, max_attempts")
    .eq("connection_id", ctx.conn.id)
    .eq("status", "pending")
    .lte("next_attempt_at", nowIso())
    .order("next_attempt_at", { ascending: true })
    .limit(QUEUE_BATCH);

  for (const q of (due ?? []) as QueueRow[]) {
    if (overDeadline(ctx)) return false;
    const attempt = q.attempts + 1;
    const { data: claimed } = await ctx.admin
      .from("pm_sync_queue")
      .update({ status: "processing", attempts: attempt, locked_until: new Date(Date.now() + 2 * 60_000).toISOString() })
      .eq("id", q.id)
      .eq("status", "pending")
      .select("id");
    if (!claimed?.length) continue; // another worker took it

    let v: Verdict;
    try {
      v = q.kind === "push_status" ? await pushStatus(ctx, q) : await pushInvoice(ctx, q);
    } catch (err) {
      v = { outcome: "retry", message: err instanceof Error ? err.message : "Unexpected error." };
    }
    const base = { last_error: v.outcome === "done" ? null : scrub(v.message, ctx.creds).slice(0, 400), last_http_status: v.http ?? null, locked_until: null };
    if (v.outcome === "done") {
      await ctx.admin.from("pm_sync_queue").update({ ...base, status: "done", completed_at: nowIso() }).eq("id", q.id);
    } else if (v.outcome === "cancelled") {
      await ctx.admin.from("pm_sync_queue").update({ ...base, status: "cancelled", completed_at: nowIso() }).eq("id", q.id);
    } else if (v.outcome === "auth") {
      // Credentials rejected: stop hammering the provider; keep the item for after the user reconnects.
      await ctx.admin.from("pm_sync_queue").update({ ...base, status: "pending", attempts: q.attempts, next_attempt_at: new Date(Date.now() + 3_600_000).toISOString() }).eq("id", q.id);
      throw new AuthError(v.message);
    } else if (v.outcome === "retry" && attempt < Math.min(q.max_attempts, MAX_ATTEMPTS)) {
      const delay = retryDelayMs(attempt, v.retryAfter ?? null);
      await ctx.admin.from("pm_sync_queue").update({ ...base, status: "pending", next_attempt_at: new Date(Date.now() + delay).toISOString() }).eq("id", q.id);
      log(ctx, { entity: "queue", direction: "to_pm", action: "retry", vireek_id: q.subject_id, message: `Attempt ${attempt} failed (${v.message}). Retrying in ${Math.round(delay / 60000)} min.` });
    } else {
      await ctx.admin.from("pm_sync_queue").update({ ...base, status: "failed", completed_at: nowIso() }).eq("id", q.id);
      ctx.stats.failed++;
      log(ctx, { entity: "queue", direction: "to_pm", action: "error", vireek_id: q.subject_id, message: `Gave up: ${v.message}` });
    }
    await touchRun(ctx);
  }
  return true;
}

// ============================================================
// RUN LIFECYCLE
// ============================================================

async function acquireLock(admin: AnyClient, connId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await admin.from("pm_connections").update({ sync_locked_until: new Date(Date.now() + LOCK_MS).toISOString() }).eq("id", connId).or(`sync_locked_until.is.null,sync_locked_until.lt.${now}`).select("id");
  return (data?.length ?? 0) > 0;
}

async function loadCreds(admin: AnyClient, connId: string): Promise<Credentials> {
  const key = Deno.env.get("PM_TOKEN_ENCRYPTION_KEY");
  if (!key) throw new Error("PM_TOKEN_ENCRYPTION_KEY is not configured.");
  const { data } = await admin.from("pm_connection_secrets").select("credentials_enc").eq("connection_id", connId).maybeSingle();
  if (!data) throw new AuthError("Stored credentials are missing. Reconnect.");
  return JSON.parse(await decryptSecret(data.credentials_enc as string, key)) as Credentials;
}

async function buildCtx(admin: AnyClient, conn: ConnRow, runId: string | null, deadline: number): Promise<Ctx> {
  const v = validateSettings(conn.provider, conn.settings);
  return {
    admin, conn, ownerId: conn.user_id, provider: conn.provider, apiBase: conn.api_base, creds: await loadCreds(admin, conn.id),
    settings: v.ok ? v.settings : defaultSettings(conn.provider), cursors: { ...(conn.cursors ?? {}) }, runId, stats: emptyStats(), logs: [], deadline,
    lastProgressAt: 0, warnedStatuses: new Set(),
  };
}

async function executeRun(admin: AnyClient, conn: ConnRow, runId: string) {
  let ctx: Ctx | null = null;
  let status: "success" | "partial" | "failed" = "success";
  let error: string | null = null;
  let markError = false;
  let finished = true;
  try {
    await admin.from("pm_sync_log").delete().eq("connection_id", conn.id).lt("created_at", new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString());
    ctx = await buildCtx(admin, conn, runId, Date.now() + RUN_BUDGET_MS);
    const c = ctx;
    if (c.settings.pull.units) {
      const h = unitHandler(c);
      finished = (await pullEntity(c, "units", h.handle)) && finished;
      await h.flush();
    }
    if (c.settings.pull.tenants) {
      const h = tenantHandler(c);
      finished = (await pullEntity(c, "tenants", h.handle)) && finished;
      await h.flush();
    }
    if (c.settings.pull.workOrders) finished = (await pullEntity(c, "workOrders", (raw, since) => applyWorkOrder(c, raw, since))) && finished;
    finished = (await drainQueue(c)) && finished;
    if (!finished || overDeadline(c)) {
      status = "partial";
      error = "Large sync in progress. It continues automatically on the next run.";
    }
    if (c.stats.failed > 0 && status === "success") status = "partial";
  } catch (err) {
    status = "failed";
    if (err instanceof AuthError) {
      markError = true;
      error = "The provider rejected the stored credentials. Reconnect to continue.";
    } else if (err instanceof RateLimitError) {
      status = "partial";
      error = "The provider is rate limiting or unavailable. The sync retries on the next run.";
    } else {
      error = scrub(err instanceof Error ? err.message : "Unexpected sync error.", ctx?.creds ?? {});
      console.error("pm-sync-run failed", conn.id, error);
    }
  } finally {
    if (ctx) {
      await flushLogs(ctx);
      await admin.from("pm_sync_runs").update({ stats: ctx.stats }).eq("id", runId);
    }
    await admin.from("pm_sync_runs").update({ status, error, finished_at: new Date().toISOString() }).eq("id", runId);
    await admin
      .from("pm_connections")
      .update({
        sync_locked_until: null,
        ...(ctx ? { cursors: ctx.cursors } : {}),
        ...(markError ? { status: "error" } : status === "failed" ? {} : { status: "connected" }),
        ...(status === "failed" ? { last_error: error } : { last_error: status === "partial" ? error : null, last_synced_at: new Date().toISOString() }),
      })
      .eq("id", conn.id);
  }
}

async function beginRun(admin: AnyClient, conn: ConnRow, trigger: "manual" | "scheduled"): Promise<string | null> {
  if (!(await acquireLock(admin, conn.id))) return null;
  await admin.from("pm_sync_runs").update({ status: "failed", error: "Interrupted.", finished_at: new Date().toISOString() }).eq("connection_id", conn.id).eq("status", "running").lt("started_at", new Date(Date.now() - 10 * 60_000).toISOString());
  const { data } = await admin.from("pm_sync_runs").insert({ user_id: conn.user_id, connection_id: conn.id, trigger, status: "running" }).select("id").single();
  if (!data) {
    await admin.from("pm_connections").update({ sync_locked_until: null }).eq("id", conn.id);
    return null;
  }
  return data.id as string;
}

// ============================================================
// CONNECT / PREVIEW
// ============================================================

async function probe(provider: PmProvider, creds: Credentials, apiBase: string, settings: PmSettings): Promise<Resp> {
  const fake = { provider, apiBase, creds, settings, conn: { id: "probe" } } as unknown as Ctx;
  if (provider === "yardi") return await call(fake, { ...buildYardiGetRequests(creds)[0], url: apiBase });
  const spec = endpointFor(provider, settings, "workOrders");
  if (!spec) throw new Error("No work-order endpoint is configured.");
  return await call(fake, buildRestRequest(provider, creds, apiBase, spec, { ...listVars(null, null), limit: 1 }));
}

// ============================================================
// HTTP ENTRY
// ============================================================

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // ---- scheduled sync + queue drain ---------------------------------------------------------
  if (body.action === "cron") {
    const secret = Deno.env.get("CRON_SECRET");
    if (!secret || req.headers.get("X-Cron-Secret") !== secret) return json({ error: "Forbidden" }, 403);
    const due = new Date(Date.now() - 4 * 60_000).toISOString();
    const { data: conns } = await admin
      .from("pm_connections")
      .select(CONN_COLS)
      .eq("status", "connected")
      .eq("auto_sync", true)
      .or(`last_synced_at.is.null,last_synced_at.lt.${due}`)
      .order("last_synced_at", { ascending: true, nullsFirst: true })
      .limit(5);
    background(
      (async () => {
        for (const c of (conns ?? []) as ConnRow[]) {
          const runId = await beginRun(admin, c, "scheduled");
          if (runId) await executeRun(admin, c, runId);
        }
      })(),
    );
    return json({ queued: conns?.length ?? 0 }, 202);
  }

  // ---- user actions --------------------------------------------------------------------------
  const authHeaderValue = req.headers.get("Authorization");
  if (!authHeaderValue) return json({ error: "Missing Authorization header" }, 401);
  const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authHeaderValue } }, auth: { persistSession: false } });
  const { data: userData } = await caller.auth.getUser();
  if (!userData?.user) return json({ error: "Not authenticated" }, 401);
  const { data: ownerData } = await caller.rpc("get_account_owner_id");
  if (!ownerData) return json({ error: "Could not resolve your account." }, 401);
  const ownerId = ownerData as string;
  const { data: allowed } = await caller.rpc("can_manage_pm_integrations");
  if (allowed !== true) return json({ error: "You don't have permission to manage property-management integrations." }, 403);

  const loadConn = async (id: unknown): Promise<ConnRow | null> => {
    if (typeof id !== "string" || !UUID.test(id)) return null;
    const { data } = await admin.from("pm_connections").select(CONN_COLS).eq("id", id).eq("user_id", ownerId).maybeSingle();
    return (data as ConnRow | null) ?? null;
  };
  const ownsCustomer = async (id: unknown): Promise<boolean> => {
    if (typeof id !== "string" || !UUID.test(id)) return false;
    const { data } = await admin.from("customers").select("id").eq("id", id).eq("user_id", ownerId).maybeSingle();
    return !!data;
  };

  if (body.action === "connect") {
    const provider = body.provider as PmProvider;
    if (!PM_PROVIDERS.includes(provider)) return json({ error: "Unknown provider." }, 400);
    const vc = validateCredentials(provider, body.credentials, EXTRA_HOSTS);
    if (!vc.ok) return json({ error: vc.error }, 400);
    const key = Deno.env.get("PM_TOKEN_ENCRYPTION_KEY");
    if (!key) return json({ error: "Property-management sync is not configured on the server yet." }, 503);
    let customerId: string | null = null;
    if (body.customer_id !== undefined && body.customer_id !== null && body.customer_id !== "") {
      if (!(await ownsCustomer(body.customer_id))) return json({ error: "That customer was not found." }, 400);
      customerId = body.customer_id as string;
    }

    const settings = defaultSettings(provider);
    let warning: string | null = null;
    let status: "connected" | "error" = "connected";
    try {
      const res = await probe(provider, vc.credentials, vc.apiBase, settings);
      const c = classify(res);
      if (c.outcome === "auth" || (c.outcome === "permanent" && res.status === 403)) {
        return json({ error: `${PROVIDER_META[provider].label} rejected these credentials. ${PROVIDER_META[provider].requirement}.` }, 400);
      }
      if (res.status === 0) return json({ error: `Could not reach ${PROVIDER_META[provider].label}. Check the details and try again.` }, 502);
      if (c.outcome !== "ok") {
        status = "error";
        warning = `Credentials were accepted but the work-order request returned ${res.status}. Adjust the endpoint under Advanced, then sync.`;
      }
    } catch (err) {
      return json({ error: err instanceof Error ? scrub(err.message, vc.credentials) : "Could not verify the connection." }, 502);
    }

    const { data: existing } = await admin.from("pm_connections").select("id").eq("user_id", ownerId).eq("provider", provider).eq("account_label", vc.label).maybeSingle();
    let connId = existing?.id as string | undefined;
    const patch = { status, api_base: vc.apiBase, customer_id: customerId, last_error: warning, connected_by: userData.user.id, sync_locked_until: null };
    if (connId) {
      await admin.from("pm_connections").update(patch).eq("id", connId);
    } else {
      const { data: created, error } = await admin.from("pm_connections").insert({ user_id: ownerId, provider, account_label: vc.label, settings, ...patch }).select("id").single();
      if (error || !created) return json({ error: "Could not save the connection." }, 500);
      connId = created.id as string;
    }
    const enc = await encryptSecret(JSON.stringify(vc.credentials), key);
    const { error: secErr } = await admin.from("pm_connection_secrets").upsert({ connection_id: connId, user_id: ownerId, credentials_enc: enc, updated_at: new Date().toISOString() });
    if (secErr) return json({ error: "Could not store the credentials securely." }, 500);
    await admin.from("pm_sync_log").insert({ user_id: ownerId, connection_id: connId, entity: "connection", direction: "none", action: "created", message: `Connected ${PROVIDER_META[provider].label} (${vc.label})` });
    return json({ connection_id: connId, status, warning });
  }

  if (body.action === "run") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    if (conn.status === "disconnected") return json({ error: "This connection is disconnected." }, 409);
    const runId = await beginRun(admin, conn, "manual");
    if (!runId) return json({ error: "A sync is already running for this connection." }, 409);
    background(executeRun(admin, conn, runId));
    return json({ run_id: runId }, 202);
  }

  if (body.action === "preview") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    if (conn.status === "disconnected") return json({ error: "This connection is disconnected." }, 409);
    const entity = body.entity === "units" || body.entity === "tenants" ? body.entity : "workOrders";
    try {
      const ctx = await buildCtx(admin, conn, null, Date.now() + 30_000);
      const page = await fetchPage(ctx, entity, null, null);
      const samples = page.items.slice(0, 3).map((raw) => ({
        raw: JSON.stringify(raw).slice(0, 2500),
        canonical: entity === "workOrders" ? toCanonWorkOrder(raw, ctx.settings) : entity === "units" ? toCanonUnit(raw, ctx.settings) : toCanonTenant(raw, ctx.settings),
      }));
      return json({ samples, returned: page.items.length, page_size: PAGE_SIZE });
    } catch (err) {
      if (err instanceof AuthError) return json({ error: "The provider rejected the stored credentials. Reconnect." }, 502);
      if (err instanceof RateLimitError) return json({ error: "The provider is rate limiting or unavailable. Try again shortly." }, 502);
      return json({ error: err instanceof Error ? err.message.slice(0, 300) : "Could not fetch a sample." }, 502);
    }
  }

  if (body.action === "save_settings") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    const v = validateSettings(conn.provider, body.settings);
    if (!v.ok) return json({ error: v.error }, 400);
    // A changed mapping or endpoint must re-read, so reset the watermarks.
    const old = validateSettings(conn.provider, conn.settings);
    const sig = (s: PmSettings) => JSON.stringify([s.mapping, s.endpoints, s.statusIn, s.approvalIn, s.defaultApproval, s.usePmNumberAsPo, s.backfillDays]);
    const cursors = old.ok && sig(old.settings) === sig(v.settings) ? (conn.cursors ?? {}) : {};
    const update: Record<string, unknown> = { settings: v.settings, cursors };
    if (typeof body.auto_sync === "boolean") update.auto_sync = body.auto_sync;
    if (body.customer_id !== undefined) {
      if (body.customer_id === null || body.customer_id === "") update.customer_id = null;
      else if (await ownsCustomer(body.customer_id)) update.customer_id = body.customer_id;
      else return json({ error: "That customer was not found." }, 400);
    }
    const { error } = await admin.from("pm_connections").update(update).eq("id", conn.id);
    if (error) return json({ error: "Could not save the settings." }, 500);
    return json({ ok: true, settings: v.settings });
  }

  if (body.action === "retry_item" || body.action === "cancel_item") {
    if (typeof body.queue_id !== "string" || !UUID.test(body.queue_id)) return json({ error: "Invalid request." }, 400);
    const { data: item } = await admin.from("pm_sync_queue").select("id, status, connection_id").eq("id", body.queue_id).eq("user_id", ownerId).maybeSingle();
    if (!item) return json({ error: "Queue item not found." }, 404);
    if (body.action === "retry_item") {
      if (!["failed", "cancelled"].includes(item.status as string)) return json({ error: "Only failed items can be retried." }, 409);
      const conn = await loadConn(item.connection_id);
      if (!conn || conn.status === "disconnected") return json({ error: "This connection is disconnected." }, 409);
      // The unique "one pending per record" index may already hold a newer item; then the retry is simply redundant.
      const { error } = await admin.from("pm_sync_queue").update({ status: "pending", attempts: 0, next_attempt_at: new Date().toISOString(), last_error: null, completed_at: null }).eq("id", item.id);
      if (error) {
        await admin.from("pm_sync_queue").update({ status: "cancelled", last_error: "Superseded by a newer pending update.", completed_at: new Date().toISOString() }).eq("id", item.id);
      }
      return json({ ok: true });
    }
    if (!["pending", "failed"].includes(item.status as string)) return json({ error: "This item can't be cancelled." }, 409);
    await admin.from("pm_sync_queue").update({ status: "cancelled", completed_at: new Date().toISOString() }).eq("id", item.id);
    return json({ ok: true });
  }

  if (body.action === "disconnect") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    await admin.from("pm_connection_secrets").delete().eq("connection_id", conn.id);
    await admin.from("pm_sync_queue").delete().eq("connection_id", conn.id).in("status", ["pending", "processing"]);
    await admin.from("pm_tenant_contacts").delete().eq("connection_id", conn.id); // personal data goes with the credentials
    await admin.from("pm_units").delete().eq("connection_id", conn.id);
    await admin.from("pm_connections").update({ status: "disconnected", cursors: {}, last_error: null, sync_locked_until: null }).eq("id", conn.id);
    await admin.from("pm_sync_log").insert({ user_id: ownerId, connection_id: conn.id, entity: "connection", direction: "none", action: "updated", message: "Disconnected. Credentials, units and tenant contacts were deleted." });
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
});
