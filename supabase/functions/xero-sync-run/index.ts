// supabase/functions/xero-sync-run/index.ts
//
// Sync of accounts, contacts, items, invoices, payments and tax rates with Xero (multi-currency aware).
// Mirrors qbo-sync-run (QuickBooks). NOT LIVE-VERIFIED against a real Xero organisation: see XERO_SYNC.md.
//
// Actions (POST JSON):
//   { action: "run",              connection_id }                       -> 202 { run_id }   manual "Sync now"
//   { action: "resync",           connection_id }                       -> 202 { run_id }   re-read everything (merge is idempotent)
//   { action: "save_settings",    connection_id, settings, auto_sync? } -> { ok, settings }
//   { action: "options",          connection_id }                       -> accounts, items, tax rates, currencies (mapping UI)
//   { action: "disconnect",       connection_id }                       -> { ok }
//   { action: "resolve_conflict", link_id, winner: "vireek"|"xero" }    -> { ok }
//   { action: "cron" }   + header X-Cron-Secret                         -> 202   scheduled sync of all due connections
//   { action: "webhook", tenant_ids } + header X-Cron-Secret            -> 202   called by xero-webhook
//
// REQUIRED SECRETS: see xero-oauth-start/index.ts. Schedule with the pg_cron snippet at the bottom of
// supabase/migrations/20280101000000_xero_sync.sql.
// Deploy: supabase functions deploy xero-sync-run --no-verify-jwt
//   (pg_cron / xero-webhook call it with X-Cron-Secret and no JWT; every user action verifies the JWT in code.)
//
// HOW A RUN WORKS (order: accounts, contacts, items, invoices, payments; each: PULL then PUSH)
//   0. Refresh the organisation (base currency) and the read-only tax-rate list.
//   1. PULL changed Xero records (If-Modified-Since watermark + resumable page cursor), reconcile each.
//   2. PUSH changed Vireek records, reconciled against the live Xero record.
//   `reconcile` is a field-level THREE-WAY merge against the base snapshot stored on the link, so only
//   fields that changed since the last sync move and our own writes never echo back.
//
// IDEMPOTENCY / RETRY
//   - Every create sends a deterministic Idempotency-Key (record id + payload hash) AND first looks for an
//     existing Xero record with the same identity (name / email / code / invoice number) and links it.
//   - UNIQUE(connection, entity, external_id) and UNIQUE(connection, entity, vireek_id) on the links make a
//     duplicate impossible even if two runs raced.
//   - HTTP: network errors / 5xx back off and retry, 429 honours Retry-After (capped), 401 refreshes the token once.
//   - Records waiting for a dependency (customer, invoice, item) are kept in per-entity retry lists.
//
// SAFETY
//   - Tenant scope: ownerId comes from get_account_owner_id() (or the connection row for cron/webhook).
//   - Money documents go through the general-ledger functions (balanced, period-locked) in the BASE currency,
//     and only when Xero's base currency equals Vireek's. Foreign-currency invoices are converted at Xero's rate.
//   - An invoice with payments is never re-itemised or voided automatically: it becomes a conflict.
//   - Deletes are never propagated. Payments are create-only. Realised FX gain/loss is reported, not posted.
//   - Tokens are AES-GCM encrypted at rest and only sent to allow-listed Xero hosts.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  ENTITY_META,
  PAGE_CAP_PER_RUN,
  PULL_OVERLAP_MS,
  REFRESH_TOKEN_TTL_SEC,
  XERO_ENTITIES,
  XERO_PAGE,
  accountTypeFromClass,
  buildFindContactRequest,
  buildFindInvoiceRequest,
  buildGetRequest,
  buildItemByCodeRequest,
  buildListRequest,
  buildOrganisationRequest,
  buildRevokeRequest,
  buildTaxRatesRequest,
  buildCurrenciesRequest,
  buildTokenRequest,
  buildWriteRequest,
  buildXeroInvoicePayload,
  buildXeroPaymentPayload,
  canCreateInVireek,
  canCreateInXero,
  canFindInvoiceNumber,
  canonToXero,
  checkBaseCurrency,
  classifyResponse,
  decryptSecret,
  defaultSettings,
  describeFx,
  emptyStats,
  encryptSecret,
  escapeLike,
  generatedAccountCode,
  idempotencyKey,
  invoiceAmountSig,
  isAllowedXeroUrl,
  isPagedEntity,
  isSyncableAccount,
  isSyncableContact,
  isSyncableItem,
  isValidXeroId,
  mergeEntity,
  mergeFieldsFor,
  normalBalanceFor,
  normalizeText,
  normalizeValue,
  paymentBaseCents,
  paymentMethodFromText,
  parseCurrencies,
  parseEntityResponse,
  parseListResponse,
  parseOrganisation,
  parseRetryAfter,
  parseTaxRate,
  parseTimestamp,
  parseTokenResponse,
  parseXeroInvoice,
  parseXeroPayment,
  planTaxType,
  recordMeta,
  resolveLineItems,
  retryDelayMs,
  suggestItemCode,
  suggestXeroAccountType,
  toCents,
  validateSettings,
  xeroToCanon,
  VIREEK_FIELDS,
  type Canon,
  type FxInfo,
  type HttpReq,
  type InvoiceLine,
  type RawRecord,
  type SyncStats,
  type VireekAccountType,
  type XeroEntity,
  type XeroInvoiceDoc,
  type XeroSettings,
} from "../_shared/xero/engine.ts";

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

interface PullState { since: string | null; page: number; passStarted: string | null; retry?: string[] }
interface PushState { ts: string | null; id: string | null; retry?: string[] }
interface EntityCursor { pull?: PullState; push?: PushState }
interface ConnRow {
  id: string;
  user_id: string;
  tenant_id: string;
  xero_connection_id: string | null;
  status: string;
  base_currency: string | null;
  settings: unknown;
  cursors: Record<string, EntityCursor> | null;
}
interface LinkRow {
  id: string;
  entity: XeroEntity;
  vireek_id: string;
  external_id: string;
  remote_version: string | null;
  base: Canon & { __fx?: FxInfo | null; __code?: string | null; __account?: string | null };
  conflict: { fields: string[]; sig: string; reason?: string } | null;
}
type VRow = Record<string, unknown> & { id: string; updated_at?: string };
type Outcome = "ok" | "conflict" | "error" | "skipped";
type Simple = "account" | "contact" | "item";
type LogEntity = XeroEntity | "tax_rate";

