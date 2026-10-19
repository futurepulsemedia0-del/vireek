// supabase/functions/qbo-sync-run/index.ts
//
// Two-way sync of accounts, customers, items, invoices and payments with QuickBooks Online.
//
// Actions (POST JSON):
//   { action: "run",              connection_id }                    -> 202 { run_id }   manual "Sync now"
//   { action: "resync",           connection_id }                    -> 202 { run_id }   re-read everything (merge is idempotent)
//   { action: "save_settings",    connection_id, settings, auto_sync? } -> { ok, settings }
//   { action: "options",          connection_id }                    -> { accounts, items, taxCodes } live from QuickBooks (mapping UI)
//   { action: "disconnect",       connection_id }                    -> { ok }
//   { action: "resolve_conflict", link_id, winner: "vireek"|"qbo" }  -> { ok }
//   { action: "cron" }    + header X-Cron-Secret                     -> 202   scheduled sync of all due connections
//   { action: "webhook", realm_ids } + header X-Cron-Secret          -> 202   called by qbo-webhook
//
// REQUIRED SECRETS: see qbo-oauth-start/index.ts. Schedule with the pg_cron snippet at the bottom of
// supabase/migrations/20271011000000_quickbooks_sync.sql.
//
// Deploy: supabase functions deploy qbo-sync-run --no-verify-jwt
//   (pg_cron / qbo-webhook call it with X-Cron-Secret and no JWT; every user action verifies the JWT in code.)
//
// HOW A RUN WORKS (order: accounts, customers, items, invoices, payments; each: PULL then PUSH)
//   1. PULL changed QuickBooks records (watermark + resumable page cursor) and reconcile each one.
//   2. PUSH changed Vireek records and reconcile each one against the live QuickBooks record.
//   `reconcile` is a field-level THREE-WAY merge against the base snapshot stored on the link, so only
//   fields that changed since the last sync move and our own writes never echo back.
//
// SAFETY
//   - Tenant scope: ownerId comes from get_account_owner_id() (or the connection row for cron/webhook)
//     and is applied to every query on top of the service-role client.
//   - Records are only CREATED on the other side after the first full pull of that entity finished.
//   - Money documents go through the general-ledger functions (balanced, period-locked). An invoice with
//     payments is never re-itemised or voided automatically: it becomes a conflict for a human to resolve.
//   - Deletes are never propagated in either direction. Payments are create-only.
//   - Tokens are AES-GCM encrypted at rest and only sent to allow-listed Intuit hosts.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  ENTITY_META,
  PAGE_CAP_PER_RUN,
  PULL_OVERLAP_MS,
  QBO_ENTITIES,
  QBO_QUERY_PAGE,
  QBO_REVOKE_URL,
  accountTypeFromClassification,
  apiBaseFor,
  buildFindRequest,
  buildGetRequest,
  buildQboInvoicePayload,
  buildQboPaymentPayload,
  buildQueryRequest,
  buildTokenRequest,
  buildVoidRequest,
  buildWriteRequest,
  canCreateInQbo,
  canCreateInVireek,
  canonToQbo,
  classifyResponse,
  decryptSecret,
  defaultSettings,
  emptyStats,
  encryptSecret,
  escapeLike,
  generatedAccountCode,
  invoiceAmountSig,
  isAllowedApiBase,
  isSyncableItem,
  isValidQboId,
  itemIncomeRef,
  mergeEntity,
  mergeFieldsFor,
  normalBalanceFor,
  normalizeValue,
  paymentLinkKey,
  paymentMethodFromName,
  parseEntityResponse,
  parseQboInvoice,
  parseQboPayment,
  parseQueryResponse,
  parseTimestamp,
  parseTokenResponse,
  qboName,
  qboTimestamp,
  qboToCanon,
  recordMeta,
  resolveLineItems,
  suggestQboAccountType,
  toCents,
  validateSettings,
  VIREEK_FIELDS,
  type Canon,
  type InvoiceLine,
  type QboEntity,
  type QboEnvironment,
  type QboInvoiceDoc,
  type QboSettings,
  type RawRecord,
  type SyncStats,
  type VireekAccountType,
} from "../_shared/quickbooks/engine.ts";

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
const PUSH_PAGE = 100;
const RETRY_CAP = 200;

class AuthError extends Error {}
class RateLimitError extends Error {}

// ============================================================
// TYPES
// ============================================================

interface PullState { since: string | null; pos: number; passStarted: string | null; retry?: string[] }
interface PushState { ts: string | null; id: string | null; retry?: string[] }
interface EntityCursor { pull?: PullState; push?: PushState }
interface ConnRow {
  id: string;
  user_id: string;
  realm_id: string;
  environment: QboEnvironment;
  status: string;
  settings: unknown;
  cursors: Record<string, EntityCursor> | null;
}
interface LinkRow {
  id: string;
  entity: QboEntity;
  vireek_id: string;
  external_id: string;
  sync_token: string | null;
  base: Canon;
  conflict: { fields: string[]; sig: string; reason?: string } | null;
}
type VRow = Record<string, unknown> & { id: string; updated_at?: string };
type Outcome = "ok" | "conflict" | "error" | "skipped";

interface LogEntry {
  entity: QboEntity;
  direction: "to_qbo" | "from_qbo" | "both" | "none";
  action: "created" | "updated" | "linked" | "voided" | "conflict" | "skipped" | "error";
  vireek_id?: string | null;
  external_id?: string | null;
  link_id?: string | null;
  message: string;
  details?: unknown;
  tid?: string | null;
}

interface Ctx {
  admin: AnyClient;
  conn: ConnRow;
  ownerId: string;
  realm: string;
  base: string;
  settings: QboSettings;
  cursors: Record<string, EntityCursor>;
  runId: string | null;
  stats: SyncStats;
  logs: Record<string, unknown>[];
  deadline: number;
  access: string;
  refresh: string;
  lastProgressAt: number;
  warned: Set<string>;
  /** Run-level caches. */
  itemByName?: Map<string, string>;
}

interface ApiResult { status: number; json: unknown; tid: string | null }