interface LogEntry {
  entity: LogEntity;
  direction: "to_xero" | "from_xero" | "both" | "none";
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
  tenantId: string;
  settings: XeroSettings;
  cursors: Record<string, EntityCursor>;
  runId: string | null;
  stats: SyncStats;
  logs: Record<string, unknown>[];
  deadline: number;
  access: string;
  refresh: string;
  lastProgressAt: number;
  warned: Set<string>;
  baseCurrency: string;
  vireekCurrency: string;
  moneyOk: boolean;
  itemByName?: Map<string, string>;
  accountList?: RawRecord[];
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
    xero_correlation_id: e.tid ?? null,
  });
}
async function flushLogs(ctx: Ctx) {
  if (!ctx.logs.length) return;
  const rows = ctx.logs.splice(0);
  const { error } = await ctx.admin.from("xero_sync_log").insert(rows);
  if (error) console.error("xero-sync log insert failed", error.message);
}
async function touchRun(ctx: Ctx, force = false) {
  if (!ctx.runId) return;
  if (!force && Date.now() - ctx.lastProgressAt < 3000) return;
  ctx.lastProgressAt = Date.now();
  await ctx.admin.from("xero_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
  if (ctx.logs.length >= 40) await flushLogs(ctx);
}
const overDeadline = (ctx: Ctx) => Date.now() > ctx.deadline;
const warnOnce = (ctx: Ctx, key: string, e: LogEntry) => {
  if (ctx.warned.has(key)) return;
  ctx.warned.add(key);
  log(ctx, e);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// XERO HTTP (token refresh, retry, rate limits)
// ============================================================

async function persistTokens(ctx: Ctx, expiresInSec: number | null) {
  const encKey = Deno.env.get("XERO_TOKEN_ENCRYPTION_KEY") ?? "";
  await ctx.admin
    .from("xero_connection_secrets")
    .update({
      access_token_enc: await encryptSecret(ctx.access, encKey),
      refresh_token_enc: await encryptSecret(ctx.refresh, encKey),
      expires_at: expiresInSec ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("connection_id", ctx.conn.id);
  await ctx.admin.from("xero_connections").update({ refresh_token_expires_at: new Date(Date.now() + (REFRESH_TOKEN_TTL_SEC - 3600) * 1000).toISOString() }).eq("id", ctx.conn.id);
}

async function refreshAccess(ctx: Ctx) {
  const req = buildTokenRequest("refresh", {
    clientId: Deno.env.get("XERO_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("XERO_CLIENT_SECRET") ?? "",
    refreshToken: ctx.refresh,
  });
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 429) throw new RateLimitError("Xero token endpoint rate limited.");
  if (res.status >= 500) throw new Error(`Xero token endpoint error ${res.status}`);
  if (!res.ok) throw new AuthError(String(j.error_description ?? j.error ?? "Refresh failed."));
  const t = parseTokenResponse(j);
  ctx.access = t.accessToken;
  // Xero rotates the refresh token (single use): ALWAYS keep the newest one.
  if (t.refreshToken) ctx.refresh = t.refreshToken;
  await persistTokens(ctx, t.expiresInSec);
}

async function api(ctx: Ctx, req: { method: string; url: string; body?: unknown; headers?: Record<string, string> }): Promise<ApiResult> {
  if (!isAllowedXeroUrl(req.url)) throw new Error("Refusing to call an address outside Xero.");
  let refreshed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${ctx.access}`,
          "xero-tenant-id": ctx.tenantId,
          Accept: "application/json",
          ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(req.headers ?? {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      });
    } catch (err) {
      const wait = retryDelayMs({ status: null, attempt, retryAfterSec: null, maxAttempts: 4 });
      if (wait === null) throw err;
      await sleep(wait);
      continue;
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await refreshAccess(ctx);
      continue;
    }
    if (res.status === 401) throw new AuthError("Xero rejected our credentials.");
    if (res.status === 429) {
      const problem = res.headers.get("X-Rate-Limit-Problem");
      const wait = problem === "day" ? null : retryDelayMs({ status: 429, attempt, retryAfterSec: parseRetryAfter(res.headers.get("Retry-After")), maxAttempts: 4 });
      if (wait === null) throw new RateLimitError(problem === "day" ? "Xero's daily API limit was reached." : "Xero is rate limiting requests.");
      await sleep(wait);
      continue;
    }
    if (res.status >= 500) {
      const wait = retryDelayMs({ status: res.status, attempt, retryAfterSec: null, maxAttempts: 4 });
      if (wait !== null) {
        await sleep(wait);
        continue;
      }
    }
    // Stay inside the 60-calls-a-minute budget: slow down when the minute is nearly used up.
    const minLeft = Number(res.headers.get("X-MinLimit-Remaining"));
    if (Number.isFinite(minLeft) && res.headers.get("X-MinLimit-Remaining") !== null && minLeft <= 2) await sleep(2500);
    const text = res.status === 204 ? "" : await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, json: body, tid: res.headers.get("Xero-Correlation-Id") };
  }
  throw new Error("Xero request failed.");
}

const faultText = (r: ApiResult) => {
  const f = classifyResponse(r.status, r.json).fault;
  return f ? `${f.message}${f.detail ? `: ${f.detail}` : ""}`.slice(0, 300) : `HTTP ${r.status}`;
};

async function fetchXero(ctx: Ctx, entity: XeroEntity, id: string): Promise<RawRecord | null> {
  const r = await api(ctx, buildGetRequest({ entity, id }));
  const kind = classifyResponse(r.status, r.json).kind;
  if (kind === "notfound") return null;
  if (kind !== "ok") throw new Error(`Xero lookup failed: ${faultText(r)}`);
  return parseEntityResponse(entity, r.json);
}

async function listXero(ctx: Ctx, req: ReturnType<typeof buildListRequest> | ReturnType<typeof buildFindContactRequest>, entity: XeroEntity): Promise<RawRecord[]> {
  const r = await api(ctx, req);
  if (classifyResponse(r.status, r.json).kind !== "ok") throw new Error(`Xero query failed: ${faultText(r)}`);
  return parseListResponse(entity, r.json, XERO_PAGE).records;
}

type WriteResult = { ok: true; record: RawRecord; tid: string | null } | { ok: false; kind: string; message: string; tid: string | null };
async function writeXero(ctx: Ctx, entity: XeroEntity, payload: RawRecord, opts: { id?: string; idemKey?: string } = {}): Promise<WriteResult> {
  const r = await api(ctx, buildWriteRequest({ entity, payload, id: opts.id, idempotencyKey: opts.idemKey }));
  const c = classifyResponse(r.status, r.json);
  if (c.kind === "ok") {
    const rec = parseEntityResponse(entity, r.json);
    return rec ? { ok: true, record: rec, tid: r.tid } : { ok: false, kind: "error", message: "Xero returned no record.", tid: r.tid };
  }
  return { ok: false, kind: c.kind, message: faultText(r), tid: r.tid };
}

// ============================================================
// VIREEK-SIDE HELPERS
// ============================================================

const COLS: Record<Simple, string> = {
  account: "id, code, name, type, is_active, is_system, updated_at",
  contact: "id, name, email, phone, address, updated_at",
  item: "id, service_name, description, price_cents, active, updated_at",
};
const INVOICE_COLS = "id, customer_id, invoice_number, status, issue_date, due_date, subtotal_cents, tax_cents, total_cents, amount_paid_cents, updated_at";
const PAYMENT_COLS = "id, invoice_id, amount_cents, payment_date, payment_method, deposit_account_id, created_at";

function vireekCanon(entity: Simple, r: VRow): Canon {
  switch (entity) {
    case "contact":
      return { name: r.name as string, email: r.email as string, phone: r.phone as string, address: r.address as string };
    case "item": {
      const n = typeof r.service_name === "string" ? r.service_name.replace(/\s+/g, " ").trim().slice(0, 50) : null;
      return { name: n, description: r.description as string, price: (r.price_cents as number) / 100 };
    }
    case "account":
      return { code: r.code as string, name: r.name as string, active: r.is_active === false ? "inactive" : "active" };
  }
}

/** Canon values -> Vireek column values (only the keys given). */
function toColumns(entity: Simple, v: Canon): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(v, k);
  if (entity === "contact") {
    for (const k of ["name", "email", "phone", "address"]) if (has(k)) out[k] = v[k];
  } else if (entity === "item") {
    if (has("name")) out.service_name = v.name;
    if (has("description")) out.description = v.description;
    if (has("price")) out.price_cents = Math.max(0, toCents(v.price ?? 0));
  } else {
    if (has("code")) out.code = v.code;
    if (has("name")) out.name = v.name;
    if (has("active")) out.is_active = v.active !== "inactive";
  }
  return out;
}

const tsOf = (r: VRow): number | null => (r.updated_at ? parseTimestamp(r.updated_at as string) : null);
const stripMeta = (b: Canon | null): Canon | null => (b ? Object.fromEntries(Object.entries(b).filter(([k]) => !k.startsWith("__"))) : null);

async function getVireekRow(ctx: Ctx, entity: Simple, id: string): Promise<VRow | null> {
  const { data } = await ctx.admin.from(ENTITY_META[entity].table).select(COLS[entity]).eq("id", id).eq("user_id", ctx.ownerId).maybeSingle();
  return (data as VRow | null) ?? null;
}

// ---- links ----------------------------------------------------------------

const LINK_COLS = "id, entity, vireek_id, external_id, remote_version, base, conflict";
async function getLinkByExternal(ctx: Ctx, entity: XeroEntity, externalId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin.from("xero_record_links").select(LINK_COLS).eq("connection_id", ctx.conn.id).eq("entity", entity).eq("external_id", externalId).maybeSingle();
  return (data as LinkRow | null) ?? null;
}
async function getLinkByVireek(ctx: Ctx, entity: XeroEntity, vireekId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin.from("xero_record_links").select(LINK_COLS).eq("connection_id", ctx.conn.id).eq("entity", entity).eq("vireek_id", vireekId).maybeSingle();
  return (data as LinkRow | null) ?? null;
}
/** Link by a value kept in the base snapshot (account code, item code). */
async function getLinkByBase(ctx: Ctx, entity: XeroEntity, key: string, value: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin.from("xero_record_links").select(LINK_COLS).eq("connection_id", ctx.conn.id).eq("entity", entity).eq(`base->>${key}`, value).limit(1);
  return ((data ?? [])[0] as LinkRow | undefined) ?? null;
}
async function createLink(ctx: Ctx, entity: XeroEntity, vireekId: string, externalId: string, base: Record<string, unknown>, version: string | null): Promise<LinkRow | null> {
  const { data, error } = await ctx.admin
    .from("xero_record_links")
    .insert({ user_id: ctx.ownerId, connection_id: ctx.conn.id, entity, vireek_id: vireekId, external_id: externalId, base, remote_version: version })
    .select(LINK_COLS)
    .single();
  if (error) {
    console.error("xero link insert failed", error.message);
    // Idempotency: the unique constraints mean someone (a racing run) already linked it. Return that link.
    return (await getLinkByExternal(ctx, entity, externalId)) ?? (await getLinkByVireek(ctx, entity, vireekId));
  }
  return data as LinkRow;
}
async function saveLink(ctx: Ctx, link: LinkRow, patch: { base?: Record<string, unknown>; remote_version?: string | null; conflict?: LinkRow["conflict"] }) {
  await ctx.admin.from("xero_record_links").update({ ...patch, last_synced_at: new Date().toISOString() }).eq("id", link.id);
}

function addRetry(list: string[] | undefined, id: string): string[] {
  const set = new Set(list ?? []);
  set.add(id);
  return [...set].slice(-RETRY_CAP);
}

// ============================================================
// SIMPLE ENTITIES: accounts, contacts, items
// ============================================================

function conflictSig(fields: string[], v: Canon, q: Canon): string {
  return JSON.stringify([fields, fields.map((f) => [v[f] ?? null, q[f] ?? null])]);
}

/** Metadata remembered on the link (stripped before merging): item code + its sales account. */
const simpleMeta = (entity: Simple, raw: RawRecord): Record<string, unknown> =>
  entity === "item" ? { __code: typeof raw.Code === "string" ? raw.Code : null, __account: typeof (raw.SalesDetails as RawRecord | undefined)?.AccountCode === "string" ? (raw.SalesDetails as RawRecord).AccountCode : null } : {};

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
  opts: { ruleOverride?: "vireek_wins" | "xero_wins"; note?: string } = {},
): Promise<Outcome> {
  const es = ctx.settings.entities[entity];
  const meta = recordMeta(entity, raw);
  const vC = vireekCanon(entity, vRow);
  const xC = xeroToCanon(entity, raw);
  const res = mergeEntity({ entity, settings: es, base: stripMeta(link?.base ?? null), vireek: vC, xero: xC, vireekTs: tsOf(vRow), xeroTs: meta.modifiedAt, ruleOverride: opts.ruleOverride });
  let version = meta.version;
  const next: Canon = { ...res.next };
  let failed = false;

  if (Object.keys(res.toVireek).length) {
    const err = await applyVireekUpdate(ctx, entity, vRow.id, res.toVireek);
    if (err) {
      failed = true;
      ctx.stats.errors++;
      log(ctx, { entity, direction: "from_xero", action: "error", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `Could not update Vireek: ${err}` });
      for (const k of Object.keys(res.toVireek)) next[k] = link?.base?.[k] ?? null;
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity, direction: "from_xero", action: "updated", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: opts.note ?? `Updated from Xero (${Object.keys(res.toVireek).join(", ")})`, details: res.toVireek });
    }
  }

  if (Object.keys(res.toCrm).length) {
    const payload = canonToXero(entity, res.toCrm, { defaults: ctx.settings.defaults, existing: raw }, false);
    const w = await writeXero(ctx, entity, payload, { id: meta.id });
    if (w.ok) {
      version = recordMeta(entity, w.record).version;
      ctx.stats.updated_xero++;
      log(ctx, { entity, direction: "to_xero", action: "updated", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: opts.note ?? `Updated in Xero (${Object.keys(res.toCrm).join(", ")})`, details: res.toCrm });
    } else {
      failed = true;
      ctx.stats.errors++;
      log(ctx, { entity, direction: "to_xero", action: "error", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `Xero rejected the update: ${w.message}`, tid: w.tid });
      for (const k of Object.keys(res.toCrm)) next[k] = link?.base?.[k] ?? null;
    }
  }

  let conflict: LinkRow["conflict"] = null;
  if (res.conflicts.length) {
    const fields = res.conflicts.map((c) => c.field);
    const sig = conflictSig(fields, vC, xC);
    conflict = { fields, sig };
    if (link?.conflict?.sig !== sig) {
      ctx.stats.conflicts++;
      log(ctx, { entity, direction: "none", action: "conflict", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `Both sides changed: ${fields.join(", ")}`, details: res.conflicts });
    }
  }

  const base = { ...next, ...simpleMeta(entity, raw) };
  if (link) await saveLink(ctx, link, { base, remote_version: version, conflict });
  else await createLink(ctx, entity, vRow.id, meta.id, base, version);
  return failed ? "error" : conflict ? "conflict" : "ok";
}

async function findVireekMatch(ctx: Ctx, entity: Simple, xC: Canon): Promise<VRow | null> {
  const t = ENTITY_META[entity].table;
  const q = (col: string, val: string) => ctx.admin.from(t).select(COLS[entity]).eq("user_id", ctx.ownerId).ilike(col, escapeLike(val)).limit(1).maybeSingle();
  let row: unknown = null;
  if (entity === "contact") {
    if (xC.email) row = (await q("email", String(xC.email))).data;
    if (!row && xC.name) row = (await q("name", String(xC.name))).data;
  } else if (entity === "item") {
    if (xC.name) row = (await q("service_name", String(xC.name))).data;
  } else {
    if (xC.code) row = (await ctx.admin.from(t).select(COLS[entity]).eq("user_id", ctx.ownerId).eq("code", String(xC.code)).limit(1).maybeSingle()).data;
    if (!row && xC.name) row = (await q("name", String(xC.name))).data;
  }
  const r = row as VRow | null;
  if (!r) return null;
  return (await getLinkByVireek(ctx, entity, r.id)) ? null : r; // already linked to another Xero record
}

async function createVireekRow(ctx: Ctx, entity: Simple, raw: RawRecord, xC: Canon): Promise<{ row?: VRow; error?: string; skip?: string }> {
  const meta = recordMeta(entity, raw);
  let insert: Record<string, unknown>;
  if (entity === "contact") {
    if (!xC.name) return { skip: "Contact has no name." };
    const person = !!raw.FirstName || !!raw.LastName;
    insert = { ...toColumns("contact", xC), user_id: ctx.ownerId, source: "import", lifecycle_stage: "active", customer_type: person ? "residential" : "commercial" };
  } else if (entity === "item") {
    if (!xC.name) return { skip: "Item has no name." };
    insert = { ...toColumns("item", xC), user_id: ctx.ownerId, pricing_model: "flat", active: true, price_cents: Math.max(0, toCents(xC.price ?? 0)) };
  } else {
    const type = accountTypeFromClass(raw.Class);
    if (!type || !xC.name) return { skip: "Account has no recognisable class." };
    insert = { ...toColumns("account", xC), user_id: ctx.ownerId, code: xC.code ?? generatedAccountCode(meta.id), type, normal_balance: normalBalanceFor(type), is_system: false };
  }
  let { data, error } = await ctx.admin.from(ENTITY_META[entity].table).insert(insert).select(COLS[entity]).single();
  if (error && entity === "account" && /duplicate|unique/i.test(error.message)) {
    ({ data, error } = await ctx.admin.from(ENTITY_META[entity].table).insert({ ...insert, code: generatedAccountCode(meta.id) }).select(COLS[entity]).single());
  }
  if (error || !data) return { error: error?.message ?? "insert failed" };
  return { row: data as unknown as VRow };
}

async function applyXeroRecord(ctx: Ctx, entity: Simple, raw: RawRecord): Promise<void> {
  const es = ctx.settings.entities[entity];
  const meta = recordMeta(entity, raw);
  if (!isValidXeroId(meta.id)) return;
  const xC = xeroToCanon(entity, raw);
  const link = await getLinkByExternal(ctx, entity, meta.id);

  if (link) {
    const vRow = await getVireekRow(ctx, entity, link.vireek_id);
    if (!vRow) {
      warnOnce(ctx, `gone:${link.id}`, { entity, direction: "none", action: "skipped", vireek_id: link.vireek_id, external_id: meta.id, link_id: link.id, message: "Deleted in Vireek: not recreated and not changed in Xero." });
      ctx.stats.skipped++;
      return;
    }
    await reconcile(ctx, entity, link, vRow, raw);
    return;
  }

  const eligible = entity === "item" ? isSyncableItem(raw) : entity === "contact" ? isSyncableContact(raw) : isSyncableAccount(raw);
  if (!eligible) return;

  const match = await findVireekMatch(ctx, entity, xC);
  if (match) {
    const out = await reconcile(ctx, entity, null, match, raw, { note: "Matched an existing record" });
    if (out !== "error") log(ctx, { entity, direction: "both", action: "linked", vireek_id: match.id, external_id: meta.id, message: "Linked to the matching record" });
    return;
  }
  if (!canCreateInVireek(es)) {
    ctx.stats.skipped++;
    return;
  }
  const made = await createVireekRow(ctx, entity, raw, xC);
  if (made.skip) {
    ctx.stats.skipped++;
    log(ctx, { entity, direction: "from_xero", action: "skipped", external_id: meta.id, message: made.skip });
    return;
  }
  if (made.error || !made.row) {
    ctx.stats.errors++;
    log(ctx, { entity, direction: "from_xero", action: "error", external_id: meta.id, message: `Could not create in Vireek: ${made.error}` });
    return;
  }
  const merged = mergeEntity({ entity, settings: es, base: null, vireek: vireekCanon(entity, made.row), xero: xC, vireekTs: null, xeroTs: null });
  await createLink(ctx, entity, made.row.id, meta.id, { ...merged.next, ...simpleMeta(entity, raw) }, meta.version);
  ctx.stats.created_vireek++;
  log(ctx, { entity, direction: "from_xero", action: "created", vireek_id: made.row.id, external_id: meta.id, message: `Created from Xero: ${String(xC.name ?? meta.id).slice(0, 80)}` });
}

function vireekChangedSinceBase(entity: Simple, link: LinkRow, row: VRow, es: XeroSettings["entities"][Simple]): boolean {
  const v = vireekCanon(entity, row);
  const base = link.base ?? {};
  return mergeFieldsFor(entity, es).some((f) => normalizeValue(f.type, v[f.key]) !== normalizeValue(f.type, base[f.key]));
}

async function allAccounts(ctx: Ctx): Promise<RawRecord[]> {
  if (!ctx.accountList) ctx.accountList = await listXero(ctx, buildListRequest({ entity: "account", page: 1, pageSize: XERO_PAGE, modifiedSinceMs: null }), "account");
  return ctx.accountList;
}

async function createInXero(ctx: Ctx, entity: Simple, row: VRow): Promise<void> {
  const es = ctx.settings.entities[entity];
  const vC = vireekCanon(entity, row);
  const label = String(vC.name ?? row.id).slice(0, 80);
  const base = { defaults: ctx.settings.defaults };
  const fail = (message: string, tid?: string | null) => {
    ctx.stats.errors++;
    log(ctx, { entity, direction: "to_xero", action: "error", vireek_id: row.id, message, tid });
  };
  const linkExisting = async (hit: RawRecord, what: string) => {
    const out = await reconcile(ctx, entity, null, row, hit, { note: `Matched an existing Xero ${what}` });
    if (out !== "error") log(ctx, { entity, direction: "both", action: "linked", vireek_id: row.id, external_id: recordMeta(entity, hit).id, message: `Linked to existing Xero ${what}: ${label}` });
  };

  // 1. An existing Xero record with the same identity is linked, never duplicated.
  let itemCode: string | null = null;
  if (entity === "contact") {
    const terms = [vC.email, vC.name].filter((t): t is string => typeof t === "string" && !!t);
    for (const term of terms) {
      const found = await listXero(ctx, buildFindContactRequest(term), "contact");
      const hit = found.find((r) => {
        const c = xeroToCanon("contact", r);
        return (vC.email && c.email && normalizeValue("email", c.email) === normalizeValue("email", vC.email)) || (c.name && vC.name && normalizeText(String(c.name)) === normalizeText(String(vC.name)));
      });
      if (hit && !(await getLinkByExternal(ctx, "contact", recordMeta("contact", hit).id))) return linkExisting(hit, "contact");
    }
  } else if (entity === "item") {
    itemCode = suggestItemCode(String(row.service_name ?? ""), row.id);
    const r = await api(ctx, buildItemByCodeRequest(itemCode));
    if (classifyResponse(r.status, r.json).kind === "ok") {
      const hit = parseEntityResponse("item", r.json);
      if (hit && normalizeText(String(hit.Name ?? "")) === normalizeText(String(vC.name ?? "")) && !(await getLinkByExternal(ctx, "item", recordMeta("item", hit).id))) return linkExisting(hit, "item");
      if (hit) return fail(`Item code ${itemCode} is already used in Xero by a different item.`);
    }
  } else {
    const accounts = await allAccounts(ctx);
    const hit = accounts.find((a) => (vC.code && a.Code && String(a.Code).toLowerCase() === String(vC.code).toLowerCase().slice(0, 10)) || (a.Name && vC.name && normalizeText(String(a.Name)) === normalizeText(String(vC.name))));
    if (hit && !(await getLinkByExternal(ctx, "account", recordMeta("account", hit).id))) return linkExisting(hit, "account");
  }

  // 2. Create (Idempotency-Key = record + payload, so a retry after a timeout can never duplicate).
  const values: Canon = {};
  for (const f of mergeFieldsFor(entity, es)) if (f.direction !== "from_crm") values[f.key] = vC[f.key] ?? null;
  const accountType = entity === "account" ? suggestXeroAccountType(String(row.type) as VireekAccountType, String(row.code ?? "")) : null;
  const payload = canonToXero(entity, values, { ...base, accountType, itemCode }, true);
  const w = await writeXero(ctx, entity, payload, { idemKey: idempotencyKey(entity.slice(0, 3), row.id, payload) });
  if (!w.ok) {
    if (w.kind === "duplicate" && entity === "contact" && vC.name) {
      const found = await listXero(ctx, buildFindContactRequest(String(vC.name)), "contact");
      const hit = found.find((r) => normalizeText(String(r.Name ?? "")) === normalizeText(String(vC.name)));
      if (hit && !(await getLinkByExternal(ctx, "contact", recordMeta("contact", hit).id))) return linkExisting(hit, "contact");
    }
    return fail(`Could not create in Xero (${label}): ${w.message}`, w.tid);
  }
  const m = recordMeta(entity, w.record);
  // Base = what Vireek holds: a value Xero normalised later flows back as a normal Xero edit.
  const merged = mergeEntity({ entity, settings: es, base: null, vireek: vC, xero: vC, vireekTs: null, xeroTs: null });
  await createLink(ctx, entity, row.id, m.id, { ...merged.next, ...simpleMeta(entity, w.record) }, m.version);
  ctx.stats.created_xero++;
  log(ctx, { entity, direction: "to_xero", action: "created", vireek_id: row.id, external_id: m.id, message: `Created in Xero: ${label}` });
}

/** Generic resumable pull: pages for paged entities, a single If-Modified-Since request for the rest. */
async function pullEntity(ctx: Ctx, entity: XeroEntity, apply: (raw: RawRecord) => Promise<"retry" | void>): Promise<boolean> {
  const cur = ctx.cursors[entity]?.pull ?? { since: null, page: 1, passStarted: null };
  const passStarted = cur.passStarted ?? new Date().toISOString();
  const sinceMs = cur.since ? Date.parse(cur.since) - PULL_OVERLAP_MS : null;
  let page = cur.page || 1;
  let seen = 0;
  let retry: string[] = [];
  const paged = isPagedEntity(entity);

  for (const id of cur.retry ?? []) {
    const raw = isValidXeroId(id) ? await fetchXero(ctx, entity, id) : null;
    if (raw && (await apply(raw)) === "retry") retry = addRetry(retry, id);
  }
  const save = (state: Omit<PullState, "retry">) => {
    ctx.cursors[entity] = { ...ctx.cursors[entity], pull: { ...state, retry } };
  };

  while (true) {
    if (overDeadline(ctx)) {
      save({ since: cur.since, page, passStarted });
      return false;
    }
    const records = await listXero(ctx, buildListRequest({ entity, page, pageSize: XERO_PAGE, modifiedSinceMs: sinceMs }), entity);
    for (const raw of records) {
      if ((await apply(raw)) === "retry") retry = addRetry(retry, recordMeta(entity, raw).id);
    }
    seen += records.length;
    page += 1;
    await touchRun(ctx);
    if (!paged || records.length < XERO_PAGE) {
      save({ since: passStarted, page: 1, passStarted: null });
      return true;
    }
    if (seen >= PAGE_CAP_PER_RUN) {
      save({ since: cur.since, page, passStarted });
      return false;
    }
  }
}

async function pushSimple(ctx: Ctx, entity: Simple, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities[entity];
  if (es.direction === "from_xero") return;
  const t = ENTITY_META[entity].table;
  let cur: PushState = ctx.cursors[entity]?.push ?? { ts: null, id: null };

  const handle = async (row: VRow) => {
    const link = await getLinkByVireek(ctx, entity, row.id);
    if (link) {
      if (!vireekChangedSinceBase(entity, link, row, es) && !link.conflict) return;
      const raw = await fetchXero(ctx, entity, link.external_id);
      if (!raw) {
        warnOnce(ctx, `xgone:${link.id}`, { entity, direction: "none", action: "skipped", vireek_id: row.id, external_id: link.external_id, link_id: link.id, message: "Deleted in Xero: not recreated and not changed in Vireek." });
        return;
      }
      await reconcile(ctx, entity, link, row, raw);
    } else if (canCreateInXero(es) && pullDoneOnce) {
      await createInXero(ctx, entity, row);
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
// INVOICES (always booked in the BASE currency)
// ============================================================

interface VInvoice { row: VRow; lines: InvoiceLine[] }
type FxBase = FxInfo | null;

async function loadInvoice(ctx: Ctx, id: string): Promise<VInvoice | null> {
  const { data } = await ctx.admin.from("ar_invoices").select(INVOICE_COLS).eq("id", id).eq("user_id", ctx.ownerId).maybeSingle();
  if (!data) return null;
  const { data: ls } = await ctx.admin.from("ar_invoice_lines").select("description, quantity, unit_price_cents, amount_cents, revenue_account_id").eq("invoice_id", id).order("line_number");
  const lines: InvoiceLine[] = ((ls ?? []) as Record<string, unknown>[]).map((l) => ({
    description: String(l.description ?? ""),
    qty: Number(l.quantity ?? 1),
    unitPriceCents: Number(l.unit_price_cents ?? 0),
    amountCents: Number(l.amount_cents ?? 0),
    itemCode: null,
    accountCode: null,
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
function invoiceXeroCanon(d: XeroInvoiceDoc): Canon {
  return { due_date: d.dueDate, amounts: d.voided ? null : invoiceAmountSig(d), voided: d.voided ? "void" : "active" };
}
const parseOpts = (ctx: Ctx) => ({ baseCurrency: ctx.baseCurrency, foreignCurrency: ctx.settings.defaults.foreignCurrency });

/** Normalised Vireek item name -> Xero item code, for the items already linked. */
async function itemMap(ctx: Ctx): Promise<Map<string, string>> {
  if (ctx.itemByName) return ctx.itemByName;
  const map = new Map<string, string>();
  const { data: links } = await ctx.admin.from("xero_record_links").select("vireek_id, base").eq("connection_id", ctx.conn.id).eq("entity", "item");
  const rows = (links ?? []) as { vireek_id: string; base: { __code?: string | null } }[];
  if (rows.length) {
    const { data: items } = await ctx.admin.from("price_book_items").select("id, service_name").eq("user_id", ctx.ownerId).in("id", rows.map((l) => l.vireek_id));
    const code = new Map(rows.map((l) => [l.vireek_id, l.base?.__code ?? null]));
    for (const it of (items ?? []) as { id: string; service_name: string }[]) {
      const c = code.get(it.id);
      if (c) map.set(normalizeText(it.service_name), c);
    }
  }
  ctx.itemByName = map;
  return map;
}

/** Revenue account (Vireek id) for an inbound line: the line's account, else its item's sales account, else the default. */
async function revenueAccountFor(ctx: Ctx, l: InvoiceLine): Promise<string | null> {
  let code = l.accountCode;
  if (!code && l.itemCode) code = (await getLinkByBase(ctx, "item", "__code", l.itemCode))?.base?.__account ?? null;
  if (!code) return null;
  return (await getLinkByBase(ctx, "account", "code", code))?.vireek_id ?? null;
}
const linesJson = async (ctx: Ctx, lines: InvoiceLine[]) =>
  Promise.all(lines.map(async (l) => ({ description: l.description, quantity: l.qty, unit_price_cents: l.unitPriceCents, amount_cents: l.amountCents, revenue_account_id: await revenueAccountFor(ctx, l) })));

const isPaymentsBlock = (msg: string) => /PAYMENTS_EXIST/.test(msg);

function warnTotals(ctx: Ctx, v: VInvoice, rec: RawRecord, ext: string) {
  const expected = Number(v.row.total_cents);
  if (toCents(rec.Total) !== expected) {
    log(ctx, { entity: "invoice", direction: "to_xero", action: "conflict", vireek_id: v.row.id, external_id: ext, message: `Xero total (${toCents(rec.Total) / 100}) differs from Vireek (${expected / 100}). Check the tax rate under Mapping → Defaults and the invoice in Xero.` });
    ctx.stats.conflicts++;
  }
}

const baseWithFx = (next: Canon, fx: FxBase): Record<string, unknown> => ({ ...next, __fx: fx });

async function reconcileInvoice(
  ctx: Ctx,
  link: LinkRow | null,
  v: VInvoice,
  doc: XeroInvoiceDoc,
  opts: { ruleOverride?: "vireek_wins" | "xero_wins"; note?: string } = {},
): Promise<Outcome> {
  const es = ctx.settings.entities.invoice;
  const vC = invoiceVireekCanon(v);
  const xC = invoiceXeroCanon(doc);
  const res = mergeEntity({ entity: "invoice", settings: es, base: stripMeta(link?.base ?? null), vireek: vC, xero: xC, vireekTs: tsOf(v.row), xeroTs: doc.modifiedAt, ruleOverride: opts.ruleOverride });
  const next: Canon = { ...res.next };
  const blocked: string[] = [];
  const reasons: string[] = [];
  let version = doc.version;
  let fx: FxBase = doc.fx ?? (link?.base?.__fx ?? null);
  let failed = false;
  const id = v.row.id;
  const ext = doc.id;
  const fail = (direction: "to_xero" | "from_xero", message: string, tid?: string | null) => {
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
    const { error } = await ctx.admin.rpc("xero_void_ar_invoice", { p_owner: ctx.ownerId, p_invoice_id: id });
    if (error) {
      if (isPaymentsBlock(error.message)) block("voided", "Voided in Xero, but Vireek has payments on this invoice. Void or refund the payments in Vireek first.");
      else fail("from_xero", `Could not void in Vireek: ${error.message}`);
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity: "invoice", direction: "from_xero", action: "voided", vireek_id: id, external_id: ext, link_id: link?.id, message: "Voided to match Xero" });
    }
  }
  if (res.toCrm.voided === "void") {
    const w = await writeXero(ctx, "invoice", { Status: "VOIDED" }, { id: ext });
    if (w.ok) {
      ctx.stats.updated_xero++;
      version = recordMeta("invoice", w.record).version;
      log(ctx, { entity: "invoice", direction: "to_xero", action: "voided", vireek_id: id, external_id: ext, link_id: link?.id, message: "Voided to match Vireek" });
    } else fail("to_xero", `Xero could not void the invoice: ${w.message}`, w.tid);
  }
  const voidedNow = vC.voided === "void" || xC.voided === "void" || res.toVireek.voided === "void" || res.toCrm.voided === "void";

  // ---- amounts (never when a void is involved) ----
  if (!voidedNow && typeof res.toVireek.amounts === "string") {
    const { error } = await ctx.admin.rpc("xero_replace_ar_invoice", {
      p_owner: ctx.ownerId, p_invoice_id: id, p_issue_date: doc.txnDate, p_due_date: doc.dueDate, p_tax_cents: doc.taxCents, p_lines: await linesJson(ctx, doc.lines),
    });
    if (error) {
      if (isPaymentsBlock(error.message)) block("amounts", "Amounts changed in Xero after a payment was recorded in Vireek. Review it, then choose which side to keep.");
      else fail("from_xero", `Could not apply Xero amounts: ${error.message}`);
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity: "invoice", direction: "from_xero", action: "updated", vireek_id: id, external_id: ext, link_id: link?.id, message: doc.fx ? `Line items and totals updated from Xero (${describeFx(doc.fx, ctx.baseCurrency, doc.totalCents)})` : "Line items and totals updated from Xero" });
    }
  }
  const pushAmounts = !voidedNow && typeof res.toCrm.amounts === "string";
  const pushDue = !voidedNow && res.toCrm.due_date !== undefined;
  if (pushAmounts || pushDue) {
    const customer = v.row.customer_id ? await getLinkByVireek(ctx, "contact", String(v.row.customer_id)) : null;
    const resolved = resolveLineItems(v.lines, await itemMap(ctx), ctx.settings.defaults);
    const tax = planTaxType(Number(v.row.tax_cents), ctx.settings.defaults);
    if (fx) block("amounts", `This invoice is in ${fx.currency} in Xero. Edit amounts in Xero; Vireek books it in ${ctx.baseCurrency}.`);
    else if (!customer) block("amounts", "The customer is not linked to Xero yet.");
    else if (!resolved.ok) block("amounts", resolved.reason);
    else if (!tax.ok) block("amounts", tax.reason);
    else {
      const payload = buildXeroInvoicePayload(
        { invoiceNumber: String(v.row.invoice_number), issueDate: String(v.row.issue_date), dueDate: String(v.row.due_date), taxCents: Number(v.row.tax_cents), lines: resolved.lines },
        customer.external_id, { defaults: ctx.settings.defaults, taxType: tax.taxType }, { id: ext },
      );
      const w = await writeXero(ctx, "invoice", payload, { id: ext });
      if (w.ok) {
        version = recordMeta("invoice", w.record).version;
        ctx.stats.updated_xero++;
        log(ctx, { entity: "invoice", direction: "to_xero", action: "updated", vireek_id: id, external_id: ext, link_id: link?.id, message: "Invoice updated in Xero" });
        warnTotals(ctx, v, w.record, ext);
      } else {
        if (pushAmounts) block("amounts", `Xero rejected the update: ${w.message}`);
        fail("to_xero", `Xero rejected the invoice update: ${w.message}`, w.tid);
      }
    }
  }

  // ---- due date (no ledger impact) ----
  if (res.toVireek.due_date !== undefined && res.toVireek.due_date !== null) {
    const { error } = await ctx.admin.from("ar_invoices").update({ due_date: res.toVireek.due_date }).eq("id", id).eq("user_id", ctx.ownerId);
    if (error) fail("from_xero", `Could not update the due date: ${error.message}`);
    else ctx.stats.updated_vireek++;
  }

  for (const f of blocked) next[f] = link?.base?.[f] ?? null;
  const fields = [...new Set([...res.conflicts.map((c) => c.field), ...blocked])];
  let conflict: LinkRow["conflict"] = null;
  if (fields.length) {
    const sig = conflictSig(fields, vC, xC);
    conflict = { fields, sig, ...(reasons.length ? { reason: reasons[0] } : {}) };
    if (link?.conflict?.sig !== sig) {
      ctx.stats.conflicts++;
      log(ctx, { entity: "invoice", direction: "none", action: "conflict", vireek_id: id, external_id: ext, link_id: link?.id, message: reasons[0] ?? `Both sides changed: ${fields.join(", ")}`, details: res.conflicts });
    }
  }
  if (link) await saveLink(ctx, link, { base: baseWithFx(next, fx), remote_version: version, conflict });
  else await createLink(ctx, "invoice", id, ext, baseWithFx(next, fx), version);
  return failed ? "error" : conflict ? "conflict" : "ok";
}

async function applyXeroInvoice(ctx: Ctx, raw: RawRecord): Promise<"retry" | void> {
  const es = ctx.settings.entities.invoice;
  const meta = recordMeta("invoice", raw);
  if (!isValidXeroId(meta.id)) return;
  const parsed = parseXeroInvoice(raw, parseOpts(ctx));
  if (!parsed.ok) {
    if (parsed.kind === "draft" || parsed.kind === "not_sales") return; // not an issued sales invoice: nothing to sync, nothing to report
    ctx.stats.skipped++;
    warnOnce(ctx, `inv:${meta.id}:${meta.version}`, { entity: "invoice", direction: "from_xero", action: "skipped", external_id: meta.id, message: `Invoice ${String(raw.InvoiceNumber ?? meta.id)} skipped: ${parsed.reason}` });
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
  if (doc.number) {
    const { data } = await ctx.admin.from("ar_invoices").select("id").eq("user_id", ctx.ownerId).eq("invoice_number", doc.number).eq("total_cents", doc.totalCents).maybeSingle();
    if (data && !(await getLinkByVireek(ctx, "invoice", (data as unknown as VRow).id))) {
      const v = await loadInvoice(ctx, (data as unknown as VRow).id);
      if (v) {
        await reconcileInvoice(ctx, null, v, doc, { note: "Matched an existing invoice" });
        log(ctx, { entity: "invoice", direction: "both", action: "linked", vireek_id: v.row.id, external_id: doc.id, message: `Linked to existing invoice ${doc.number}` });
        return;
      }
    }
  }
  if (!canCreateInVireek(es)) {
    ctx.stats.skipped++;
    return;
  }
  const cust = doc.contactId ? await getLinkByExternal(ctx, "contact", doc.contactId) : null;
  if (!cust) {
    warnOnce(ctx, `invcust:${doc.id}`, { entity: "invoice", direction: "from_xero", action: "skipped", external_id: doc.id, message: `Invoice ${doc.number ?? doc.id} waits for its contact to sync (enable Contacts, then Sync now).` });
    return "retry";
  }
  if (doc.totalCents <= 0) {
    ctx.stats.skipped++;
    return;
  }
  const { data: newId, error } = await ctx.admin.rpc("xero_create_ar_invoice", {
    p_owner: ctx.ownerId, p_customer_id: cust.vireek_id, p_issue_date: doc.txnDate, p_due_date: doc.dueDate, p_tax_cents: doc.taxCents, p_lines: await linesJson(ctx, doc.lines), p_invoice_number: doc.number,
  });
  if (error || !newId) {
    ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction: "from_xero", action: "error", external_id: doc.id, message: `Could not create invoice ${doc.number ?? doc.id}: ${error?.message ?? "no id"}` });
    return;
  }
  const v = await loadInvoice(ctx, newId as string);
  await createLink(ctx, "invoice", newId as string, doc.id, baseWithFx(v ? invoiceVireekCanon(v) : invoiceXeroCanon(doc), doc.fx), doc.version);
  ctx.stats.created_vireek++;
  log(ctx, { entity: "invoice", direction: "from_xero", action: "created", vireek_id: newId as string, external_id: doc.id, message: doc.fx ? `Created invoice ${doc.number ?? doc.id} from Xero (${describeFx(doc.fx, ctx.baseCurrency, doc.totalCents)})` : `Created invoice ${doc.number ?? doc.id} from Xero` });
}

const PUSHABLE = new Set(["sent", "partially_paid", "paid", "overdue"]);

async function createInvoiceInXero(ctx: Ctx, v: VInvoice): Promise<"retry" | void> {
  if (!PUSHABLE.has(String(v.row.status))) return;
  const num = String(v.row.invoice_number);
  const customer = v.row.customer_id ? await getLinkByVireek(ctx, "contact", String(v.row.customer_id)) : null;
  if (!customer) {
    warnOnce(ctx, `vinvcust:${v.row.id}`, { entity: "invoice", direction: "to_xero", action: "skipped", vireek_id: v.row.id, message: `Invoice ${num} waits for its customer to be linked to Xero.` });
    return "retry";
  }
  const resolved = resolveLineItems(v.lines, await itemMap(ctx), ctx.settings.defaults);
  if (!resolved.ok) {
    warnOnce(ctx, `vinvitem:${num}`, { entity: "invoice", direction: "to_xero", action: "skipped", vireek_id: v.row.id, message: `Invoice ${num} not sent: ${resolved.reason}` });
    return "retry";
  }
  const tax = planTaxType(Number(v.row.tax_cents), ctx.settings.defaults);
  if (!tax.ok) {
    warnOnce(ctx, `vinvtax:${num}`, { entity: "invoice", direction: "to_xero", action: "skipped", vireek_id: v.row.id, message: `Invoice ${num} not sent: ${tax.reason}` });
    return "retry";
  }
  // An invoice Xero already has under this number is linked, not duplicated.
  if (ctx.settings.defaults.sendInvoiceNumber && canFindInvoiceNumber(num)) {
    const r = await api(ctx, buildFindInvoiceRequest(num));
    if (classifyResponse(r.status, r.json).kind === "ok") {
      for (const rec of parseListResponse("invoice", r.json, XERO_PAGE).records) {
        const p = parseXeroInvoice(rec, parseOpts(ctx));
        if (p.ok && p.doc.totalCents === Number(v.row.total_cents) && !(await getLinkByExternal(ctx, "invoice", p.doc.id))) {
          await reconcileInvoice(ctx, null, v, p.doc, { note: "Matched an existing Xero invoice" });
          log(ctx, { entity: "invoice", direction: "both", action: "linked", vireek_id: v.row.id, external_id: p.doc.id, message: `Linked to existing Xero invoice ${num}` });
          return;
        }
      }
    }
  }
  const payload = buildXeroInvoicePayload(
    { invoiceNumber: num, issueDate: String(v.row.issue_date), dueDate: String(v.row.due_date), taxCents: Number(v.row.tax_cents), lines: resolved.lines },
    customer.external_id, { defaults: ctx.settings.defaults, taxType: tax.taxType },
  );
  const w = await writeXero(ctx, "invoice", payload, { idemKey: idempotencyKey("inv", String(v.row.id), payload) });
  if (!w.ok) {
    ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction: "to_xero", action: "error", vireek_id: v.row.id, message: `Could not create invoice ${num} in Xero: ${w.message}`, tid: w.tid });
    return;
  }
  const m = recordMeta("invoice", w.record);
  await createLink(ctx, "invoice", String(v.row.id), m.id, baseWithFx(invoiceVireekCanon(v), null), m.version);
  ctx.stats.created_xero++;
  log(ctx, { entity: "invoice", direction: "to_xero", action: "created", vireek_id: String(v.row.id), external_id: m.id, message: `Created invoice ${num} in Xero` });
  warnTotals(ctx, v, w.record, m.id);
}

async function pushInvoices(ctx: Ctx, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities.invoice;
  if (es.direction === "from_xero") return;
  let cur: PushState = ctx.cursors.invoice?.push ?? { ts: null, id: null };

  const handle = async (id: string): Promise<"retry" | void> => {
    const v = await loadInvoice(ctx, id);
    if (!v) return;
    const link = await getLinkByVireek(ctx, "invoice", id);
    if (link) {
      const vC = invoiceVireekCanon(v);
      const changed = (["due_date", "amounts", "voided"] as const).some((k) => {
        const type = VIREEK_FIELDS.invoice.find((f) => f.key === k)!.type;
        return normalizeValue(type, vC[k]) !== normalizeValue(type, link.base?.[k]);
      });
      if (!changed && !link.conflict) return;
      const raw = await fetchXero(ctx, "invoice", link.external_id);
      const p = raw ? parseXeroInvoice(raw, parseOpts(ctx)) : null;
      if (!p || !p.ok) {
        if (p && !p.ok) warnOnce(ctx, `inv:${link.external_id}`, { entity: "invoice", direction: "none", action: "skipped", vireek_id: id, external_id: link.external_id, link_id: link.id, message: `Xero invoice cannot be compared: ${p.reason}` });
        return;
      }
      await reconcileInvoice(ctx, link, v, p.doc);
      return;
    }
    if (canCreateInXero(es) && pullDoneOnce) return createInvoiceInXero(ctx, v);
  };

  const stillRetry: string[] = [];
  for (const id of ctx.cursors.invoice?.push?.retry ?? []) if ((await handle(id)) === "retry") stillRetry.push(id);
  const keep = () => [...new Set(stillRetry)].slice(-RETRY_CAP);

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
      ctx.cursors.invoice = { ...ctx.cursors.invoice, push: { ...cur, retry: keep() } };
    }
    await touchRun(ctx);
    if (rows.length < PUSH_PAGE) break;
  }
  ctx.cursors.invoice = { ...ctx.cursors.invoice, push: { ...cur, retry: keep() } };
}

// ============================================================
// PAYMENTS (create-only)
// ============================================================

async function applyXeroPayment(ctx: Ctx, raw: RawRecord): Promise<"retry" | void> {
  const es = ctx.settings.entities.payment;
  const meta = recordMeta("payment", raw);
  if (!isValidXeroId(meta.id)) return;
  const parsed = parseXeroPayment(raw);
  if (!parsed.ok) {
    warnOnce(ctx, `ps:${meta.id}`, { entity: "payment", direction: "from_xero", action: "skipped", external_id: meta.id, message: `Payment skipped: ${parsed.reason}` });
    return;
  }
  const doc = parsed.doc;
  if (doc.deleted) {
    warnOnce(ctx, `pv:${doc.id}`, { entity: "payment", direction: "from_xero", action: "skipped", external_id: doc.id, message: "Payment deleted in Xero. Payments are never reversed automatically: void it in Vireek if needed." });
    return;
  }
  if (!canCreateInVireek(es)) return;
  if (await getLinkByExternal(ctx, "payment", doc.id)) return;
  const invLink = await getLinkByExternal(ctx, "invoice", doc.invoiceId);
  if (!invLink) {
    warnOnce(ctx, `pi:${doc.id}`, { entity: "payment", direction: "from_xero", action: "skipped", external_id: doc.id, message: `Payment ${doc.id} waits for its invoice to sync.` });
    return "retry";
  }
  const inv = await loadInvoice(ctx, invLink.vireek_id);
  if (!inv || inv.row.status === "void") return;
  const remaining = Number(inv.row.total_cents) - Number(inv.row.amount_paid_cents);
  const conv = paymentBaseCents({ amountCents: doc.amountCents, fx: invLink.base?.__fx ?? null, invoiceBaseTotalCents: Number(inv.row.total_cents), remainingBaseCents: remaining });
  if (!conv.ok) {
    ctx.stats.errors++;
    log(ctx, { entity: "payment", direction: "from_xero", action: "error", external_id: doc.id, vireek_id: inv.row.id, message: `${conv.reason} Not recorded.` });
    return;
  }
  const dep = doc.accountId ? await getLinkByExternal(ctx, "account", doc.accountId) : null;
  const { data: payId, error } = await ctx.admin.rpc("xero_record_ar_payment", {
    p_owner: ctx.ownerId, p_invoice_id: inv.row.id, p_amount_cents: conv.cents, p_method: paymentMethodFromText(`${doc.reference ?? ""} ${doc.accountName ?? ""}`), p_date: doc.date, p_deposit_account_id: dep?.vireek_id ?? null,
  });
  if (error || !payId) {
    ctx.stats.errors++;
    log(ctx, { entity: "payment", direction: "from_xero", action: "error", external_id: doc.id, vireek_id: inv.row.id, message: `Could not record the payment: ${error?.message ?? "no id"}` });
    return;
  }
  await createLink(ctx, "payment", payId as string, doc.id, {}, meta.version);
  ctx.stats.created_vireek++;
  log(ctx, { entity: "payment", direction: "from_xero", action: "created", vireek_id: payId as string, external_id: doc.id, message: `Recorded payment of ${conv.cents / 100} from Xero${conv.note ? `. ${conv.note}` : ""}` });
}

async function pushPayments(ctx: Ctx, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities.payment;
  if (!canCreateInXero(es) || !pullDoneOnce) return;
  let cur: PushState = ctx.cursors.payment?.push ?? { ts: null, id: null };
  const stillRetry: string[] = [];

  const handle = async (p: VRow): Promise<"retry" | void> => {
    if (await getLinkByVireek(ctx, "payment", p.id)) return;
    const invLink = await getLinkByVireek(ctx, "invoice", String(p.invoice_id));
    const { data: inv } = await ctx.admin.from("ar_invoices").select("status, invoice_number").eq("id", p.invoice_id).eq("user_id", ctx.ownerId).maybeSingle();
    const invRow = inv as unknown as VRow | null;
    if (!invRow || invRow.status === "void") return;
    if (!invLink) {
      warnOnce(ctx, `vp:${p.id}`, { entity: "payment", direction: "to_xero", action: "skipped", vireek_id: p.id, message: `Payment on invoice ${String(invRow.invoice_number)} waits for the invoice to be linked to Xero.` });
      return "retry";
    }
    if (invLink.base?.__fx) {
      warnOnce(ctx, `vpfx:${p.id}`, { entity: "payment", direction: "to_xero", action: "skipped", vireek_id: p.id, message: `Invoice ${String(invRow.invoice_number)} is in ${invLink.base.__fx.currency} in Xero. Record the payment in Xero so the exchange rate is right.` });
      return;
    }
    const dep = p.deposit_account_id ? await getLinkByVireek(ctx, "account", String(p.deposit_account_id)) : null;
    const accountId = dep?.external_id ?? ctx.settings.defaults.depositAccountId;
    if (!accountId) {
      warnOnce(ctx, `vpacct:${p.id}`, { entity: "payment", direction: "to_xero", action: "skipped", vireek_id: p.id, message: "Payment not sent: choose a deposit account under Mapping → Defaults." });
      return "retry";
    }
    const payload = buildXeroPaymentPayload({ invoiceId: invLink.external_id, accountId, amountCents: Number(p.amount_cents), date: String(p.payment_date), reference: `Vireek payment ${String(p.id).slice(0, 8)} (${String(p.payment_method)})` });
    const w = await writeXero(ctx, "payment", payload, { idemKey: idempotencyKey("pay", p.id, payload) });
    if (!w.ok) {
      ctx.stats.errors++;
      log(ctx, { entity: "payment", direction: "to_xero", action: "error", vireek_id: p.id, message: `Could not create the payment in Xero: ${w.message}`, tid: w.tid });
      return;
    }
    const m = recordMeta("payment", w.record);
    await createLink(ctx, "payment", p.id, m.id, {}, m.version);
    ctx.stats.created_xero++;
    log(ctx, { entity: "payment", direction: "to_xero", action: "created", vireek_id: p.id, external_id: m.id, message: `Sent payment of ${Number(p.amount_cents) / 100} to Xero` });
  };
  const keep = () => [...new Set(stillRetry)].slice(-RETRY_CAP);

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
      ctx.cursors.payment = { ...ctx.cursors.payment, push: { ...cur, retry: keep() } };
    }
    await touchRun(ctx);
    if (rows.length < PUSH_PAGE) break;
  }
  ctx.cursors.payment = { ...ctx.cursors.payment, push: { ...cur, retry: keep() } };
}

// ============================================================
// ORGANISATION + TAX RATES (reference data)
// ============================================================

async function refreshOrganisation(ctx: Ctx) {
  const r = await api(ctx, buildOrganisationRequest());
  if (classifyResponse(r.status, r.json).kind !== "ok") throw new Error(`Could not read the Xero organisation: ${faultText(r)}`);
  const org = parseOrganisation(r.json);
  if (!org) return;
  ctx.baseCurrency = org.baseCurrency;
  await ctx.admin.from("xero_connections").update({ organisation_name: org.name, base_currency: org.baseCurrency, country_code: org.countryCode, is_demo: org.isDemo }).eq("id", ctx.conn.id);
}

async function syncTaxRates(ctx: Ctx) {
  const r = await api(ctx, buildTaxRatesRequest());
  if (classifyResponse(r.status, r.json).kind !== "ok") {
    warnOnce(ctx, "taxrates", { entity: "tax_rate", direction: "from_xero", action: "skipped", message: `Tax rates not refreshed: ${faultText(r)}`, tid: r.tid });
    return;
  }
  const rates = ((r.json as { TaxRates?: RawRecord[] } | null)?.TaxRates ?? []).map(parseTaxRate).filter((x): x is NonNullable<typeof x> => !!x);
  if (!rates.length) return;
  const rows = rates.map((t) => ({
    user_id: ctx.ownerId, connection_id: ctx.conn.id, tax_type: t.taxType, name: t.name, effective_rate: t.effectiveRate, status: t.status,
    report_tax_type: t.reportTaxType, can_apply_to_revenue: t.canApplyToRevenue, components: t.components, fetched_at: new Date().toISOString(),
  }));
  const { error } = await ctx.admin.from("xero_tax_rates").upsert(rows, { onConflict: "connection_id,tax_type" });
  if (error) {
    console.error("xero tax rate upsert failed", error.message);
    return;
  }
  // Rates removed in Xero disappear here too (tax types are validated against a strict pattern).
  await ctx.admin.from("xero_tax_rates").delete().eq("connection_id", ctx.conn.id).not("tax_type", "in", `(${rates.map((t) => t.taxType).join(",")})`);
}

// ============================================================
// RUN LIFECYCLE
// ============================================================

async function acquireLock(admin: AnyClient, connId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await admin
    .from("xero_connections")
    .update({ sync_locked_until: new Date(Date.now() + LOCK_MS).toISOString() })
    .eq("id", connId)
    .or(`sync_locked_until.is.null,sync_locked_until.lt.${now}`)
    .select("id");
  return (data?.length ?? 0) > 0;
}

async function buildCtx(admin: AnyClient, conn: ConnRow, runId: string | null, deadline: number): Promise<Ctx> {
  const encKey = Deno.env.get("XERO_TOKEN_ENCRYPTION_KEY") ?? "";
  const { data: sec } = await admin.from("xero_connection_secrets").select("access_token_enc, refresh_token_enc, expires_at").eq("connection_id", conn.id).maybeSingle();
  if (!sec || !encKey) throw new AuthError("No stored credentials. Please reconnect.");
  const valid = validateSettings(conn.settings && Object.keys(conn.settings as object).length ? conn.settings : defaultSettings());
  if (!valid.ok) throw new Error(`Saved settings are invalid: ${valid.error}`);
  const { data: regional } = await admin.from("business_regional_settings").select("currency").eq("user_id", conn.user_id).maybeSingle();
  const ctx: Ctx = {
    admin, conn, ownerId: conn.user_id, tenantId: conn.tenant_id, settings: valid.settings, cursors: { ...(conn.cursors ?? {}) },
    runId, stats: emptyStats(), logs: [], deadline,
    access: await decryptSecret(sec.access_token_enc as string, encKey),
    refresh: await decryptSecret(sec.refresh_token_enc as string, encKey),
    lastProgressAt: 0, warned: new Set(),
    baseCurrency: (conn.base_currency ?? "").toUpperCase(),
    vireekCurrency: String((regional as { currency?: string } | null)?.currency ?? "USD").toUpperCase(),
    moneyOk: false,
  };
  const exp = sec.expires_at ? Date.parse(sec.expires_at as string) : null;
  if (exp !== null && exp - Date.now() < 120_000) await refreshAccess(ctx);
  return ctx;
}

async function mirrorIntegration(admin: AnyClient, conn: ConnRow, status: "connected" | "error" | "disconnected", extra: Record<string, unknown> = {}) {
  const { data: c } = await admin.from("xero_connections").select("organisation_name, base_currency, tenant_id").eq("id", conn.id).maybeSingle();
  await admin.from("integrations").upsert(
    { user_id: conn.user_id, integration_type: "xero", status, config: { tenant_id: c?.tenant_id ?? conn.tenant_id, organisation_name: c?.organisation_name ?? null, base_currency: c?.base_currency ?? null, ...extra } },
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
    await admin.from("xero_sync_log").delete().eq("connection_id", conn.id).lt("created_at", new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString());
    ctx = await buildCtx(admin, conn, runId, Date.now() + RUN_BUDGET_MS);
    await refreshOrganisation(ctx);
    if (ctx.settings.defaults.syncTaxRates) await syncTaxRates(ctx);

    // Money documents only sync when both ledgers share one base currency.
    const cur = checkBaseCurrency(ctx.baseCurrency, ctx.vireekCurrency);
    ctx.moneyOk = cur.ok;
    let moneyReason: string | null = null;
    if (!cur.ok) {
      moneyReason = cur.reason;
      warnOnce(ctx, "currency", { entity: "invoice", direction: "none", action: "skipped", message: cur.reason });
    }
    let dependenciesDone = true;

    for (const entity of XERO_ENTITIES) {
      const es = ctx.settings.entities[entity];
      if (!es.enabled) continue;
      if (overDeadline(ctx)) {
        allFinished = false;
        break;
      }
      if ((entity === "invoice" || entity === "payment") && !ctx.moneyOk) continue;
      if ((entity === "invoice" || entity === "payment") && !dependenciesDone) {
        allFinished = false;
        continue;
      }
      const apply = (raw: RawRecord): Promise<"retry" | void> =>
        entity === "invoice" ? applyXeroInvoice(ctx!, raw) : entity === "payment" ? applyXeroPayment(ctx!, raw) : applyXeroRecord(ctx!, entity, raw);
      const finished = es.direction === "to_xero" ? true : await pullEntity(ctx, entity, apply);
      if (!finished) {
        allFinished = false;
        if (entity !== "invoice" && entity !== "payment") dependenciesDone = false;
      }
      const pullDoneOnce = es.direction === "to_xero" || !!ctx.cursors[entity]?.pull?.since;
      if (entity === "invoice") await pushInvoices(ctx, pullDoneOnce);
      else if (entity === "payment") await pushPayments(ctx, pullDoneOnce);
      else await pushSimple(ctx, entity, pullDoneOnce);
    }
    if (!allFinished || overDeadline(ctx)) {
      status = "partial";
      error = "Large sync in progress. It will continue automatically on the next run.";
    }
    if (moneyReason) {
      status = "partial";
      error = moneyReason;
    }
    if (ctx.stats.errors > 0 && status === "success") status = "partial";
  } catch (err) {
    status = "failed";
    if (err instanceof AuthError) {
      markError = true;
      errorCode = "token_revoked";
      error = "Xero needs to be re-authorised. Disconnect and connect again.";
    } else if (err instanceof RateLimitError) {
      status = "partial";
      error = `${err.message} The sync will retry on the next run.`;
    } else {
      error = err instanceof Error ? err.message.slice(0, 400) : "Unexpected sync error.";
      console.error("xero-sync-run failed", conn.id, err);
    }
  } finally {
    if (ctx) {
      await flushLogs(ctx);
      if (ctx.runId) await admin.from("xero_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
    }
    await admin.from("xero_sync_runs").update({ status, error, finished_at: new Date().toISOString(), ...(ctx ? { stats: ctx.stats } : {}) }).eq("id", runId);
    await admin
      .from("xero_connections")
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
  await admin.from("xero_sync_runs").update({ status: "failed", error: "Interrupted.", finished_at: new Date().toISOString() }).eq("connection_id", conn.id).eq("status", "running").lt("started_at", new Date(Date.now() - 10 * 60_000).toISOString());
  const { data } = await admin.from("xero_sync_runs").insert({ user_id: conn.user_id, connection_id: conn.id, trigger, status: "running" }).select("id").single();
  if (!data) {
    await admin.from("xero_connections").update({ sync_locked_until: null }).eq("id", conn.id);
    return null;
  }
  return data.id as string;
}

const background = (p: Promise<unknown>) => {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(p);
  else void p;
};

const CONN_COLS = "id, user_id, tenant_id, xero_connection_id, status, base_currency, settings, cursors";

/** Live lists for the mapping UI. Names only; accounts / items are never cached or stored. */
async function listOptions(ctx: Ctx) {
  await refreshOrganisation(ctx);
  const cur = checkBaseCurrency(ctx.baseCurrency, ctx.vireekCurrency);
  const get = async (req: HttpReq) => {
    const r = await api(ctx, req);
    return classifyResponse(r.status, r.json).kind === "ok" ? r.json : null;
  };
  const accRaw = ((await get(buildListRequest({ entity: "account", page: 1, pageSize: XERO_PAGE, modifiedSinceMs: null })) as { Accounts?: RawRecord[] } | null)?.Accounts ?? []);
  const accounts = accRaw
    .filter((a) => String(a.Status ?? "ACTIVE").toUpperCase() === "ACTIVE")
    .map((a) => ({ id: String(a.AccountID ?? ""), code: String(a.Code ?? ""), name: String(a.Name ?? ""), type: String(a.Type ?? ""), classification: String(a.Class ?? ""), bank: a.Type === "BANK" || a.EnablePaymentsToAccount === true }))
    .filter((a) => isValidXeroId(a.id));
  const itemRaw = ((await get(buildListRequest({ entity: "item", page: 1, pageSize: XERO_PAGE, modifiedSinceMs: null })) as { Items?: RawRecord[] } | null)?.Items ?? []);
  const items = itemRaw.filter(isSyncableItem).map((i) => ({ code: String(i.Code), name: String(i.Name ?? i.Code) }));
  const taxJson = await get(buildTaxRatesRequest());
  const taxRates = (((taxJson as { TaxRates?: RawRecord[] } | null)?.TaxRates ?? []).map(parseTaxRate).filter((x): x is NonNullable<typeof x> => !!x));
  const currencies = parseCurrencies(await get(buildCurrenciesRequest()));
  const { data: regional } = await ctx.admin.from("business_regional_settings").select("default_tax_rate").eq("user_id", ctx.ownerId).maybeSingle();
  return {
    accounts, items, taxRates, currencies,
    organisation: { baseCurrency: ctx.baseCurrency, vireekCurrency: ctx.vireekCurrency, currencyOk: cur.ok, reason: cur.ok ? null : cur.reason },
    vireekTaxRate: regional ? Number((regional as { default_tax_rate: number }).default_tax_rate) : null,
  };
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
    let q = admin.from("xero_connections").select(CONN_COLS).eq("status", "connected");
    let trigger: "scheduled" | "webhook" = "scheduled";
    if (body.action === "webhook") {
      const tenants = Array.isArray(body.tenant_ids) ? (body.tenant_ids as unknown[]).filter(isValidXeroId) : [];
      if (!tenants.length) return json({ queued: 0 }, 202);
      q = q.in("tenant_id", tenants);
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
  const { data: allowed } = await caller.rpc("can_manage_xero");
  if (allowed !== true) return json({ error: "You don't have permission to manage Xero sync." }, 403);

  const loadConn = async (id: unknown): Promise<ConnRow | null> => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data } = await admin.from("xero_connections").select(CONN_COLS).eq("id", id).eq("user_id", ownerId).maybeSingle();
    return (data as ConnRow | null) ?? null;
  };

  if (body.action === "run" || body.action === "resync") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    if (conn.status === "disconnected") return json({ error: "Xero is disconnected." }, 409);
    const runId = await beginRun(admin, conn, "manual");
    if (!runId) return json({ error: "A sync is already running." }, 409);
    // Full re-read: merge is idempotent, so this only repairs; it never duplicates or overwrites unchanged data.
    if (body.action === "resync") {
      await admin.from("xero_connections").update({ cursors: {} }).eq("id", conn.id);
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
    for (const e of XERO_ENTITIES) {
      const sig = (s: XeroSettings) => JSON.stringify([s.entities[e].enabled, s.entities[e].direction, s.entities[e].fields]);
      if (!old.ok || sig(old.settings) !== sig(v.settings)) delete cursors[e];
    }
    const update: Record<string, unknown> = { settings: v.settings, cursors };
    if (typeof body.auto_sync === "boolean") update.auto_sync = body.auto_sync;
    const { error } = await admin.from("xero_connections").update(update).eq("id", conn.id);
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
      return json({ error: err instanceof AuthError ? "Reconnect Xero and try again." : "Could not load Xero lists." }, 502);
    }
  }

  if (body.action === "disconnect") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    // Best effort: remove the connection at Xero (the app disappears from the organisation's connected apps) and revoke the token.
    try {
      const encKey = Deno.env.get("XERO_TOKEN_ENCRYPTION_KEY") ?? "";
      const { data: sec } = await admin.from("xero_connection_secrets").select("access_token_enc, refresh_token_enc").eq("connection_id", conn.id).maybeSingle();
      if (sec && encKey) {
        const clientId = Deno.env.get("XERO_CLIENT_ID") ?? "";
        const clientSecret = Deno.env.get("XERO_CLIENT_SECRET") ?? "";
        let access = await decryptSecret(sec.access_token_enc as string, encKey);
        const rt = await decryptSecret(sec.refresh_token_enc as string, encKey);
        if (conn.xero_connection_id && isValidXeroId(conn.xero_connection_id)) {
          let res = await fetch(`https://api.xero.com/connections/${conn.xero_connection_id}`, { method: "DELETE", headers: { Authorization: `Bearer ${access}` } });
          if (res.status === 401) {
            const t = buildTokenRequest("refresh", { clientId, clientSecret, refreshToken: rt });
            const tr = await fetch(t.url, { method: "POST", headers: t.headers, body: t.body });
            if (tr.ok) {
              access = parseTokenResponse(await tr.json()).accessToken;
              res = await fetch(`https://api.xero.com/connections/${conn.xero_connection_id}`, { method: "DELETE", headers: { Authorization: `Bearer ${access}` } });
            }
          }
        }
        const rv = buildRevokeRequest({ clientId, clientSecret, refreshToken: rt });
        await fetch(rv.url, { method: "POST", headers: rv.headers, body: rv.body });
      }
    } catch (err) {
      console.error("xero revoke failed", err instanceof Error ? err.message : err);
    }
    await admin.from("xero_connection_secrets").delete().eq("connection_id", conn.id);
    await admin.from("xero_record_links").delete().eq("connection_id", conn.id);
    await admin.from("xero_tax_rates").delete().eq("connection_id", conn.id);
    await admin.from("xero_connections").update({ status: "disconnected", cursors: {}, last_error: null, sync_locked_until: null }).eq("id", conn.id);
    await mirrorIntegration(admin, conn, "disconnected", { error_code: "manual_disconnect" });
    return json({ ok: true });
  }

  if (body.action === "resolve_conflict") {
    const winner = body.winner === "vireek" || body.winner === "xero" ? body.winner : null;
    if (!winner || typeof body.link_id !== "string") return json({ error: "Invalid request." }, 400);
    const { data: link } = await admin.from("xero_record_links").select(`${LINK_COLS}, connection_id`).eq("id", body.link_id).eq("user_id", ownerId).maybeSingle();
    if (!link) return json({ error: "Conflict not found." }, 404);
    const conn = await loadConn((link as { connection_id: string }).connection_id);
    if (!conn || conn.status !== "connected") return json({ error: "Xero is not connected." }, 409);
    if (!(await acquireLock(admin, conn.id))) return json({ error: "A sync is running. Try again in a moment." }, 409);
    let ctx: Ctx | null = null;
    try {
      ctx = await buildCtx(admin, conn, null, Date.now() + 60_000);
      const l = link as unknown as LinkRow;
      const ruleOverride = winner === "vireek" ? "vireek_wins" : "xero_wins";
      const note = `Conflict resolved (kept ${winner === "vireek" ? "Vireek" : "Xero"})`;
      if (l.entity === "payment") return json({ error: "Payments are never edited. Void the payment in Vireek if it is wrong." }, 400);
      if (l.entity === "invoice") {
        await refreshOrganisation(ctx);
        const raw = await fetchXero(ctx, "invoice", l.external_id);
        const v = await loadInvoice(ctx, l.vireek_id);
        const p = raw ? parseXeroInvoice(raw, parseOpts(ctx)) : null;
        if (!v || !p || !p.ok) return json({ error: "One of the two records no longer exists or cannot be compared." }, 410);
        const result = await reconcileInvoice(ctx, l, v, p.doc, { ruleOverride, note });
        await flushLogs(ctx);
        return result === "error" ? json({ error: "Could not apply that choice. See the sync log." }, 502) : json({ ok: true });
      }
      const raw = await fetchXero(ctx, l.entity, l.external_id);
      const vRow = await getVireekRow(ctx, l.entity as Simple, l.vireek_id);
      if (!vRow || !raw) return json({ error: "One of the two records no longer exists." }, 410);
      const result = await reconcile(ctx, l.entity as Simple, l, vRow, raw, { ruleOverride, note });
      await flushLogs(ctx);
      return result === "error" ? json({ error: "Could not apply that choice. See the sync log." }, 502) : json({ ok: true });
    } catch (err) {
      console.error("xero resolve_conflict failed", err);
      return json({ error: err instanceof AuthError ? "Reconnect Xero and try again." : "Could not resolve this conflict." }, 502);
    } finally {
      await admin.from("xero_connections").update({ sync_locked_until: null }).eq("id", conn.id);
      if (ctx) await flushLogs(ctx);
    }
  }

  return json({ error: "Unknown action." }, 400);
});