// ============================================================
// LOG / RUN BOOKKEEPING
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
    link_id: e.link_id ?? null,
    message: e.message.slice(0, 500),
    details: e.details ?? null,
    intuit_tid: e.tid ?? null,
  });
}
async function flushLogs(ctx: Ctx) {
  if (!ctx.logs.length) return;
  const rows = ctx.logs.splice(0);
  const { error } = await ctx.admin.from("qbo_sync_log").insert(rows);
  if (error) console.error("qbo-sync log insert failed", error.message);
}
async function touchRun(ctx: Ctx, force = false) {
  if (!ctx.runId) return;
  if (!force && Date.now() - ctx.lastProgressAt < 3000) return;
  ctx.lastProgressAt = Date.now();
  await ctx.admin.from("qbo_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
  if (ctx.logs.length >= 40) await flushLogs(ctx);
}
const overDeadline = (ctx: Ctx) => Date.now() > ctx.deadline;
const warnOnce = (ctx: Ctx, key: string, e: LogEntry) => {
  if (ctx.warned.has(key)) return;
  ctx.warned.add(key);
  log(ctx, e);
};

// ============================================================
// QUICKBOOKS HTTP (token refresh, retry, rate limits)
// ============================================================

async function persistTokens(ctx: Ctx, expiresInSec: number | null, refreshExpiresInSec: number | null) {
  const encKey = Deno.env.get("QBO_TOKEN_ENCRYPTION_KEY") ?? "";
  await ctx.admin
    .from("qbo_connection_secrets")
    .update({
      access_token_enc: await encryptSecret(ctx.access, encKey),
      refresh_token_enc: await encryptSecret(ctx.refresh, encKey),
      expires_at: expiresInSec ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("connection_id", ctx.conn.id);
  if (refreshExpiresInSec) {
    await ctx.admin.from("qbo_connections").update({ refresh_token_expires_at: new Date(Date.now() + refreshExpiresInSec * 1000).toISOString() }).eq("id", ctx.conn.id);
  }
}

async function refreshAccess(ctx: Ctx) {
  const req = buildTokenRequest("refresh", {
    clientId: Deno.env.get("QBO_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("QBO_CLIENT_SECRET") ?? "",
    refreshToken: ctx.refresh,
  });
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 429) throw new RateLimitError("Token endpoint rate limited.");
  if (res.status >= 500) throw new Error(`Intuit token endpoint error ${res.status}`);
  if (!res.ok) throw new AuthError(String(j.error_description ?? j.error ?? "Refresh failed."));
  const t = parseTokenResponse(j);
  ctx.access = t.accessToken;
  // Intuit rotates the refresh token: ALWAYS keep the newest one.
  if (t.refreshToken) ctx.refresh = t.refreshToken;
  await persistTokens(ctx, t.expiresInSec, t.refreshExpiresInSec);
}

async function api(ctx: Ctx, req: { method: string; url: string; body?: unknown }): Promise<ApiResult> {
  if (!req.url.startsWith(`${ctx.base}/`) || !isAllowedApiBase(ctx.base)) {
    throw new Error("Refusing to call an address outside QuickBooks.");
  }
  let refreshed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${ctx.access}`,
          Accept: "application/json",
          ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      });
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      throw err;
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await refreshAccess(ctx);
      continue;
    }
    if (res.status === 401) throw new AuthError("QuickBooks rejected our credentials.");
    if (res.status === 429) throw new RateLimitError("QuickBooks is rate limiting requests.");
    if (res.status >= 500 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const text = res.status === 204 ? "" : await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, json: body, tid: res.headers.get("intuit_tid") };
  }
  throw new Error("QuickBooks request failed.");
}

const faultText = (r: ApiResult) => {
  const f = classifyResponse(r.status, r.json).fault;
  return f ? `${f.message}${f.detail ? `: ${f.detail}` : ""}`.slice(0, 300) : `HTTP ${r.status}`;
};

async function fetchQbo(ctx: Ctx, entity: QboEntity, id: string): Promise<RawRecord | null> {
  const r = await api(ctx, buildGetRequest({ base: ctx.base, realm: ctx.realm, entity, id }));
  if (classifyResponse(r.status, r.json).kind === "notfound") return null;
  return parseEntityResponse(entity, r.json);
}

async function queryQbo(ctx: Ctx, req: { method: "GET" | "POST"; url: string }, entity: QboEntity) {
  const r = await api(ctx, req);
  const kind = classifyResponse(r.status, r.json).kind;
  if (kind !== "ok") throw new Error(`QuickBooks query failed: ${faultText(r)}`);
  return parseQueryResponse(entity, r.json, QBO_QUERY_PAGE).records;
}

/** Write with one automatic retry on a stale SyncToken (refetch, re-apply). */
async function writeQbo(
  ctx: Ctx,
  entity: QboEntity,
  payload: RawRecord,
  requestId?: string,
): Promise<{ ok: true; record: RawRecord; tid: string | null } | { ok: false; kind: string; message: string; tid: string | null }> {
  let body = payload;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await api(ctx, buildWriteRequest({ base: ctx.base, realm: ctx.realm, entity, payload: body, requestId }));
    const c = classifyResponse(r.status, r.json);
    if (c.kind === "ok") {
      const rec = parseEntityResponse(entity, r.json);
      if (rec) return { ok: true, record: rec, tid: r.tid };
      return { ok: false, kind: "error", message: "QuickBooks returned no record.", tid: r.tid };
    }
    if (c.kind === "stale" && attempt === 0 && typeof body.Id === "string") {
      const fresh = await fetchQbo(ctx, entity, body.Id);
      if (fresh) {
        body = { ...body, SyncToken: recordMeta(fresh).syncToken };
        continue;
      }
    }
    return { ok: false, kind: c.kind, message: faultText(r), tid: r.tid };
  }
  return { ok: false, kind: "stale", message: "The record kept changing in QuickBooks.", tid: null };
}

// ============================================================
// VIREEK-SIDE HELPERS
// ============================================================

const COLS: Record<"account" | "customer" | "item", string> = {
  account: "id, code, name, type, is_active, is_system, updated_at",
  customer: "id, name, email, phone, address, notes, updated_at",
  item: "id, service_name, description, price_cents, active, updated_at",
};
const INVOICE_COLS = "id, customer_id, invoice_number, status, issue_date, due_date, subtotal_cents, tax_cents, total_cents, amount_paid_cents, updated_at";
const PAYMENT_COLS = "id, invoice_id, amount_cents, payment_date, payment_method, deposit_account_id, created_at";
const KEY_ORDER = (e: string) => (e === "payment" ? "created_at" : "updated_at");

type Simple = "account" | "customer" | "item";

function vireekCanon(entity: Simple, r: VRow): Canon {
  switch (entity) {
    case "customer":
      return { name: r.name as string, email: r.email as string, phone: r.phone as string, address: r.address as string, notes: r.notes as string };
    case "item":
      return { name: r.service_name as string, description: r.description as string, price: (r.price_cents as number) / 100, active: r.active === false ? "inactive" : "active" };
    case "account":
      return { code: r.code as string, name: r.name as string, active: r.is_active === false ? "inactive" : "active" };
  }
}

/** Canon values -> Vireek column values (only the keys given). */
function toColumns(entity: Simple, v: Canon): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(v, k);
  if (entity === "customer") {
    for (const k of ["name", "email", "phone", "address", "notes"]) if (has(k)) out[k] = v[k];
  } else if (entity === "item") {
    if (has("name")) out.service_name = v.name;
    if (has("description")) out.description = v.description;
    if (has("price")) out.price_cents = Math.max(0, toCents(v.price ?? 0));
    if (has("active")) out.active = v.active !== "inactive";
  } else {
    if (has("code")) out.code = v.code;
    if (has("name")) out.name = v.name;
    if (has("active")) out.is_active = v.active !== "inactive";
  }
  return out;
}

const tsOf = (r: VRow): number | null => (r.updated_at ? parseTimestamp(r.updated_at as string) : null);
const stripMeta = (b: Canon | null): Canon | null => (b ? Object.fromEntries(Object.entries(b).filter(([k]) => !k.startsWith("__"))) : null);
const rid = (prefix: string, id: string) => `${prefix}-${id.replace(/-/g, "")}`.slice(0, 50);

async function getVireekRow(ctx: Ctx, entity: Simple, id: string): Promise<VRow | null> {
  const { data } = await ctx.admin.from(ENTITY_META[entity].table).select(COLS[entity]).eq("id", id).eq("user_id", ctx.ownerId).maybeSingle();
  return (data as VRow | null) ?? null;
}

// ---- links ----------------------------------------------------------------

const LINK_COLS = "id, entity, vireek_id, external_id, sync_token, base, conflict";
async function getLinkByExternal(ctx: Ctx, entity: QboEntity, externalId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin.from("qbo_record_links").select(LINK_COLS).eq("connection_id", ctx.conn.id).eq("entity", entity).eq("external_id", externalId).maybeSingle();
  return (data as LinkRow | null) ?? null;
}
async function getLinkByVireek(ctx: Ctx, entity: QboEntity, vireekId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin.from("qbo_record_links").select(LINK_COLS).eq("connection_id", ctx.conn.id).eq("entity", entity).eq("vireek_id", vireekId).maybeSingle();
  return (data as LinkRow | null) ?? null;
}
async function createLink(ctx: Ctx, entity: QboEntity, vireekId: string, externalId: string, base: Canon, syncToken: string | null): Promise<LinkRow | null> {
  const { data, error } = await ctx.admin
    .from("qbo_record_links")
    .insert({ user_id: ctx.ownerId, connection_id: ctx.conn.id, entity, vireek_id: vireekId, external_id: externalId, base, sync_token: syncToken })
    .select(LINK_COLS)
    .single();
  if (error) {
    console.error("qbo link insert failed", error.message);
    return null;
  }
  return data as LinkRow;
}
async function saveLink(ctx: Ctx, link: LinkRow, patch: { base?: Canon; sync_token?: string | null; conflict?: LinkRow["conflict"] }) {
  await ctx.admin.from("qbo_record_links").update({ ...patch, last_synced_at: new Date().toISOString() }).eq("id", link.id);
}

// ---- retry lists (records skipped because a dependency isn't synced yet) ------

function addRetry(list: string[] | undefined, id: string): string[] {
  const set = new Set(list ?? []);
  set.add(id);
  return [...set].slice(-RETRY_CAP);
}

// ============================================================
// SIMPLE ENTITIES: accounts, customers, items
// ============================================================

function conflictSig(fields: string[], v: Canon, q: Canon): string {
  return JSON.stringify([fields, fields.map((f) => [v[f] ?? null, q[f] ?? null])]);
}

async function applyVireekUpdate(ctx: Ctx, entity: Simple, id: string, values: Canon): Promise<string | null> {
  const cols = toColumns(entity, values);
  if (!Object.keys(cols).length) return null;
  const { error } = await ctx.admin.from(ENTITY_META[entity].table).update(cols).eq("id", id).eq("user_id", ctx.ownerId);
  return error ? error.message : null;
}

async function reconcile(
  ctx: Ctx,
  entity: Simple,
  link: LinkRow | null,
  vRow: VRow,
  raw: RawRecord,
  opts: { ruleOverride?: "vireek_wins" | "qbo_wins"; note?: string } = {},
): Promise<Outcome> {
  const es = ctx.settings.entities[entity];
  const meta = recordMeta(raw);
  const vC = vireekCanon(entity, vRow);
  const qC = qboToCanon(entity, raw);
  const res = mergeEntity({ entity, settings: es, base: stripMeta(link?.base ?? null), vireek: vC, qbo: qC, vireekTs: tsOf(vRow), qboTs: meta.modifiedAt, ruleOverride: opts.ruleOverride });
  let syncToken = meta.syncToken;
  const next: Canon = { ...res.next };
  let failed = false;

  if (Object.keys(res.toVireek).length) {
    const err = await applyVireekUpdate(ctx, entity, vRow.id, res.toVireek);
    if (err) {
      failed = true;
      ctx.stats.errors++;
      log(ctx, { entity, direction: "from_qbo", action: "error", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `Could not update Vireek: ${err}` });
      for (const k of Object.keys(res.toVireek)) next[k] = link?.base?.[k] ?? null;
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity, direction: "from_qbo", action: "updated", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: opts.note ?? `Updated from QuickBooks (${Object.keys(res.toVireek).join(", ")})`, details: res.toVireek });
    }
  }

  if (Object.keys(res.toCrm).length) {
    const payload = { ...canonToQbo(entity, res.toCrm, { defaults: ctx.settings.defaults }, false), Id: meta.id, SyncToken: syncToken, sparse: true };
    const w = await writeQbo(ctx, entity, payload);
    if (w.ok) {
      syncToken = recordMeta(w.record).syncToken;
      ctx.stats.updated_qbo++;
      log(ctx, { entity, direction: "to_qbo", action: "updated", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: opts.note ?? `Updated in QuickBooks (${Object.keys(res.toCrm).join(", ")})`, details: res.toCrm });
    } else {
      failed = true;
      ctx.stats.errors++;
      log(ctx, { entity, direction: "to_qbo", action: "error", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `QuickBooks rejected the update: ${w.message}`, tid: w.tid });
      for (const k of Object.keys(res.toCrm)) next[k] = link?.base?.[k] ?? null;
    }
  }

  let conflict: LinkRow["conflict"] = null;
  if (res.conflicts.length) {
    const fields = res.conflicts.map((c) => c.field);
    const sig = conflictSig(fields, vC, qC);
    conflict = { fields, sig };
    if (link?.conflict?.sig !== sig) {
      ctx.stats.conflicts++;
      log(ctx, { entity, direction: "none", action: "conflict", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `Both sides changed: ${fields.join(", ")}`, details: res.conflicts });
    }
  }

  const base: Canon = { ...next, ...(entity === "item" ? { __income: itemIncomeRef(raw) } : {}) };
  if (link) await saveLink(ctx, link, { base, sync_token: syncToken, conflict });
  else await createLink(ctx, entity, vRow.id, meta.id, base, syncToken);
  return failed ? "error" : conflict ? "conflict" : "ok";
}

async function findVireekMatch(ctx: Ctx, entity: Simple, qC: Canon): Promise<VRow | null> {
  const t = ENTITY_META[entity].table;
  const q = (col: string, val: string) => ctx.admin.from(t).select(COLS[entity]).eq("user_id", ctx.ownerId).ilike(col, escapeLike(val)).limit(1).maybeSingle();
  let row: unknown = null;
  if (entity === "customer") {
    if (qC.email) row = (await q("email", String(qC.email))).data;
    if (!row && qC.name) row = (await q("name", String(qC.name))).data;
  } else if (entity === "item") {
    if (qC.name) row = (await q("service_name", String(qC.name))).data;
  } else {
    if (qC.code) row = (await ctx.admin.from(t).select(COLS[entity]).eq("user_id", ctx.ownerId).eq("code", String(qC.code)).limit(1).maybeSingle()).data;
    if (!row && qC.name) row = (await q("name", String(qC.name))).data;
  }
  const r = row as VRow | null;
  if (!r) return null;
  return (await getLinkByVireek(ctx, entity, r.id)) ? null : r; // already linked to another QuickBooks record
}

async function createVireekRow(ctx: Ctx, entity: Simple, raw: RawRecord, qC: Canon): Promise<{ row?: VRow; error?: string; skip?: string }> {
  const meta = recordMeta(raw);
  let insert: Record<string, unknown>;
  if (entity === "customer") {
    if (!qC.name) return { skip: "Customer has no name." };
    insert = { ...toColumns("customer", qC), user_id: ctx.ownerId, source: "import", lifecycle_stage: "active", customer_type: raw.CompanyName ? "commercial" : "residential" };
  } else if (entity === "item") {
    if (!qC.name) return { skip: "Item has no name." };
    insert = { ...toColumns("item", qC), user_id: ctx.ownerId, pricing_model: "flat", price_cents: Math.max(0, toCents(qC.price ?? 0)) };
  } else {
    const type = accountTypeFromClassification(raw.Classification);
    if (!type || !qC.name) return { skip: "Account has no recognisable classification." };
    insert = { ...toColumns("account", qC), user_id: ctx.ownerId, code: qC.code ?? generatedAccountCode(meta.id), type, normal_balance: normalBalanceFor(type), is_system: false };
  }
  let { data, error } = await ctx.admin.from(ENTITY_META[entity].table).insert(insert).select(COLS[entity]).single();
  if (error && entity === "account" && /duplicate|unique/i.test(error.message)) {
    ({ data, error } = await ctx.admin.from(ENTITY_META[entity].table).insert({ ...insert, code: generatedAccountCode(meta.id) }).select(COLS[entity]).single());
  }
  if (error || !data) return { error: error?.message ?? "insert failed" };
  return { row: data as unknown as VRow };
}

async function applyQboRecord(ctx: Ctx, entity: Simple, raw: RawRecord): Promise<void> {
  const es = ctx.settings.entities[entity];
  const meta = recordMeta(raw);
  if (!meta.id) return;
  if (entity === "item" && !isSyncableItem(raw)) return;
  const qC = qboToCanon(entity, raw);
  const link = await getLinkByExternal(ctx, entity, meta.id);

  if (link) {
    const vRow = await getVireekRow(ctx, entity, link.vireek_id);
    if (!vRow) {
      warnOnce(ctx, `gone:${link.id}`, { entity, direction: "none", action: "skipped", vireek_id: link.vireek_id, external_id: meta.id, link_id: link.id, message: "Deleted in Vireek: not recreated and not changed in QuickBooks." });
      ctx.stats.skipped++;
      return;
    }
    await reconcile(ctx, entity, link, vRow, raw);
    return;
  }

  const match = await findVireekMatch(ctx, entity, qC);
  if (match) {
    const out = await reconcile(ctx, entity, null, match, raw, { note: "Matched an existing record" });
    if (out !== "error") log(ctx, { entity, direction: "both", action: "linked", vireek_id: match.id, external_id: meta.id, message: "Linked to the matching record" });
    return;
  }
  if (!canCreateInVireek(es)) {
    ctx.stats.skipped++;
    return;
  }
  const made = await createVireekRow(ctx, entity, raw, qC);
  if (made.skip) {
    ctx.stats.skipped++;
    log(ctx, { entity, direction: "from_qbo", action: "skipped", external_id: meta.id, message: made.skip });
    return;
  }
  if (made.error || !made.row) {
    ctx.stats.errors++;
    log(ctx, { entity, direction: "from_qbo", action: "error", external_id: meta.id, message: `Could not create in Vireek: ${made.error}` });
    return;
  }
  const merged = mergeEntity({ entity, settings: es, base: null, vireek: vireekCanon(entity, made.row), qbo: qC, vireekTs: null, qboTs: null });
  await createLink(ctx, entity, made.row.id, meta.id, { ...merged.next, ...(entity === "item" ? { __income: itemIncomeRef(raw) } : {}) }, meta.syncToken);
  ctx.stats.created_vireek++;
  log(ctx, { entity, direction: "from_qbo", action: "created", vireek_id: made.row.id, external_id: meta.id, message: `Created from QuickBooks: ${String(qC.name ?? meta.id).slice(0, 80)}` });
}

function vireekChangedSinceBase(entity: Simple, link: LinkRow, row: VRow, es: QboSettings["entities"][Simple]): boolean {
  const v = vireekCanon(entity, row);
  const base = link.base ?? {};
  return mergeFieldsFor(entity, es).some((f) => normalizeValue(f.type, v[f.key]) !== normalizeValue(f.type, base[f.key]));
}

async function createInQbo(ctx: Ctx, entity: Simple, row: VRow): Promise<void> {
  const es = ctx.settings.entities[entity];
  const vC = vireekCanon(entity, row);
  const label = String(vC.name ?? row.id).slice(0, 80);
  const baseCtx = { defaults: ctx.settings.defaults };

  if (entity === "item" && !ctx.settings.defaults.incomeAccountId) {
    warnOnce(ctx, "no-income", { entity, direction: "none", action: "skipped", message: "Items were not created in QuickBooks: choose a default income account under Mapping → Defaults." });
    ctx.stats.skipped++;
    return;
  }

  // 1. An existing QuickBooks record with the same identity is linked, never duplicated.
  const lookup =
    entity === "customer" ? { field: "DisplayName", value: String(vC.name) }
    : entity === "item" ? { field: "Name", value: qboName(String(vC.name)) }
    : vC.code ? { field: "AcctNum", value: String(vC.code) } : { field: "Name", value: qboName(String(vC.name)) };
  const found = await queryQbo(ctx, buildFindRequest({ base: ctx.base, realm: ctx.realm, entity, ...lookup }), entity);
  const hit = found.find((r) => (entity !== "item" || isSyncableItem(r)));
  if (hit) {
    const out = await reconcile(ctx, entity, null, row, hit, { note: "Matched an existing QuickBooks record" });
    if (out !== "error") log(ctx, { entity, direction: "both", action: "linked", vireek_id: row.id, external_id: recordMeta(hit).id, message: `Linked to existing QuickBooks record: ${label}` });
    return;
  }

  // 2. Create.
  const values: Canon = {};
  for (const f of mergeFieldsFor(entity, es)) if (f.direction !== "from_crm") values[f.key] = vC[f.key] ?? null;
  let accountType: string | null = null;
  if (entity === "account") accountType = suggestQboAccountType(String(row.type) as VireekAccountType, String(row.code ?? ""));
  let payload = canonToQbo(entity, values, { ...baseCtx, accountType }, true);
  let w = await writeQbo(ctx, entity, payload, rid(entity === "customer" ? "vk-c" : entity === "item" ? "vk-t" : "vk-a", row.id));
  if (!w.ok && entity === "account" && w.kind === "validation" && /AcctNum|account number/i.test(w.message)) {
    delete payload.AcctNum; // account numbers are switched off in this QuickBooks company
    payload = { ...payload };
    w = await writeQbo(ctx, entity, payload, rid("vk-a2", row.id));
  }
  if (!w.ok) {
    ctx.stats.errors++;
    log(ctx, { entity, direction: "to_qbo", action: "error", vireek_id: row.id, message: `Could not create in QuickBooks (${label}): ${w.message}`, tid: w.tid });
    return;
  }
  const m = recordMeta(w.record);
  // Base = what Vireek holds: a name QuickBooks sanitised later flows back as a normal QuickBooks edit.
  await createLink(ctx, entity, row.id, m.id, { ...mergeEntity({ entity, settings: es, base: null, vireek: vC, qbo: vC, vireekTs: null, qboTs: null }).next, ...(entity === "item" ? { __income: itemIncomeRef(w.record) } : {}) }, m.syncToken);
  ctx.stats.created_qbo++;
  log(ctx, { entity, direction: "to_qbo", action: "created", vireek_id: row.id, external_id: m.id, message: `Created in QuickBooks: ${label}` });
}

async function pullSimple(ctx: Ctx, entity: Simple): Promise<boolean> {
  const cur = ctx.cursors[entity]?.pull ?? { since: null, pos: 1, passStarted: null };
  const passStarted = cur.passStarted ?? new Date().toISOString();
  const sinceMs = cur.since ? Date.parse(cur.since) - PULL_OVERLAP_MS : null;
  let pos = cur.pos || 1;
  let seen = 0;

  // Records skipped earlier: retry by id first.
  for (const id of cur.retry ?? []) {
    const raw = isValidQboId(id) ? await fetchQbo(ctx, entity, id) : null;
    if (raw) await applyQboRecord(ctx, entity, raw);
  }

  while (true) {
    if (overDeadline(ctx)) {
      ctx.cursors[entity] = { ...ctx.cursors[entity], pull: { since: cur.since, pos, passStarted } };
      return false;
    }
    const records = await queryQbo(ctx, buildQueryRequest({ base: ctx.base, realm: ctx.realm, entity, since: sinceMs ? qboTimestamp(sinceMs) : null, pos, pageSize: QBO_QUERY_PAGE }), entity);
    for (const raw of records) await applyQboRecord(ctx, entity, raw);
    seen += records.length;
    pos += records.length;
    await touchRun(ctx);
    if (records.length < QBO_QUERY_PAGE) {
      ctx.cursors[entity] = { ...ctx.cursors[entity], pull: { since: passStarted, pos: 1, passStarted: null } };
      return true;
    }
    if (seen >= PAGE_CAP_PER_RUN) {
      ctx.cursors[entity] = { ...ctx.cursors[entity], pull: { since: cur.since, pos, passStarted } };
      return false;
    }
  }
}

async function pushSimple(ctx: Ctx, entity: Simple, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities[entity];
  if (es.direction === "from_qbo") return;
  const t = ENTITY_META[entity].table;
  let cur: PushState = ctx.cursors[entity]?.push ?? { ts: null, id: null };

  const handle = async (row: VRow) => {
    const link = await getLinkByVireek(ctx, entity, row.id);
    if (link) {
      if (!vireekChangedSinceBase(entity, link, row, es) && !link.conflict) return;
      const raw = await fetchQbo(ctx, entity, link.external_id);
      if (!raw) {
        warnOnce(ctx, `qgone:${link.id}`, { entity, direction: "none", action: "skipped", vireek_id: row.id, external_id: link.external_id, link_id: link.id, message: "Deleted in QuickBooks: not recreated and not changed in Vireek." });
        return;
      }
      await reconcile(ctx, entity, link, row, raw);
    } else if (canCreateInQbo(es) && pullDoneOnce) {
      await createInQbo(ctx, entity, row);
    }
  };

  while (!overDeadline(ctx)) {
    let q = ctx.admin.from(t).select(COLS[entity]).eq("user_id", ctx.ownerId).order("updated_at", { ascending: true }).order("id", { ascending: true }).limit(PUSH_PAGE);
    if (cur.ts) q = q.or(`updated_at.gt.${cur.ts},and(updated_at.eq.${cur.ts},id.gt.${cur.id})`);
    const { data, error } = await q;
    if (error) throw new Error(`Could not read ${t}: ${error.message}`);
    const rows = (data ?? []) as unknown as VRow[];
    for (const row of rows) {
      if (overDeadline(ctx)) break;
      await handle(row);
      cur = { ts: row.updated_at ?? cur.ts, id: row.id };
      ctx.cursors[entity] = { ...ctx.cursors[entity], push: cur };
    }
    await touchRun(ctx);
    if (rows.length < PUSH_PAGE) break;
  }
}

// ============================================================
// INVOICES
// ============================================================

interface VInvoice { row: VRow; lines: InvoiceLine[] }

async function loadInvoice(ctx: Ctx, id: string): Promise<VInvoice | null> {
  const { data } = await ctx.admin.from("ar_invoices").select(INVOICE_COLS).eq("id", id).eq("user_id", ctx.ownerId).maybeSingle();
  if (!data) return null;
  const { data: ls } = await ctx.admin.from("ar_invoice_lines").select("description, quantity, unit_price_cents, amount_cents, revenue_account_id").eq("invoice_id", id).order("line_number");
  const lines = ((ls ?? []) as Record<string, unknown>[]).map((l) => ({
    description: String(l.description ?? ""),
    qty: Number(l.quantity ?? 1),
    unitPriceCents: Number(l.unit_price_cents ?? 0),
    amountCents: Number(l.amount_cents ?? 0),
    itemId: null,
  }));
  return { row: data as VRow, lines };
}

function invoiceVireekCanon(v: VInvoice): Canon {
  const voided = v.row.status === "void";
  return {
    due_date: v.row.due_date as string,
    amounts: voided ? null : invoiceAmountSig({ lines: v.lines, taxCents: Number(v.row.tax_cents), totalCents: Number(v.row.total_cents) }),
    voided: voided ? "void" : "active",
  };
}
function invoiceQboCanon(d: QboInvoiceDoc): Canon {
  return { due_date: d.dueDate, amounts: d.voided ? null : invoiceAmountSig(d), voided: d.voided ? "void" : "active" };
}

async function itemMap(ctx: Ctx): Promise<Map<string, string>> {
  if (ctx.itemByName) return ctx.itemByName;
  const map = new Map<string, string>();
  const { data: links } = await ctx.admin.from("qbo_record_links").select("vireek_id, external_id").eq("connection_id", ctx.conn.id).eq("entity", "item");
  const ids = ((links ?? []) as { vireek_id: string; external_id: string }[]);
  if (ids.length) {
    const { data: items } = await ctx.admin.from("price_book_items").select("id, service_name").eq("user_id", ctx.ownerId).in("id", ids.map((l) => l.vireek_id));
    const ext = new Map(ids.map((l) => [l.vireek_id, l.external_id]));
    for (const it of (items ?? []) as { id: string; service_name: string }[]) map.set(it.service_name.toLowerCase().replace(/\s+/g, " ").trim(), ext.get(it.id)!);
  }
  ctx.itemByName = map;
  return map;
}

/** Revenue account (Vireek id) for an inbound line: the item's income account when synced, else the default. */
async function revenueAccountFor(ctx: Ctx, itemId: string | null): Promise<string | null> {
  if (!itemId) return null;
  const il = await getLinkByExternal(ctx, "item", itemId);
  const income = il?.base?.__income;
  if (typeof income !== "string") return null;
  return (await getLinkByExternal(ctx, "account", income))?.vireek_id ?? null;
}

const linesJson = async (ctx: Ctx, lines: InvoiceLine[]) =>
  Promise.all(lines.map(async (l) => ({ description: l.description, quantity: l.qty, unit_price_cents: l.unitPriceCents, amount_cents: l.amountCents, revenue_account_id: await revenueAccountFor(ctx, l.itemId) })));

const isPaymentsBlock = (msg: string) => /PAYMENTS_EXIST/.test(msg);

async function reconcileInvoice(
  ctx: Ctx,
  link: LinkRow | null,
  v: VInvoice,
  doc: QboInvoiceDoc,
  opts: { ruleOverride?: "vireek_wins" | "qbo_wins"; note?: string } = {},
): Promise<Outcome> {
  const es = ctx.settings.entities.invoice;
  const vC = invoiceVireekCanon(v);
  const qC = invoiceQboCanon(doc);
  const res = mergeEntity({ entity: "invoice", settings: es, base: stripMeta(link?.base ?? null), vireek: vC, qbo: qC, vireekTs: tsOf(v.row), qboTs: doc.modifiedAt, ruleOverride: opts.ruleOverride });
  const next: Canon = { ...res.next };
  const blocked: string[] = [];
  const reasons: string[] = [];
  let syncToken = doc.syncToken;
  let failed = false;
  const id = v.row.id;
  const ext = doc.id;
  const fail = (direction: "to_qbo" | "from_qbo", message: string, tid?: string | null) => {
    failed = true;
    ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction, action: "error", vireek_id: id, external_id: ext, link_id: link?.id, message, tid });
  };
  const block = (field: string, reason: string) => {
    blocked.push(field);
    reasons.push(reason);
  };

  // ---- void ----
  if (res.toVireek.voided === "void") {
    const { error } = await ctx.admin.rpc("qbo_void_ar_invoice", { p_owner: ctx.ownerId, p_invoice_id: id });
    if (error) {
      if (isPaymentsBlock(error.message)) block("voided", "Voided in QuickBooks, but Vireek has payments on this invoice. Void or refund the payments in Vireek first.");
      else fail("from_qbo", `Could not void in Vireek: ${error.message}`);
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity: "invoice", direction: "from_qbo", action: "voided", vireek_id: id, external_id: ext, link_id: link?.id, message: "Voided to match QuickBooks" });
    }
  }
  if (res.toCrm.voided === "void") {
    const r = await api(ctx, buildVoidRequest({ base: ctx.base, realm: ctx.realm, id: ext, syncToken }));
    if (classifyResponse(r.status, r.json).kind === "ok") {
      ctx.stats.updated_qbo++;
      log(ctx, { entity: "invoice", direction: "to_qbo", action: "voided", vireek_id: id, external_id: ext, link_id: link?.id, message: "Voided to match Vireek" });
    } else fail("to_qbo", `QuickBooks could not void the invoice: ${faultText(r)}`, r.tid);
  }
  const voidedNow = vC.voided === "void" || qC.voided === "void" || res.toVireek.voided === "void" || res.toCrm.voided === "void";

  // ---- amounts (never when a void is involved) ----
  if (!voidedNow && typeof res.toVireek.amounts === "string") {
    const { error } = await ctx.admin.rpc("qbo_replace_ar_invoice", {
      p_owner: ctx.ownerId, p_invoice_id: id, p_issue_date: doc.txnDate, p_due_date: doc.dueDate, p_tax_cents: doc.taxCents, p_lines: await linesJson(ctx, doc.lines),
    });
    if (error) {
      if (isPaymentsBlock(error.message)) block("amounts", "Amounts changed in QuickBooks after a payment was recorded in Vireek. Review it, then choose which side to keep.");
      else fail("from_qbo", `Could not apply QuickBooks amounts: ${error.message}`);
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity: "invoice", direction: "from_qbo", action: "updated", vireek_id: id, external_id: ext, link_id: link?.id, message: "Line items and totals updated from QuickBooks" });
    }
  }
  const pushAmounts = !voidedNow && typeof res.toCrm.amounts === "string";
  const pushDue = !voidedNow && res.toCrm.due_date !== undefined;
  if (pushAmounts || pushDue) {
    const customer = v.row.customer_id ? await getLinkByVireek(ctx, "customer", String(v.row.customer_id)) : null;
    const resolved = resolveLineItems(v.lines, await itemMap(ctx), ctx.settings.defaults.fallbackItemId);
    if (!customer) block("amounts", "The customer is not linked to QuickBooks yet.");
    else if (!resolved.ok) block("amounts", resolved.reason);
    else {
      const payload = buildQboInvoicePayload(
        { invoiceNumber: String(v.row.invoice_number), issueDate: String(v.row.issue_date), dueDate: String(v.row.due_date), taxCents: Number(v.row.tax_cents), lines: resolved.lines },
        customer.external_id, { defaults: ctx.settings.defaults }, { id: ext, syncToken },
      );
      const w = await writeQbo(ctx, "invoice", payload);
      if (w.ok) {
        syncToken = recordMeta(w.record).syncToken;
        ctx.stats.updated_qbo++;
        log(ctx, { entity: "invoice", direction: "to_qbo", action: "updated", vireek_id: id, external_id: ext, link_id: link?.id, message: "Invoice updated in QuickBooks" });
        warnTotals(ctx, v, w.record, ext);
      } else {
        if (pushAmounts) block("amounts", `QuickBooks rejected the update: ${w.message}`);
        fail("to_qbo", `QuickBooks rejected the invoice update: ${w.message}`, w.tid);
      }
    }
  }

  // ---- due date (no ledger impact) ----
  if (res.toVireek.due_date !== undefined && res.toVireek.due_date !== null) {
    const { error } = await ctx.admin.from("ar_invoices").update({ due_date: res.toVireek.due_date }).eq("id", id).eq("user_id", ctx.ownerId);
    if (error) fail("from_qbo", `Could not update the due date: ${error.message}`);
    else ctx.stats.updated_vireek++;
  }

  for (const f of blocked) next[f] = link?.base?.[f] ?? null;
  const fields = [...new Set([...res.conflicts.map((c) => c.field), ...blocked])];
  let conflict: LinkRow["conflict"] = null;
  if (fields.length) {
    const sig = conflictSig(fields, vC, qC);
    conflict = { fields, sig, ...(reasons.length ? { reason: reasons[0] } : {}) };
    if (link?.conflict?.sig !== sig) {
      ctx.stats.conflicts++;
      log(ctx, { entity: "invoice", direction: "none", action: "conflict", vireek_id: id, external_id: ext, link_id: link?.id, message: reasons[0] ?? `Both sides changed: ${fields.join(", ")}`, details: res.conflicts });
    }
  }
  if (link) await saveLink(ctx, link, { base: next, sync_token: syncToken, conflict });
  else await createLink(ctx, "invoice", id, ext, next, syncToken);
  return failed ? "error" : conflict ? "conflict" : "ok";
}

function warnTotals(ctx: Ctx, v: VInvoice, rec: RawRecord, ext: string) {
  const expected = Number(v.row.total_cents);
  if (toCents(rec.TotalAmt) !== expected) {
    log(ctx, { entity: "invoice", direction: "to_qbo", action: "conflict", vireek_id: v.row.id, external_id: ext, message: `QuickBooks total (${toCents(rec.TotalAmt) / 100}) differs from Vireek (${expected / 100}); QuickBooks calculates its own sales tax. Check the tax code under Mapping → Defaults.` });
    ctx.stats.conflicts++;
  }
}

async function applyQboInvoice(ctx: Ctx, raw: RawRecord): Promise<"retry" | void> {
  const es = ctx.settings.entities.invoice;
  const meta = recordMeta(raw);
  if (!meta.id) return;
  const parsed = parseQboInvoice(raw);
  if (!parsed.ok) {
    ctx.stats.skipped++;
    warnOnce(ctx, `inv:${meta.id}:${meta.syncToken}`, { entity: "invoice", direction: "from_qbo", action: "skipped", external_id: meta.id, message: `Invoice ${String(raw.DocNumber ?? meta.id)} skipped: ${parsed.reason}` });
    return;
  }
  const doc = parsed.doc;
  const link = await getLinkByExternal(ctx, "invoice", doc.id);
  if (link) {
    const v = await loadInvoice(ctx, link.vireek_id);
    if (!v) {
      ctx.stats.skipped++;
      return;
    }
    await reconcileInvoice(ctx, link, v, doc);
    return;
  }
  if (doc.voided) return;

  // Match an invoice both sides already have (same number and total) instead of duplicating it.
  if (doc.docNumber) {
    const { data } = await ctx.admin.from("ar_invoices").select("id").eq("user_id", ctx.ownerId).eq("invoice_number", doc.docNumber).eq("total_cents", doc.totalCents).maybeSingle();
    if (data && !(await getLinkByVireek(ctx, "invoice", (data as unknown as VRow).id))) {
      const v = await loadInvoice(ctx, (data as unknown as VRow).id);
      if (v) {
        await reconcileInvoice(ctx, null, v, doc, { note: "Matched an existing invoice" });
        log(ctx, { entity: "invoice", direction: "both", action: "linked", vireek_id: v.row.id, external_id: doc.id, message: `Linked to existing invoice ${doc.docNumber}` });
        return;
      }
    }
  }
  if (!canCreateInVireek(es)) {
    ctx.stats.skipped++;
    return;
  }
  const cust = doc.customerId ? await getLinkByExternal(ctx, "customer", doc.customerId) : null;
  if (!cust) {
    warnOnce(ctx, `invcust:${doc.id}`, { entity: "invoice", direction: "from_qbo", action: "skipped", external_id: doc.id, message: `Invoice ${doc.docNumber ?? doc.id} waits for its customer to sync (enable Customers, then Sync now).` });
    return "retry";
  }
  if (doc.totalCents <= 0) {
    ctx.stats.skipped++;
    return;
  }
  const { data: newId, error } = await ctx.admin.rpc("qbo_create_ar_invoice", {
    p_owner: ctx.ownerId, p_customer_id: cust.vireek_id, p_issue_date: doc.txnDate, p_due_date: doc.dueDate, p_tax_cents: doc.taxCents, p_lines: await linesJson(ctx, doc.lines), p_invoice_number: doc.docNumber,
  });
  if (error || !newId) {
    ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction: "from_qbo", action: "error", external_id: doc.id, message: `Could not create invoice ${doc.docNumber ?? doc.id}: ${error?.message ?? "no id"}` });
    return;
  }
  const v = await loadInvoice(ctx, newId as string);
  await createLink(ctx, "invoice", newId as string, doc.id, v ? invoiceVireekCanon(v) : invoiceQboCanon(doc), doc.syncToken);
  ctx.stats.created_vireek++;
  log(ctx, { entity: "invoice", direction: "from_qbo", action: "created", vireek_id: newId as string, external_id: doc.id, message: `Created invoice ${doc.docNumber ?? doc.id} from QuickBooks` });
}

const PUSHABLE = new Set(["sent", "partially_paid", "paid", "overdue"]);

async function createInvoiceInQbo(ctx: Ctx, v: VInvoice): Promise<"retry" | void> {
  if (!PUSHABLE.has(String(v.row.status))) return;
  const customer = v.row.customer_id ? await getLinkByExternalOrVireek(ctx, String(v.row.customer_id)) : null;
  if (!customer) {
    warnOnce(ctx, `vinvcust:${v.row.id}`, { entity: "invoice", direction: "to_qbo", action: "skipped", vireek_id: v.row.id, message: `Invoice ${String(v.row.invoice_number)} waits for its customer to be linked to QuickBooks.` });
    return "retry";
  }
  const resolved = resolveLineItems(v.lines, await itemMap(ctx), ctx.settings.defaults.fallbackItemId);
  if (!resolved.ok) {
    warnOnce(ctx, `vinvitem:${v.row.invoice_number}`, { entity: "invoice", direction: "to_qbo", action: "skipped", vireek_id: v.row.id, message: `Invoice ${String(v.row.invoice_number)} not sent: ${resolved.reason}` });
    return "retry";
  }
  // An invoice QuickBooks already has under this number is linked, not duplicated.
  if (ctx.settings.defaults.sendDocNumber) {
    const found = await queryQbo(ctx, buildFindRequest({ base: ctx.base, realm: ctx.realm, entity: "invoice", field: "DocNumber", value: String(v.row.invoice_number) }), "invoice");
    for (const r of found) {
      const p = parseQboInvoice(r);
      if (p.ok && p.doc.totalCents === Number(v.row.total_cents) && !(await getLinkByExternal(ctx, "invoice", p.doc.id))) {
        await reconcileInvoice(ctx, null, v, p.doc, { note: "Matched an existing QuickBooks invoice" });
        log(ctx, { entity: "invoice", direction: "both", action: "linked", vireek_id: v.row.id, external_id: p.doc.id, message: `Linked to existing QuickBooks invoice ${String(v.row.invoice_number)}` });
        return;
      }
    }
  }
  const payload = buildQboInvoicePayload(
    { invoiceNumber: String(v.row.invoice_number), issueDate: String(v.row.issue_date), dueDate: String(v.row.due_date), taxCents: Number(v.row.tax_cents), lines: resolved.lines },
    customer.external_id, { defaults: ctx.settings.defaults },
  );
  const w = await writeQbo(ctx, "invoice", payload, rid("vk-i", String(v.row.id)));
  if (!w.ok) {
    ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction: "to_qbo", action: "error", vireek_id: v.row.id, message: `Could not create invoice ${String(v.row.invoice_number)} in QuickBooks: ${w.message}`, tid: w.tid });
    return;
  }
  const m = recordMeta(w.record);
  await createLink(ctx, "invoice", String(v.row.id), m.id, invoiceVireekCanon(v), m.syncToken);
  ctx.stats.created_qbo++;
  log(ctx, { entity: "invoice", direction: "to_qbo", action: "created", vireek_id: String(v.row.id), external_id: m.id, message: `Created invoice ${String(v.row.invoice_number)} in QuickBooks` });
  warnTotals(ctx, v, w.record, m.id);
}

const getLinkByExternalOrVireek = (ctx: Ctx, customerVireekId: string) => getLinkByVireek(ctx, "customer", customerVireekId);

async function pullInvoices(ctx: Ctx): Promise<boolean> {
  return pullGeneric(ctx, "invoice", async (raw) => applyQboInvoice(ctx, raw));
}

async function pushInvoices(ctx: Ctx, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities.invoice;
  if (es.direction === "from_qbo") return;
  const cursor = ctx.cursors.invoice?.push ?? { ts: null, id: null };
  let cur: PushState = cursor;

  const handle = async (id: string): Promise<"retry" | void> => {
    const v = await loadInvoice(ctx, id);
    if (!v) return;
    const link = await getLinkByVireek(ctx, "invoice", id);
    if (link) {
      const vC = invoiceVireekCanon(v);
      const changed = (["due_date", "amounts", "voided"] as const).some((k) => normalizeValue(VIREEK_FIELDS.invoice.find((f) => f.key === k)!.type, vC[k]) !== normalizeValue(VIREEK_FIELDS.invoice.find((f) => f.key === k)!.type, link.base?.[k]));
      if (!changed && !link.conflict) return;
      const raw = await fetchQbo(ctx, "invoice", link.external_id);
      const p = raw ? parseQboInvoice(raw) : null;
      if (!p || !p.ok) {
        if (p && !p.ok) warnOnce(ctx, `inv:${link.external_id}`, { entity: "invoice", direction: "none", action: "skipped", vireek_id: id, external_id: link.external_id, link_id: link.id, message: `QuickBooks invoice cannot be compared: ${p.reason}` });
        return;
      }
      await reconcileInvoice(ctx, link, v, p.doc);
      return;
    }
    if (canCreateInQbo(es) && pullDoneOnce) return createInvoiceInQbo(ctx, v);
  };

  const retryIds = [...(ctx.cursors.invoice?.push?.retry ?? [])];
  const stillRetry: string[] = [];
  for (const id of retryIds) if ((await handle(id)) === "retry") stillRetry.push(id);

  while (!overDeadline(ctx)) {
    let q = ctx.admin.from("ar_invoices").select("id, updated_at").eq("user_id", ctx.ownerId).order("updated_at", { ascending: true }).order("id", { ascending: true }).limit(PUSH_PAGE);
    if (cur.ts) q = q.or(`updated_at.gt.${cur.ts},and(updated_at.eq.${cur.ts},id.gt.${cur.id})`);
    const { data, error } = await q;
    if (error) throw new Error(`Could not read ar_invoices: ${error.message}`);
    const rows = (data ?? []) as VRow[];
    for (const row of rows) {
      if (overDeadline(ctx)) break;
      if ((await handle(row.id)) === "retry") stillRetry.push(row.id);
      cur = { ts: row.updated_at ?? cur.ts, id: row.id };
      ctx.cursors.invoice = { ...ctx.cursors.invoice, push: { ...cur, retry: [...new Set(stillRetry)].slice(-RETRY_CAP) } };
    }
    await touchRun(ctx);
    if (rows.length < PUSH_PAGE) break;
  }
  ctx.cursors.invoice = { ...ctx.cursors.invoice, push: { ...cur, retry: [...new Set(stillRetry)].slice(-RETRY_CAP) } };
}

// ============================================================
// PAYMENTS (create-only)
// ============================================================

async function applyQboPayment(ctx: Ctx, raw: RawRecord): Promise<"retry" | void> {
  const es = ctx.settings.entities.payment;
  const doc = parseQboPayment(raw);
  if (!doc) return;
  if (doc.voided) {
    warnOnce(ctx, `pv:${doc.id}`, { entity: "payment", direction: "from_qbo", action: "skipped", external_id: doc.id, message: "Payment voided in QuickBooks. Payments are never reversed automatically: void it in Vireek if needed." });
    return;
  }
  if (!canCreateInVireek(es)) return;
  let retry = false;
  for (const app of doc.applications) {
    const key = paymentLinkKey(doc.id, app.invoiceId);
    if (await getLinkByExternal(ctx, "payment", key)) continue;
    const invLink = await getLinkByExternal(ctx, "invoice", app.invoiceId);
    if (!invLink) {
      warnOnce(ctx, `pi:${key}`, { entity: "payment", direction: "from_qbo", action: "skipped", external_id: key, message: `Payment ${doc.id} waits for its invoice to sync.` });
      retry = true;
      continue;
    }
    const inv = await loadInvoice(ctx, invLink.vireek_id);
    if (!inv || inv.row.status === "void") continue;
    const remaining = Number(inv.row.total_cents) - Number(inv.row.amount_paid_cents);
    if (app.amountCents > remaining) {
      ctx.stats.errors++;
      log(ctx, { entity: "payment", direction: "from_qbo", action: "error", external_id: key, vireek_id: inv.row.id, message: `Payment of ${app.amountCents / 100} exceeds the Vireek balance of ${remaining / 100}. Not recorded.` });
      continue;
    }
    const dep = doc.depositAccountId ? await getLinkByExternal(ctx, "account", doc.depositAccountId) : null;
    const { data: payId, error } = await ctx.admin.rpc("qbo_record_ar_payment", {
      p_owner: ctx.ownerId, p_invoice_id: inv.row.id, p_amount_cents: app.amountCents, p_method: paymentMethodFromName(doc.methodName), p_date: doc.txnDate, p_deposit_account_id: dep?.vireek_id ?? null,
    });
    if (error || !payId) {
      ctx.stats.errors++;
      log(ctx, { entity: "payment", direction: "from_qbo", action: "error", external_id: key, vireek_id: inv.row.id, message: `Could not record the payment: ${error?.message ?? "no id"}` });
      continue;
    }
    await createLink(ctx, "payment", payId as string, key, {}, null);
    ctx.stats.created_vireek++;
    log(ctx, { entity: "payment", direction: "from_qbo", action: "created", vireek_id: payId as string, external_id: key, message: `Recorded payment of ${app.amountCents / 100} from QuickBooks` });
  }
  return retry ? "retry" : undefined;
}

async function pushPayments(ctx: Ctx, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities.payment;
  if (!canCreateInQbo(es) || !pullDoneOnce) return;
  let cur: PushState = ctx.cursors.payment?.push ?? { ts: null, id: null };
  const stillRetry: string[] = [];

  const handle = async (p: VRow): Promise<"retry" | void> => {
    if (await getLinkByVireek(ctx, "payment", p.id)) return;
    const invLink = await getLinkByVireek(ctx, "invoice", String(p.invoice_id));
    const { data: inv } = await ctx.admin.from("ar_invoices").select("customer_id, status, invoice_number").eq("id", p.invoice_id).eq("user_id", ctx.ownerId).maybeSingle();
    const invRow = inv as unknown as VRow | null;
    if (!invRow || invRow.status === "void") return;
    const custLink = invRow.customer_id ? await getLinkByVireek(ctx, "customer", String(invRow.customer_id)) : null;
    if (!invLink || !custLink) {
      warnOnce(ctx, `vp:${p.id}`, { entity: "payment", direction: "to_qbo", action: "skipped", vireek_id: p.id, message: `Payment on invoice ${String(invRow.invoice_number)} waits for the invoice and customer to be linked to QuickBooks.` });
      return "retry";
    }
    const dep = p.deposit_account_id ? await getLinkByVireek(ctx, "account", String(p.deposit_account_id)) : null;
    const payload = buildQboPaymentPayload({
      customerId: custLink.external_id, invoiceId: invLink.external_id, amountCents: Number(p.amount_cents), date: String(p.payment_date),
      depositAccountId: dep?.external_id ?? ctx.settings.defaults.depositAccountId, note: `Vireek payment ${p.id} (${String(p.payment_method)})`,
    });
    const w = await writeQbo(ctx, "payment", payload, rid("vk-p", p.id));
    if (!w.ok) {
      ctx.stats.errors++;
      log(ctx, { entity: "payment", direction: "to_qbo", action: "error", vireek_id: p.id, message: `Could not create the payment in QuickBooks: ${w.message}`, tid: w.tid });
      return;
    }
    const key = paymentLinkKey(recordMeta(w.record).id, invLink.external_id);
    await createLink(ctx, "payment", p.id, key, {}, recordMeta(w.record).syncToken);
    ctx.stats.created_qbo++;
    log(ctx, { entity: "payment", direction: "to_qbo", action: "created", vireek_id: p.id, external_id: key, message: `Sent payment of ${Number(p.amount_cents) / 100} to QuickBooks` });
  };

  for (const id of ctx.cursors.payment?.push?.retry ?? []) {
    const { data } = await ctx.admin.from("ar_payments").select(PAYMENT_COLS).eq("id", id).eq("user_id", ctx.ownerId).maybeSingle();
    if (data && (await handle(data as VRow)) === "retry") stillRetry.push(id);
  }
  while (!overDeadline(ctx)) {
    let q = ctx.admin.from("ar_payments").select(PAYMENT_COLS).eq("user_id", ctx.ownerId).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(PUSH_PAGE);
    if (cur.ts) q = q.or(`created_at.gt.${cur.ts},and(created_at.eq.${cur.ts},id.gt.${cur.id})`);
    const { data, error } = await q;
    if (error) throw new Error(`Could not read ar_payments: ${error.message}`);
    const rows = (data ?? []) as VRow[];
    for (const row of rows) {
      if (overDeadline(ctx)) break;
      if ((await handle(row)) === "retry") stillRetry.push(row.id);
      cur = { ts: String(row.created_at), id: row.id };
      ctx.cursors.payment = { ...ctx.cursors.payment, push: { ...cur, retry: [...new Set(stillRetry)].slice(-RETRY_CAP) } };
    }
    await touchRun(ctx);
    if (rows.length < PUSH_PAGE) break;
  }
  ctx.cursors.payment = { ...ctx.cursors.payment, push: { ...cur, retry: [...new Set(stillRetry)].slice(-RETRY_CAP) } };
}

// ============================================================
// GENERIC PULL (invoices, payments)
// ============================================================

async function pullGeneric(ctx: Ctx, entity: "invoice" | "payment", apply: (raw: RawRecord) => Promise<"retry" | void>): Promise<boolean> {
  const cur = ctx.cursors[entity]?.pull ?? { since: null, pos: 1, passStarted: null };
  const passStarted = cur.passStarted ?? new Date().toISOString();
  const sinceMs = cur.since ? Date.parse(cur.since) - PULL_OVERLAP_MS : null;
  let pos = cur.pos || 1;
  let seen = 0;
  let retry: string[] = [];

  for (const id of cur.retry ?? []) {
    const raw = isValidQboId(id) ? await fetchQbo(ctx, entity, id) : null;
    if (raw && (await apply(raw)) === "retry") retry = addRetry(retry, id);
  }
  const save = (state: Omit<PullState, "retry">) => {
    ctx.cursors[entity] = { ...ctx.cursors[entity], pull: { ...state, retry } };
  };

  while (true) {
    if (overDeadline(ctx)) {
      save({ since: cur.since, pos, passStarted });
      return false;
    }
    const records = await queryQbo(ctx, buildQueryRequest({ base: ctx.base, realm: ctx.realm, entity, since: sinceMs ? qboTimestamp(sinceMs) : null, pos, pageSize: QBO_QUERY_PAGE }), entity);
    for (const raw of records) {
      if ((await apply(raw)) === "retry") retry = addRetry(retry, recordMeta(raw).id);
    }
    seen += records.length;
    pos += records.length;
    await touchRun(ctx);
    if (records.length < QBO_QUERY_PAGE) {
      save({ since: passStarted, pos: 1, passStarted: null });
      return true;
    }
    if (seen >= PAGE_CAP_PER_RUN) {
      save({ since: cur.since, pos, passStarted });
      return false;
    }
  }
}

// ============================================================
// RUN LIFECYCLE
// ============================================================

async function acquireLock(admin: AnyClient, connId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await admin
    .from("qbo_connections")
    .update({ sync_locked_until: new Date(Date.now() + LOCK_MS).toISOString() })
    .eq("id", connId)
    .or(`sync_locked_until.is.null,sync_locked_until.lt.${now}`)
    .select("id");
  return (data?.length ?? 0) > 0;
}

async function buildCtx(admin: AnyClient, conn: ConnRow, runId: string | null, deadline: number): Promise<Ctx> {
  const encKey = Deno.env.get("QBO_TOKEN_ENCRYPTION_KEY") ?? "";
  const { data: sec } = await admin.from("qbo_connection_secrets").select("access_token_enc, refresh_token_enc, expires_at").eq("connection_id", conn.id).maybeSingle();
  if (!sec || !encKey) throw new AuthError("No stored credentials. Please reconnect.");
  const valid = validateSettings(conn.settings && Object.keys(conn.settings as object).length ? conn.settings : defaultSettings());
  if (!valid.ok) throw new Error(`Saved settings are invalid: ${valid.error}`);
  const base = apiBaseFor(conn.environment === "sandbox" ? "sandbox" : "production");
  const ctx: Ctx = {
    admin, conn, ownerId: conn.user_id, realm: conn.realm_id, base, settings: valid.settings, cursors: { ...(conn.cursors ?? {}) },
    runId, stats: emptyStats(), logs: [], deadline,
    access: await decryptSecret(sec.access_token_enc as string, encKey),
    refresh: await decryptSecret(sec.refresh_token_enc as string, encKey),
    lastProgressAt: 0, warned: new Set(),
  };
  const exp = sec.expires_at ? Date.parse(sec.expires_at as string) : null;
  if (exp !== null && exp - Date.now() < 120_000) await refreshAccess(ctx);
  return ctx;
}

async function mirrorIntegration(admin: AnyClient, conn: ConnRow, status: "connected" | "error" | "disconnected", extra: Record<string, unknown> = {}) {
  const { data: c } = await admin.from("qbo_connections").select("company_name, environment, realm_id").eq("id", conn.id).maybeSingle();
  await admin.from("integrations").upsert(
    { user_id: conn.user_id, integration_type: "quickbooks", status, config: { realm_id: c?.realm_id ?? conn.realm_id, company_name: c?.company_name ?? null, environment: c?.environment ?? conn.environment, ...extra } },
    { onConflict: "user_id,integration_type" },
  );
}

async function executeRun(admin: AnyClient, conn: ConnRow, runId: string) {
  let ctx: Ctx | null = null;
  let status: "success" | "partial" | "failed" = "success";
  let error: string | null = null;
  let markError = false;
  let allFinished = true;
  let errorCode: string | null = null;

  try {
    await admin.from("qbo_sync_log").delete().eq("connection_id", conn.id).lt("created_at", new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString());
    ctx = await buildCtx(admin, conn, runId, Date.now() + RUN_BUDGET_MS);
    let dependenciesDone = true;

    for (const entity of QBO_ENTITIES) {
      const es = ctx.settings.entities[entity];
      if (!es.enabled) continue;
      if (overDeadline(ctx)) {
        allFinished = false;
        break;
      }
      // Invoices and payments need their customers / items / accounts fully synced first.
      if ((entity === "invoice" || entity === "payment") && !dependenciesDone) {
        allFinished = false;
        continue;
      }
      let finished: boolean;
      if (entity === "invoice") finished = es.direction === "to_qbo" ? true : await pullInvoices(ctx);
      else if (entity === "payment") finished = es.direction === "to_qbo" ? true : await pullGeneric(ctx, "payment", (raw) => applyQboPayment(ctx!, raw));
      else finished = es.direction === "to_qbo" ? true : await pullSimple(ctx, entity);
      if (!finished) {
        allFinished = false;
        if (entity !== "invoice" && entity !== "payment") dependenciesDone = false;
      }
      const pullDoneOnce = es.direction === "to_qbo" || !!ctx.cursors[entity]?.pull?.since;
      if (entity === "invoice") await pushInvoices(ctx, pullDoneOnce);
      else if (entity === "payment") await pushPayments(ctx, pullDoneOnce);
      else await pushSimple(ctx, entity, pullDoneOnce);
    }
    if (!allFinished || overDeadline(ctx)) {
      status = "partial";
      error = "Large sync in progress. It will continue automatically on the next run.";
    }
    if (ctx.stats.errors > 0 && status === "success") status = "partial";
  } catch (err) {
    status = "failed";
    if (err instanceof AuthError) {
      markError = true;
      errorCode = "token_revoked";
      error = "QuickBooks needs to be re-authorised. Disconnect and connect again.";
    } else if (err instanceof RateLimitError) {
      status = "partial";
      error = "QuickBooks is rate limiting requests. The sync will retry on the next run.";
    } else {
      error = err instanceof Error ? err.message.slice(0, 400) : "Unexpected sync error.";
      console.error("qbo-sync-run failed", conn.id, err);
    }
  } finally {
    if (ctx) {
      await flushLogs(ctx);
      if (ctx.runId) await admin.from("qbo_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
    }
    await admin.from("qbo_sync_runs").update({ status, error, finished_at: new Date().toISOString(), ...(ctx ? { stats: ctx.stats } : {}) }).eq("id", runId);
    await admin
      .from("qbo_connections")
      .update({
        sync_locked_until: null,
        ...(ctx ? { cursors: ctx.cursors } : {}),
        ...(status !== "failed" || !markError ? {} : { status: "error" }),
        ...(status === "failed" ? { last_error: error } : { last_error: status === "partial" ? error : null, last_synced_at: new Date().toISOString() }),
      })
      .eq("id", conn.id);
    if (markError) await mirrorIntegration(admin, conn, "error", { error_code: errorCode, error_message: error, failed_at: new Date().toISOString() });
    else if (status !== "failed") await mirrorIntegration(admin, conn, "connected", { last_synced_at: new Date().toISOString() });
  }
}

async function beginRun(admin: AnyClient, conn: ConnRow, trigger: "manual" | "scheduled" | "webhook"): Promise<string | null> {
  if (!(await acquireLock(admin, conn.id))) return null;
  await admin.from("qbo_sync_runs").update({ status: "failed", error: "Interrupted.", finished_at: new Date().toISOString() }).eq("connection_id", conn.id).eq("status", "running").lt("started_at", new Date(Date.now() - 10 * 60_000).toISOString());
  const { data } = await admin.from("qbo_sync_runs").insert({ user_id: conn.user_id, connection_id: conn.id, trigger, status: "running" }).select("id").single();
  if (!data) {
    await admin.from("qbo_connections").update({ sync_locked_until: null }).eq("id", conn.id);
    return null;
  }
  return data.id as string;
}

const background = (p: Promise<unknown>) => {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(p);
  else void p;
};

const CONN_COLS = "id, user_id, realm_id, environment, status, settings, cursors";

/** Live lists for the mapping UI (accounts / items / tax codes). Names only; never cached or stored. */
async function listOptions(ctx: Ctx) {
  const pick = async (entity: QboEntity, extra = "") => {
    const q = `select Id, Name, AccountType, Classification, Type from ${ENTITY_META[entity].qboObject} where Active = true${extra} maxresults 500`;
    const r = await api(ctx, { method: "GET", url: `${ctx.base}/v3/company/${ctx.realm}/query?minorversion=75&query=${encodeURIComponent(q)}` });
    const rows = ((r.json as { QueryResponse?: Record<string, RawRecord[]> } | null)?.QueryResponse?.[ENTITY_META[entity].qboObject] ?? []) as RawRecord[];
    return rows.map((x) => ({ id: String(x.Id), name: String(x.Name), type: String(x.AccountType ?? x.Type ?? ""), classification: String(x.Classification ?? "") }));
  };
  const accounts = await pick("account");
  const items = (await pick("item")).filter((i) => i.type === "Service" || i.type === "NonInventory");
  const tq = await api(ctx, { method: "GET", url: `${ctx.base}/v3/company/${ctx.realm}/query?minorversion=75&query=${encodeURIComponent("select Id, Name from TaxCode where Active = true maxresults 200")}` });
  const taxCodes = (((tq.json as { QueryResponse?: { TaxCode?: RawRecord[] } } | null)?.QueryResponse?.TaxCode ?? []) as RawRecord[]).map((x) => ({ id: String(x.Id), name: String(x.Name) }));
  return { accounts, items, taxCodes };
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

  // ---- scheduled sync + webhook ------------------------------------------
  if (body.action === "cron" || body.action === "webhook") {
    const secret = Deno.env.get("CRON_SECRET");
    if (!secret || req.headers.get("X-Cron-Secret") !== secret) return json({ error: "Forbidden" }, 403);
    let q = admin.from("qbo_connections").select(CONN_COLS).eq("status", "connected");
    let trigger: "scheduled" | "webhook" = "scheduled";
    if (body.action === "webhook") {
      const realms = Array.isArray(body.realm_ids) ? (body.realm_ids as unknown[]).filter((r): r is string => typeof r === "string" && /^\d{6,20}$/.test(r)) : [];
      if (!realms.length) return json({ queued: 0 }, 202);
      q = q.in("realm_id", realms);
      trigger = "webhook";
    } else {
      const due = new Date(Date.now() - 14 * 60_000).toISOString();
      q = q.eq("auto_sync", true).or(`last_synced_at.is.null,last_synced_at.lt.${due}`).order("last_synced_at", { ascending: true, nullsFirst: true }).limit(5);
    }
    const { data: conns } = await q;
    background((async () => {
      for (const c of (conns ?? []) as ConnRow[]) {
        const runId = await beginRun(admin, c, trigger);
        if (runId) await executeRun(admin, c, runId);
      }
    })());
    return json({ queued: conns?.length ?? 0 }, 202);
  }

  // ---- user actions ------------------------------------------------------
  const authHeaderValue = req.headers.get("Authorization");
  if (!authHeaderValue) return json({ error: "Missing Authorization header" }, 401);
  const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authHeaderValue } }, auth: { persistSession: false } });
  const { data: userData } = await caller.auth.getUser();
  if (!userData?.user) return json({ error: "Not authenticated" }, 401);
  const { data: ownerData } = await caller.rpc("get_account_owner_id");
  if (!ownerData) return json({ error: "Could not resolve your account." }, 401);
  const ownerId = ownerData as string;
  const { data: allowed } = await caller.rpc("can_manage_quickbooks");
  if (allowed !== true) return json({ error: "You don't have permission to manage QuickBooks sync." }, 403);

  const loadConn = async (id: unknown): Promise<ConnRow | null> => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data } = await admin.from("qbo_connections").select(CONN_COLS).eq("id", id).eq("user_id", ownerId).maybeSingle();
    return (data as ConnRow | null) ?? null;
  };

  if (body.action === "run" || body.action === "resync") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    if (conn.status === "disconnected") return json({ error: "QuickBooks is disconnected." }, 409);
    const runId = await beginRun(admin, conn, "manual");
    if (!runId) return json({ error: "A sync is already running." }, 409);
    // Full re-read: merge is idempotent, so this only repairs; it never duplicates or overwrites unchanged data.
    if (body.action === "resync") {
      await admin.from("qbo_connections").update({ cursors: {} }).eq("id", conn.id);
      conn.cursors = {};
    }
    background(executeRun(admin, conn, runId));
    return json({ run_id: runId }, 202);
  }

  if (body.action === "save_settings") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    const v = validateSettings(body.settings);
    if (!v.ok) return json({ error: v.error }, 400);
    // A changed field mapping must re-read that entity so the new fields get their first merge.
    const cursors = { ...(conn.cursors ?? {}) };
    const old = validateSettings(conn.settings && Object.keys(conn.settings as object).length ? conn.settings : defaultSettings());
    for (const e of QBO_ENTITIES) {
      const sig = (s: QboSettings) => JSON.stringify([s.entities[e].enabled, s.entities[e].direction, s.entities[e].fields]);
      if (!old.ok || sig(old.settings) !== sig(v.settings)) delete cursors[e];
    }
    const update: Record<string, unknown> = { settings: v.settings, cursors };
    if (typeof body.auto_sync === "boolean") update.auto_sync = body.auto_sync;
    const { error } = await admin.from("qbo_connections").update(update).eq("id", conn.id);
    if (error) return json({ error: "Could not save settings." }, 500);
    return json({ ok: true, settings: v.settings });
  }

  if (body.action === "options") {
    const conn = await loadConn(body.connection_id);
    if (!conn || conn.status === "disconnected") return json({ error: "Connection not found." }, 404);
    try {
      const ctx = await buildCtx(admin, conn, null, Date.now() + 30_000);
      return json(await listOptions(ctx));
    } catch (err) {
      return json({ error: err instanceof AuthError ? "Reconnect QuickBooks and try again." : "Could not load QuickBooks lists." }, 502);
    }
  }

  if (body.action === "disconnect") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    // Best effort: revoke the grant at Intuit so the app disappears from the company's connected apps.
    try {
      const encKey = Deno.env.get("QBO_TOKEN_ENCRYPTION_KEY") ?? "";
      const { data: sec } = await admin.from("qbo_connection_secrets").select("refresh_token_enc").eq("connection_id", conn.id).maybeSingle();
      if (sec && encKey) {
        const rt = await decryptSecret(sec.refresh_token_enc as string, encKey);
        const t = buildTokenRequest("refresh", { clientId: Deno.env.get("QBO_CLIENT_ID") ?? "", clientSecret: Deno.env.get("QBO_CLIENT_SECRET") ?? "" });
        await fetch(QBO_REVOKE_URL, { method: "POST", headers: { Authorization: t.headers.Authorization, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ token: rt }) });
      }
    } catch (err) {
      console.error("qbo revoke failed", err instanceof Error ? err.message : err);
    }
    await admin.from("qbo_connection_secrets").delete().eq("connection_id", conn.id);
    await admin.from("qbo_record_links").delete().eq("connection_id", conn.id);
    await admin.from("qbo_connections").update({ status: "disconnected", cursors: {}, last_error: null, sync_locked_until: null }).eq("id", conn.id);
    await mirrorIntegration(admin, conn, "disconnected", { error_code: "manual_disconnect" });
    return json({ ok: true });
  }

  if (body.action === "resolve_conflict") {
    const winner = body.winner === "vireek" || body.winner === "qbo" ? body.winner : null;
    if (!winner || typeof body.link_id !== "string") return json({ error: "Invalid request." }, 400);
    const { data: link } = await admin.from("qbo_record_links").select(`${LINK_COLS}, connection_id`).eq("id", body.link_id).eq("user_id", ownerId).maybeSingle();
    if (!link) return json({ error: "Conflict not found." }, 404);
    const conn = await loadConn((link as { connection_id: string }).connection_id);
    if (!conn || conn.status !== "connected") return json({ error: "QuickBooks is not connected." }, 409);
    if (!(await acquireLock(admin, conn.id))) return json({ error: "A sync is running. Try again in a moment." }, 409);
    let ctx: Ctx | null = null;
    try {
      ctx = await buildCtx(admin, conn, null, Date.now() + 60_000);
      const l = link as unknown as LinkRow;
      const ruleOverride = winner === "vireek" ? "vireek_wins" : "qbo_wins";
      const note = `Conflict resolved (kept ${winner === "vireek" ? "Vireek" : "QuickBooks"})`;
      const raw = await fetchQbo(ctx, l.entity, l.external_id.split(":")[0] === l.external_id ? l.external_id : l.external_id);
      let result: Outcome;
      if (l.entity === "invoice") {
        const v = await loadInvoice(ctx, l.vireek_id);
        const p = raw ? parseQboInvoice(raw) : null;
        if (!v || !p || !p.ok) return json({ error: "One of the two records no longer exists or cannot be compared." }, 410);
        result = await reconcileInvoice(ctx, l, v, p.doc, { ruleOverride, note });
      } else if (l.entity === "payment") {
        return json({ error: "Payments are never edited. Void the payment in Vireek if it is wrong." }, 400);
      } else {
        const vRow = await getVireekRow(ctx, l.entity, l.vireek_id);
        if (!vRow || !raw) return json({ error: "One of the two records no longer exists." }, 410);
        result = await reconcile(ctx, l.entity, l, vRow, raw, { ruleOverride, note });
      }
      await flushLogs(ctx);
      return result === "error" ? json({ error: "Could not apply that choice. See the sync log." }, 502) : json({ ok: true });
    } catch (err) {
      console.error("qbo resolve_conflict failed", err);
      return json({ error: err instanceof AuthError ? "Reconnect QuickBooks and try again." : "Could not resolve this conflict." }, 502);
    } finally {
      await admin.from("qbo_connections").update({ sync_locked_until: null }).eq("id", conn.id);
      if (ctx) await flushLogs(ctx);
    }
  }

  return json({ error: "Unknown action." }, 400);
});
