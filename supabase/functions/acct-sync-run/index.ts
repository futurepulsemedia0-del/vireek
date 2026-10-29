// supabase/functions/acct-sync-run/index.ts
//
// Two-way sync of accounts, customers, items, invoices and payments with Xero, Zoho Books and NetSuite.
// One engine for all three providers: everything provider-specific lives in _shared/accounting/<provider>.ts.
//
// Actions (POST JSON):
//   { action: "run",              connection_id }                       -> 202 { run_id }
//   { action: "resync",           connection_id }                       -> 202 { run_id }  re-read everything (merge is idempotent)
//   { action: "save_settings",    connection_id, settings, auto_sync? } -> { ok, settings }
//   { action: "options",          connection_id }                       -> { accounts, items, taxCodes, subsidiaries } live lists for the mapping UI
//   { action: "disconnect",       connection_id }                       -> { ok }
//   { action: "resolve_conflict", link_id, winner: "vireek"|"ext" }     -> { ok }
//   { action: "cron" }                       + header X-Cron-Secret     -> 202  scheduled sync of all due connections
//   { action: "webhook", provider, tenant_ids } + header X-Cron-Secret  -> 202  called by acct-webhook
//
// SECRETS: see acct-oauth-start/index.ts. Deploy: supabase functions deploy acct-sync-run --no-verify-jwt
//
// HOW A RUN WORKS (order: accounts, customers, items, invoices, payments; each: PULL then PUSH)
//   1. PULL changed provider records (watermark + resumable page cursor). A record whose change marker equals the
//      one stored on its link is skipped without any further API call.
//   2. PUSH changed Vireek records and reconcile each one against the live provider record.
//   `reconcile` is a field-level THREE-WAY merge against the base snapshot stored on the link, so only fields that
//   changed since the last sync move and our own writes never echo back.
//
// SAFETY
//   - Tenant scope: ownerId comes from get_account_owner_id() (or the connection row for cron/webhook) and is
//     applied to every query on top of the service-role client.
//   - Records are only CREATED on the other side after the first full pull of that entity finished.
//   - Money documents go through the general-ledger functions (balanced, period-locked). An invoice with payments
//     is never re-itemised or voided automatically: it becomes a conflict for a human to resolve.
//   - Deletes are never propagated in either direction. Payments are create-only.
//   - Tokens are AES-GCM encrypted at rest and only sent to allow-listed provider hosts.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  ACCT_ENTITIES,
  ENTITY_META,
  PAGE_CAP_PER_RUN,
  QUERY_PAGE,
  accountTypeFromClassification,
  canCreateInExt,
  canCreateInVireek,
  decryptSecret,
  defaultSettings,
  emptyStats,
  encryptSecret,
  escapeLike,
  generatedAccountCode,
  invoiceAmountSig,
  isProvider,
  isSafeId,
  mergeEntity,
  mergeFieldsFor,
  normText,
  normalBalanceFor,
  normalizeValue,
  paymentLinkKey,
  paymentMethodFromName,
  parseTimestamp,
  parseTokenResponse,
  resolveLineItems,
  toCents,
  validateSettings,
  fieldsFor,
  type AcctEntity,
  type AcctProvider,
  type AcctSettings,
  type Adapter,
  type Canon,
  type ConnInfo,
  type ExtInvoiceDoc,
  type InvoiceLine,
  type OptionRow,
  type Provider,
  type RawRecord,
  type SimpleEntity,
  type SyncStats,
  type PulledRecord,
  type HttpReq,
} from "../_shared/accounting/core.ts";
import { PROVIDERS } from "../_shared/accounting/registry.ts";
import { XERO_CONNECTIONS_URL, XERO_REVOKE_URL } from "../_shared/accounting/xero.ts";
import { zohoRevokeUrl, isZohoRegion } from "../_shared/accounting/zoho.ts";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class AuthError extends Error {}
class RateLimitError extends Error {}

// ============================================================
// TYPES
// ============================================================

interface PullState { since: string | null; pos: number | null; passStarted: string | null; retry?: string[] }
interface PushState { ts: string | null; id: string | null; retry?: string[] }
interface EntityCursor { pull?: PullState; push?: PushState }
interface ConnRow {
  id: string;
  user_id: string;
  provider: AcctProvider;
  tenant_id: string;
  region: string | null;
  config: Record<string, unknown> | null;
  status: string;
  settings: unknown;
  cursors: Record<string, EntityCursor> | null;
}
interface LinkRow {
  id: string;
  entity: AcctEntity;
  vireek_id: string;
  external_id: string;
  sync_token: string | null;
  base: Canon;
  conflict: { fields: string[]; sig: string; reason?: string } | null;
}
type VRow = Record<string, unknown> & { id: string; updated_at?: string };
type Outcome = "ok" | "conflict" | "error" | "skipped";

interface LogEntry {
  entity: AcctEntity;
  direction: "to_ext" | "from_ext" | "both" | "none";
  action: "created" | "updated" | "linked" | "voided" | "conflict" | "skipped" | "error";
  vireek_id?: string | null;
  external_id?: string | null;
  link_id?: string | null;
  message: string;
  details?: unknown;
  ref?: string | null;
}

interface Ctx {
  admin: AnyClient;
  conn: ConnRow;
  ownerId: string;
  provider: AcctProvider;
  p: Provider;
  a: Adapter;
  c: ConnInfo;
  settings: AcctSettings;
  cursors: Record<string, EntityCursor>;
  runId: string | null;
  stats: SyncStats;
  logs: Record<string, unknown>[];
  deadline: number;
  access: string;
  refresh: string | null;
  lastProgressAt: number;
  lastCallAt: number;
  warned: Set<string>;
  itemByName?: Map<string, string>;
}
interface ApiResult { status: number; json: unknown; ref: string | null; location: string | null }

const label = (ctx: Ctx) => ctx.p.adapter.provider === "xero" ? "Xero" : ctx.provider === "zoho_books" ? "Zoho Books" : "NetSuite";

// ============================================================
// LOG / RUN BOOKKEEPING
// ============================================================

function log(ctx: Ctx, e: LogEntry) {
  ctx.logs.push({
    user_id: ctx.ownerId, connection_id: ctx.conn.id, run_id: ctx.runId, entity: e.entity, direction: e.direction, action: e.action,
    vireek_id: e.vireek_id ?? null, external_id: e.external_id ?? null, link_id: e.link_id ?? null,
    message: e.message.slice(0, 500), details: e.details ?? null, request_ref: e.ref ?? null,
  });
}
async function flushLogs(ctx: Ctx) {
  if (!ctx.logs.length) return;
  const rows = ctx.logs.splice(0);
  const { error } = await ctx.admin.from("acct_sync_log").insert(rows);
  if (error) console.error("acct-sync log insert failed", error.message);
}
async function touchRun(ctx: Ctx, force = false) {
  if (!ctx.runId) return;
  if (!force && Date.now() - ctx.lastProgressAt < 3000) return;
  ctx.lastProgressAt = Date.now();
  await ctx.admin.from("acct_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
  if (ctx.logs.length >= 40) await flushLogs(ctx);
}
const overDeadline = (ctx: Ctx) => Date.now() > ctx.deadline;
const warnOnce = (ctx: Ctx, key: string, e: LogEntry) => {
  if (ctx.warned.has(key)) return;
  ctx.warned.add(key);
  log(ctx, e);
};

// ============================================================
// PROVIDER HTTP (token refresh, pacing, retry, rate limits)
// ============================================================

const encKey = () => Deno.env.get("ACCT_TOKEN_ENCRYPTION_KEY") ?? "";
const envOf = (p: Provider, name: string) => Deno.env.get(`${p.auth.envPrefix}_${name}`) ?? "";

async function persistTokens(ctx: Ctx, expiresInSec: number | null, refreshExpiresInSec: number | null) {
  const key = encKey();
  await ctx.admin.from("acct_connection_secrets").update({
    access_token_enc: await encryptSecret(ctx.access, key),
    refresh_token_enc: ctx.refresh ? await encryptSecret(ctx.refresh, key) : null,
    expires_at: expiresInSec ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("connection_id", ctx.conn.id);
  if (refreshExpiresInSec) {
    await ctx.admin.from("acct_connections").update({ refresh_token_expires_at: new Date(Date.now() + refreshExpiresInSec * 1000).toISOString() }).eq("id", ctx.conn.id);
  }
}

async function refreshAccess(ctx: Ctx) {
  const cfg = ctx.c.config;
  const req = ctx.provider === "netsuite"
    ? await ctx.p.auth.tokenRequest("client", {
        clientId: String(cfg.client_id ?? ""), clientSecret: "", c: ctx.c, certificateId: String(cfg.certificate_id ?? ""),
        privateKeyPem: Deno.env.get("NETSUITE_M2M_PRIVATE_KEY") ?? "", alg: Deno.env.get("NETSUITE_M2M_ALG") ?? "ES256",
      })
    : await ctx.p.auth.tokenRequest("refresh", { clientId: envOf(ctx.p, "CLIENT_ID"), clientSecret: envOf(ctx.p, "CLIENT_SECRET"), refreshToken: ctx.refresh ?? "", region: ctx.c.region });
  if (!ctx.p.auth.isAllowedTokenUrl(req.url, ctx.c)) throw new Error("Refusing to send credentials outside the provider.");
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 429) throw new RateLimitError("Token endpoint rate limited.");
  if (res.status >= 500) throw new Error(`${label(ctx)} token endpoint error ${res.status}`);
  if (!res.ok) throw new AuthError(String(j.error_description ?? j.error ?? "Refresh failed."));
  const t = parseTokenResponse(j);
  ctx.access = t.accessToken;
  if (t.refreshToken) ctx.refresh = t.refreshToken; // Xero rotates refresh tokens: ALWAYS keep the newest one.
  await persistTokens(ctx, t.expiresInSec, t.refreshExpiresInSec);
}

async function api(ctx: Ctx, req: HttpReq): Promise<ApiResult> {
  if (!ctx.a.isAllowedUrl(req.url, ctx.c)) throw new Error(`Refusing to call an address outside ${label(ctx)}.`);
  let refreshed = false;
  let waited = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const gap = ctx.a.caps.minGapMs - (Date.now() - ctx.lastCallAt);
    if (gap > 0) await sleep(gap);
    ctx.lastCallAt = Date.now();
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: { ...ctx.a.authHeaders(ctx.access, ctx.c), ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(req.headers ?? {}) },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      });
    } catch (err) {
      if (attempt < 2) { await sleep(800); continue; }
      throw err;
    }
    if (res.status === 401 && !refreshed) { refreshed = true; await refreshAccess(ctx); continue; }
    if (res.status === 401) throw new AuthError(`${label(ctx)} rejected our credentials.`);
    if (res.status === 429) {
      const wait = Number(res.headers.get("Retry-After") ?? "");
      if (!waited && Number.isFinite(wait) && wait > 0 && wait <= 15) { waited = true; await sleep(wait * 1000); continue; }
      throw new RateLimitError(`${label(ctx)} is rate limiting requests.`);
    }
    if (res.status >= 500 && attempt < 2) { await sleep(1000); continue; }
    const text = res.status === 204 ? "" : await res.text();
    let body: unknown = null;
    if (text) { try { body = JSON.parse(text); } catch { body = null; } }
    return { status: res.status, json: body, ref: res.headers.get("x-request-id") ?? res.headers.get("x-correlation-id") ?? res.headers.get("x-xero-correlation-id"), location: res.headers.get("location") };
  }
  throw new Error(`${label(ctx)} request failed.`);
}

const faultText = (ctx: Ctx, r: ApiResult) => ctx.a.classify(r.status, r.json).message || `HTTP ${r.status}`;

async function fetchExt(ctx: Ctx, entity: AcctEntity, id: string): Promise<RawRecord | null> {
  let req: HttpReq;
  try { req = ctx.a.get(ctx.c, entity, id); } catch { return null; }
  const r = await api(ctx, req);
  const k = ctx.a.classify(r.status, r.json).kind;
  if (k === "notfound") return null;
  if (k !== "ok") throw new Error(`${label(ctx)} lookup failed: ${faultText(ctx, r)}`);
  return ctx.a.parseOne(entity, r.json);
}

type WriteResult = { ok: true; record: RawRecord; id: string; ref: string | null } | { ok: false; kind: string; message: string; ref: string | null };
async function writeExt(ctx: Ctx, entity: AcctEntity, req: HttpReq, knownId?: string): Promise<WriteResult> {
  const r = await api(ctx, req);
  const c = ctx.a.classify(r.status, r.json);
  if (c.kind !== "ok") return { ok: false, kind: c.kind, message: c.message || `HTTP ${r.status}`, ref: r.ref };
  const w = ctx.a.parseWrite(entity, r.json, r.location);
  const id = w.id ?? knownId ?? null;
  let record = w.record;
  if ((!record || ctx.a.caps.refetchAfterWrite) && id) record = await fetchExt(ctx, entity, id);
  if (!record) return { ok: false, kind: "error", message: `${label(ctx)} returned no record.`, ref: r.ref };
  return { ok: true, record, id: ctx.a.meta(entity, record).id || id || "", ref: r.ref };
}

// ============================================================
// VIREEK-SIDE HELPERS
// ============================================================

const COLS: Record<SimpleEntity, string> = {
  account: "id, code, name, type, is_active, is_system, updated_at",
  customer: "id, name, email, phone, address, notes, updated_at",
  item: "id, service_name, description, price_cents, active, updated_at",
};
const INVOICE_COLS = "id, customer_id, invoice_number, status, issue_date, due_date, subtotal_cents, tax_cents, total_cents, amount_paid_cents, updated_at";
const PAYMENT_COLS = "id, invoice_id, amount_cents, payment_date, payment_method, deposit_account_id, created_at";

function vireekCanon(entity: SimpleEntity, r: VRow): Canon {
  switch (entity) {
    case "customer": return { name: r.name as string, email: r.email as string, phone: r.phone as string, address: r.address as string, notes: r.notes as string };
    case "item": return { name: r.service_name as string, description: r.description as string, price: (r.price_cents as number) / 100, active: r.active === false ? "inactive" : "active" };
    case "account": return { code: r.code as string, name: r.name as string, active: r.is_active === false ? "inactive" : "active" };
  }
}
function toColumns(entity: SimpleEntity, v: Canon): Record<string, unknown> {
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
const shortHash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };
/** Idempotency key: stable per record AND payload, so a changed payload never collides with an earlier attempt. */
const rid = (prefix: string, id: string, payload?: unknown) => `${prefix}-${id.replace(/-/g, "")}${payload === undefined ? "" : `-${shortHash(JSON.stringify(payload))}`}`.slice(0, 60);

async function getVireekRow(ctx: Ctx, entity: SimpleEntity, id: string): Promise<VRow | null> {
  const { data } = await ctx.admin.from(ENTITY_META[entity].table).select(COLS[entity]).eq("id", id).eq("user_id", ctx.ownerId).maybeSingle();
  return (data as VRow | null) ?? null;
}

// ---- links ----------------------------------------------------------------

const LINK_COLS = "id, entity, vireek_id, external_id, sync_token, base, conflict";
async function getLinkByExternal(ctx: Ctx, entity: AcctEntity, externalId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin.from("acct_record_links").select(LINK_COLS).eq("connection_id", ctx.conn.id).eq("entity", entity).eq("external_id", externalId).maybeSingle();
  return (data as LinkRow | null) ?? null;
}
async function getLinkByVireek(ctx: Ctx, entity: AcctEntity, vireekId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin.from("acct_record_links").select(LINK_COLS).eq("connection_id", ctx.conn.id).eq("entity", entity).eq("vireek_id", vireekId).maybeSingle();
  return (data as LinkRow | null) ?? null;
}
async function createLink(ctx: Ctx, entity: AcctEntity, vireekId: string, externalId: string, base: Canon, syncToken: string | null): Promise<LinkRow | null> {
  const { data, error } = await ctx.admin.from("acct_record_links")
    .insert({ user_id: ctx.ownerId, connection_id: ctx.conn.id, entity, vireek_id: vireekId, external_id: externalId, base, sync_token: syncToken || null })
    .select(LINK_COLS).single();
  if (error) { console.error("acct link insert failed", error.message); return null; }
  return data as LinkRow;
}
async function saveLink(ctx: Ctx, link: LinkRow, patch: { base?: Canon; sync_token?: string | null; conflict?: LinkRow["conflict"] }) {
  await ctx.admin.from("acct_record_links").update({ ...patch, last_synced_at: new Date().toISOString() }).eq("id", link.id);
}
function addRetry(list: string[] | undefined, id: string): string[] {
  const set = new Set(list ?? []);
  set.add(id);
  return [...set].slice(-RETRY_CAP);
}
/** Extra values kept on a link base for later lookups (never merged). */
function linkExtras(ctx: Ctx, entity: AcctEntity, raw: RawRecord, canon: Canon): Canon {
  if (entity === "item") return { __income: ctx.a.itemIncomeRef(raw) };
  if (entity === "account") return { __code: canon.code ?? null };
  return {};
}

// ============================================================
// SIMPLE ENTITIES: accounts, customers, items
// ============================================================

function conflictSig(fields: string[], v: Canon, q: Canon): string {
  return JSON.stringify([fields, fields.map((f) => [v[f] ?? null, q[f] ?? null])]);
}

async function applyVireekUpdate(ctx: Ctx, entity: SimpleEntity, id: string, values: Canon): Promise<string | null> {
  const cols = toColumns(entity, values);
  if (!Object.keys(cols).length) return null;
  const { error } = await ctx.admin.from(ENTITY_META[entity].table).update(cols).eq("id", id).eq("user_id", ctx.ownerId);
  return error ? error.message : null;
}

async function reconcile(
  ctx: Ctx, entity: SimpleEntity, link: LinkRow | null, vRow: VRow, raw: RawRecord,
  opts: { ruleOverride?: "vireek_wins" | "ext_wins"; note?: string; version?: string } = {},
): Promise<Outcome> {
  const es = ctx.settings.entities[entity];
  const meta = ctx.a.meta(entity, raw);
  const vC = vireekCanon(entity, vRow);
  const qC = ctx.a.toCanon(entity, raw);
  const res = mergeEntity({ provider: ctx.provider, entity, settings: es, base: stripMeta(link?.base ?? null), vireek: vC, ext: qC, vireekTs: tsOf(vRow), extTs: meta.modifiedAt, ruleOverride: opts.ruleOverride });
  let version = opts.version ?? meta.version;
  const next: Canon = { ...res.next };
  let failed = false;
  const who = label(ctx);

  if (Object.keys(res.toVireek).length) {
    const err = await applyVireekUpdate(ctx, entity, vRow.id, res.toVireek);
    if (err) {
      failed = true; ctx.stats.errors++;
      log(ctx, { entity, direction: "from_ext", action: "error", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `Could not update Vireek: ${err}` });
      for (const k of Object.keys(res.toVireek)) next[k] = link?.base?.[k] ?? null;
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity, direction: "from_ext", action: "updated", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: opts.note ?? `Updated from ${who} (${Object.keys(res.toVireek).join(", ")})`, details: res.toVireek });
    }
  }

  if (Object.keys(res.toCrm).length) {
    const payload = ctx.a.toPayload(entity, res.toCrm, { defaults: ctx.settings.defaults, existing: raw, vireekId: vRow.id }, false);
    const w = Object.keys(payload).length ? await writeExt(ctx, entity, ctx.a.update(ctx.c, entity, meta.id, payload, meta.version || null), meta.id) : null;
    if (!w || w.ok) {
      if (w) version = ctx.a.meta(entity, w.record).version;
      ctx.stats.updated_ext++;
      log(ctx, { entity, direction: "to_ext", action: "updated", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: opts.note ?? `Updated in ${who} (${Object.keys(res.toCrm).join(", ")})`, details: res.toCrm });
    } else {
      failed = true; ctx.stats.errors++;
      log(ctx, { entity, direction: "to_ext", action: "error", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `${who} rejected the update: ${w.message}`, ref: w.ref });
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

  const base: Canon = { ...next, ...linkExtras(ctx, entity, raw, qC) };
  // A failed write must be retried: forget the marker so the next pull looks at the record again.
  const token = failed ? null : version;
  if (link) await saveLink(ctx, link, { base, sync_token: token, conflict });
  else await createLink(ctx, entity, vRow.id, meta.id, base, token);
  return failed ? "error" : conflict ? "conflict" : "ok";
}

async function findVireekMatch(ctx: Ctx, entity: SimpleEntity, qC: Canon): Promise<VRow | null> {
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
  return (await getLinkByVireek(ctx, entity, r.id)) ? null : r;
}

async function createVireekRow(ctx: Ctx, entity: SimpleEntity, raw: RawRecord, qC: Canon, extId: string): Promise<{ row?: VRow; error?: string; skip?: string }> {
  let insert: Record<string, unknown>;
  if (entity === "customer") {
    if (!qC.name) return { skip: "Customer has no name." };
    insert = { ...toColumns("customer", qC), user_id: ctx.ownerId, source: "import", lifecycle_stage: "active", customer_type: "residential" };
  } else if (entity === "item") {
    if (!qC.name) return { skip: "Item has no name." };
    insert = { ...toColumns("item", qC), user_id: ctx.ownerId, pricing_model: "flat", price_cents: Math.max(0, toCents(qC.price ?? 0)) };
  } else {
    const type = ctx.a.accountTypeOf(raw);
    if (!type || !qC.name) return { skip: "Account has no recognisable classification." };
    insert = { ...toColumns("account", qC), user_id: ctx.ownerId, code: qC.code ?? generatedAccountCode(extId), type, normal_balance: normalBalanceFor(type), is_system: false };
  }
  let { data, error } = await ctx.admin.from(ENTITY_META[entity].table).insert(insert).select(COLS[entity]).single();
  if (error && entity === "account" && /duplicate|unique/i.test(error.message)) {
    ({ data, error } = await ctx.admin.from(ENTITY_META[entity].table).insert({ ...insert, code: generatedAccountCode(extId) }).select(COLS[entity]).single());
  }
  if (error || !data) return { error: error?.message ?? "insert failed" };
  return { row: data as unknown as VRow };
}

async function applySimple(ctx: Ctx, entity: SimpleEntity, pulled: PulledRecord): Promise<void> {
  const es = ctx.settings.entities[entity];
  const link = await getLinkByExternal(ctx, entity, pulled.id);
  if (link && pulled.version && link.sync_token === pulled.version && !link.conflict) return; // unchanged since we last applied it
  const raw = pulled.raw ?? (await fetchExt(ctx, entity, pulled.id));
  if (!raw) return;
  if (!ctx.a.isSyncable(entity, raw) || (entity === "customer" && !ctx.a.isCustomerRecord(raw))) return;
  const meta = ctx.a.meta(entity, raw);
  if (!meta.id) return;
  const version = pulled.version || meta.version;
  const who = label(ctx);

  if (link) {
    const vRow = await getVireekRow(ctx, entity, link.vireek_id);
    if (!vRow) {
      warnOnce(ctx, `gone:${link.id}`, { entity, direction: "none", action: "skipped", vireek_id: link.vireek_id, external_id: meta.id, link_id: link.id, message: `Deleted in Vireek: not recreated and not changed in ${who}.` });
      ctx.stats.skipped++;
      return;
    }
    await reconcile(ctx, entity, link, vRow, raw, { version });
    return;
  }

  const qC = ctx.a.toCanon(entity, raw);
  const match = await findVireekMatch(ctx, entity, qC);
  if (match) {
    const out = await reconcile(ctx, entity, null, match, raw, { note: "Matched an existing record", version });
    if (out !== "error") log(ctx, { entity, direction: "both", action: "linked", vireek_id: match.id, external_id: meta.id, message: "Linked to the matching record" });
    return;
  }
  if (!canCreateInVireek(es)) { ctx.stats.skipped++; return; }
  const made = await createVireekRow(ctx, entity, raw, qC, meta.id);
  if (made.skip) {
    ctx.stats.skipped++;
    log(ctx, { entity, direction: "from_ext", action: "skipped", external_id: meta.id, message: made.skip });
    return;
  }
  if (made.error || !made.row) {
    ctx.stats.errors++;
    log(ctx, { entity, direction: "from_ext", action: "error", external_id: meta.id, message: `Could not create in Vireek: ${made.error}` });
    return;
  }
  const merged = mergeEntity({ provider: ctx.provider, entity, settings: es, base: null, vireek: vireekCanon(entity, made.row), ext: qC, vireekTs: null, extTs: null });
  await createLink(ctx, entity, made.row.id, meta.id, { ...merged.next, ...linkExtras(ctx, entity, raw, qC) }, version);
  ctx.stats.created_vireek++;
  log(ctx, { entity, direction: "from_ext", action: "created", vireek_id: made.row.id, external_id: meta.id, message: `Created from ${who}: ${String(qC.name ?? meta.id).slice(0, 80)}` });
}

function vireekChangedSinceBase(ctx: Ctx, entity: SimpleEntity, link: LinkRow, row: VRow, es: AcctSettings["entities"][AcctEntity]): boolean {
  const v = vireekCanon(entity, row);
  const base = link.base ?? {};
  return mergeFieldsFor(ctx.provider, entity, es).some((f) => normalizeValue(f.type, v[f.key]) !== normalizeValue(f.type, base[f.key]));
}

async function createInExt(ctx: Ctx, entity: SimpleEntity, row: VRow): Promise<void> {
  const es = ctx.settings.entities[entity];
  const vC = vireekCanon(entity, row);
  const name = String(vC.name ?? row.id);
  const shown = name.slice(0, 80);
  const who = label(ctx);

  if (entity === "item" && ctx.provider === "netsuite" && !ctx.settings.defaults.incomeAccountId) {
    warnOnce(ctx, "no-income", { entity, direction: "none", action: "skipped", message: "Items were not created in NetSuite: choose a default income account under Mapping → Defaults." });
    ctx.stats.skipped++;
    return;
  }
  if (!name.trim()) { ctx.stats.skipped++; return; }

  // 1. An existing record with the same identity is linked, never duplicated.
  const find = entity === "account" && vC.code ? ctx.a.find(ctx.c, entity, "code", String(vC.code)) : ctx.a.find(ctx.c, entity, "name", name);
  if (find) {
    const r = await api(ctx, find);
    if (ctx.a.classify(r.status, r.json).kind === "ok") {
      for (const hit of ctx.a.parseFind(entity, r.json, entity === "account" && vC.code ? "code" : "name", String(entity === "account" && vC.code ? vC.code : name))) {
        const id = ctx.a.meta(entity, hit).id;
        const full = id ? await fetchExt(ctx, entity, id) : null;
        if (!full || !ctx.a.isSyncable(entity, full) || (await getLinkByExternal(ctx, entity, ctx.a.meta(entity, full).id))) continue;
        const out = await reconcile(ctx, entity, null, row, full, { note: `Matched an existing ${who} record` });
        if (out !== "error") log(ctx, { entity, direction: "both", action: "linked", vireek_id: row.id, external_id: ctx.a.meta(entity, full).id, message: `Linked to existing ${who} record: ${shown}` });
        return;
      }
    }
  }

  // 2. Create.
  const values: Canon = {};
  for (const f of mergeFieldsFor(ctx.provider, entity, es)) if (f.direction !== "from_crm") values[f.key] = vC[f.key] ?? null;
  const accountType = entity === "account" ? ctx.a.suggestAccountType(String(row.type) as never, String(row.code ?? "")) : null;
  const payload = ctx.a.toPayload(entity, values, { defaults: ctx.settings.defaults, accountType, vireekId: row.id }, true);
  const w = await writeExt(ctx, entity, ctx.a.create(ctx.c, entity, payload, rid(`vk-${entity.slice(0, 3)}`, row.id, payload)));
  if (!w.ok) {
    ctx.stats.errors++;
    log(ctx, { entity, direction: "to_ext", action: "error", vireek_id: row.id, message: `Could not create in ${who} (${shown}): ${w.message}`, ref: w.ref });
    return;
  }
  const m = ctx.a.meta(entity, w.record);
  const held = mergeEntity({ provider: ctx.provider, entity, settings: es, base: null, vireek: vC, ext: vC, vireekTs: null, extTs: null }).next;
  await createLink(ctx, entity, row.id, m.id, { ...held, ...linkExtras(ctx, entity, w.record, vC) }, m.version);
  ctx.stats.created_ext++;
  log(ctx, { entity, direction: "to_ext", action: "created", vireek_id: row.id, external_id: m.id, message: `Created in ${who}: ${shown}` });
}

// ============================================================
// GENERIC PULL
// ============================================================

const startPos = (ctx: Ctx) => (ctx.provider === "netsuite" ? 0 : 1);
const advance = (ctx: Ctx, pos: number, n: number) => (ctx.provider === "netsuite" ? pos + n : pos + 1);

async function pullEntity(ctx: Ctx, entity: AcctEntity, apply: (p: PulledRecord) => Promise<"retry" | void>): Promise<boolean> {
  const cur = ctx.cursors[entity]?.pull ?? { since: null, pos: null, passStarted: null };
  const passStarted = cur.passStarted ?? new Date().toISOString();
  const sinceMs = cur.since ? Date.parse(cur.since) - ctx.a.caps.pullOverlapMs : null;
  const since = sinceMs ? new Date(sinceMs).toISOString() : null;
  let pos = cur.pos ?? startPos(ctx);
  let seen = 0;
  let retry: string[] = [];

  for (const id of cur.retry ?? []) {
    if (!isSafeId(id)) continue;
    const raw = await fetchExt(ctx, entity, id);
    if (raw && (await apply({ id, version: "", modifiedAt: null, raw })) === "retry") retry = addRetry(retry, id);
  }
  const save = (state: Omit<PullState, "retry">) => { ctx.cursors[entity] = { ...ctx.cursors[entity], pull: { ...state, retry } }; };

  while (true) {
    if (overDeadline(ctx)) { save({ since: cur.since, pos, passStarted }); return false; }
    const r = await api(ctx, ctx.a.list(ctx.c, entity, since, pos));
    if (ctx.a.classify(r.status, r.json).kind !== "ok") throw new Error(`${label(ctx)} list failed: ${faultText(ctx, r)}`);
    const page = ctx.a.parseList(entity, r.json, pos);
    for (const rec of page.records) {
      if (overDeadline(ctx)) { save({ since: cur.since, pos, passStarted }); return false; }
      if ((await apply(rec)) === "retry") retry = addRetry(retry, rec.id);
    }
    seen += page.records.length;
    pos = advance(ctx, pos, page.records.length);
    await touchRun(ctx);
    if (!page.more || page.records.length === 0) { save({ since: passStarted, pos: null, passStarted: null }); return true; }
    if (seen >= PAGE_CAP_PER_RUN) { save({ since: cur.since, pos, passStarted }); return false; }
  }
}

async function pushSimple(ctx: Ctx, entity: SimpleEntity, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities[entity];
  if (es.direction === "from_ext") return;
  const t = ENTITY_META[entity].table;
  let cur: PushState = ctx.cursors[entity]?.push ?? { ts: null, id: null };

  const handle = async (row: VRow) => {
    const link = await getLinkByVireek(ctx, entity, row.id);
    if (link) {
      if (!vireekChangedSinceBase(ctx, entity, link, row, es) && !link.conflict) return;
      const raw = await fetchExt(ctx, entity, link.external_id);
      if (!raw) {
        warnOnce(ctx, `qgone:${link.id}`, { entity, direction: "none", action: "skipped", vireek_id: row.id, external_id: link.external_id, link_id: link.id, message: `Deleted in ${label(ctx)}: not recreated and not changed in Vireek.` });
        return;
      }
      await reconcile(ctx, entity, link, row, raw);
    } else if (canCreateInExt(es) && pullDoneOnce) {
      await createInExt(ctx, entity, row);
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
    description: String(l.description ?? ""), qty: Number(l.quantity ?? 1), unitPriceCents: Number(l.unit_price_cents ?? 0), amountCents: Number(l.amount_cents ?? 0), itemId: null,
  }));
  return { row: data as VRow, lines };
}
function invoiceVireekCanon(v: VInvoice): Canon {
  const voided = v.row.status === "void";
  return { due_date: v.row.due_date as string, amounts: voided ? null : invoiceAmountSig({ lines: v.lines, taxCents: Number(v.row.tax_cents), totalCents: Number(v.row.total_cents) }), voided: voided ? "void" : "active" };
}
function invoiceExtCanon(d: ExtInvoiceDoc): Canon {
  return { due_date: d.dueDate, amounts: d.voided ? null : invoiceAmountSig(d), voided: d.voided ? "void" : "active" };
}

async function itemMap(ctx: Ctx): Promise<Map<string, string>> {
  if (ctx.itemByName) return ctx.itemByName;
  const map = new Map<string, string>();
  const { data: links } = await ctx.admin.from("acct_record_links").select("vireek_id, external_id").eq("connection_id", ctx.conn.id).eq("entity", "item");
  const ids = (links ?? []) as { vireek_id: string; external_id: string }[];
  if (ids.length) {
    const { data: items } = await ctx.admin.from("price_book_items").select("id, service_name").eq("user_id", ctx.ownerId).in("id", ids.map((l) => l.vireek_id));
    const ext = new Map(ids.map((l) => [l.vireek_id, l.external_id]));
    for (const it of (items ?? []) as { id: string; service_name: string }[]) map.set(normText(it.service_name), ext.get(it.id)!);
  }
  ctx.itemByName = map;
  return map;
}

/** Revenue account (Vireek id) for an inbound line: the item's income account when synced, else the default. */
async function revenueAccountFor(ctx: Ctx, itemId: string | null): Promise<string | null> {
  if (!itemId) return null;
  const il = await getLinkByExternal(ctx, "item", itemId);
  const income = il?.base?.__income;
  if (typeof income !== "string" || !isSafeId(income)) return null;
  const byId = await getLinkByExternal(ctx, "account", income);
  if (byId) return byId.vireek_id;
  const { data } = await ctx.admin.from("acct_record_links").select("vireek_id").eq("connection_id", ctx.conn.id).eq("entity", "account").eq("base->>__code", income).maybeSingle();
  return (data as { vireek_id: string } | null)?.vireek_id ?? null;
}
const linesJson = async (ctx: Ctx, lines: InvoiceLine[]) =>
  Promise.all(lines.map(async (l) => ({ description: l.description, quantity: l.qty, unit_price_cents: l.unitPriceCents, amount_cents: l.amountCents, revenue_account_id: await revenueAccountFor(ctx, l.itemId) })));

const isPaymentsBlock = (msg: string) => /PAYMENTS_EXIST/.test(msg);

function warnTotals(ctx: Ctx, v: VInvoice, rec: RawRecord, ext: string) {
  const p = ctx.a.parseInvoice(rec, ctx.settings.defaults.currency);
  if (!p.ok) return;
  const expected = Number(v.row.total_cents);
  if (p.doc.totalCents !== expected) {
    log(ctx, { entity: "invoice", direction: "to_ext", action: "conflict", vireek_id: v.row.id, external_id: ext, message: `${label(ctx)} total (${p.doc.totalCents / 100}) differs from Vireek (${expected / 100}); it calculates its own sales tax. Check the tax setting under Mapping → Defaults.` });
    ctx.stats.conflicts++;
  }
}

async function reconcileInvoice(
  ctx: Ctx, link: LinkRow | null, v: VInvoice, doc: ExtInvoiceDoc, rawExt: RawRecord | null,
  opts: { ruleOverride?: "vireek_wins" | "ext_wins"; note?: string; version?: string } = {},
): Promise<Outcome> {
  const es = ctx.settings.entities.invoice;
  const who = label(ctx);
  const vC = invoiceVireekCanon(v);
  const qC = invoiceExtCanon(doc);
  const res = mergeEntity({ provider: ctx.provider, entity: "invoice", settings: es, base: stripMeta(link?.base ?? null), vireek: vC, ext: qC, vireekTs: tsOf(v.row), extTs: doc.modifiedAt, ruleOverride: opts.ruleOverride });
  const next: Canon = { ...res.next };
  const blocked: string[] = [];
  const reasons: string[] = [];
  let version = opts.version ?? doc.version;
  let failed = false;
  const id = v.row.id;
  const ext = doc.id;
  const fail = (direction: "to_ext" | "from_ext", message: string, ref?: string | null) => {
    failed = true; ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction, action: "error", vireek_id: id, external_id: ext, link_id: link?.id, message, ref });
  };
  const block = (field: string, reason: string) => { blocked.push(field); reasons.push(reason); };

  // ---- void ----
  if (res.toVireek.voided === "void") {
    const { error } = await ctx.admin.rpc("qbo_void_ar_invoice", { p_owner: ctx.ownerId, p_invoice_id: id });
    if (error) {
      if (isPaymentsBlock(error.message)) block("voided", `Voided in ${who}, but Vireek has payments on this invoice. Void or refund the payments in Vireek first.`);
      else fail("from_ext", `Could not void in Vireek: ${error.message}`);
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity: "invoice", direction: "from_ext", action: "voided", vireek_id: id, external_id: ext, link_id: link?.id, message: `Voided to match ${who}` });
    }
  }
  if (res.toCrm.voided === "void") {
    const req = ctx.a.voidInvoice(ctx.c, ext, doc.version || null);
    if (!req) block("voided", `${who} cannot void an invoice through its API. Void it in ${who}, then it will follow here.`);
    else {
      const r = await api(ctx, req);
      if (ctx.a.classify(r.status, r.json).kind === "ok") {
        ctx.stats.updated_ext++;
        log(ctx, { entity: "invoice", direction: "to_ext", action: "voided", vireek_id: id, external_id: ext, link_id: link?.id, message: `Voided to match Vireek` });
      } else fail("to_ext", `${who} could not void the invoice: ${faultText(ctx, r)}`, r.ref);
    }
  }
  const voidedNow = vC.voided === "void" || qC.voided === "void" || res.toVireek.voided === "void" || res.toCrm.voided === "void";

  // ---- amounts (never when a void is involved) ----
  if (!voidedNow && typeof res.toVireek.amounts === "string") {
    const { error } = await ctx.admin.rpc("qbo_replace_ar_invoice", { p_owner: ctx.ownerId, p_invoice_id: id, p_issue_date: doc.txnDate, p_due_date: doc.dueDate, p_tax_cents: doc.taxCents, p_lines: await linesJson(ctx, doc.lines) });
    if (error) {
      if (isPaymentsBlock(error.message)) block("amounts", `Amounts changed in ${who} after a payment was recorded in Vireek. Review it, then choose which side to keep.`);
      else fail("from_ext", `Could not apply ${who} amounts: ${error.message}`);
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity: "invoice", direction: "from_ext", action: "updated", vireek_id: id, external_id: ext, link_id: link?.id, message: `Line items and totals updated from ${who}` });
    }
  }
  const pushAmounts = !voidedNow && typeof res.toCrm.amounts === "string";
  const pushDue = !voidedNow && res.toCrm.due_date !== undefined;
  if (pushAmounts || pushDue) {
    const customer = v.row.customer_id ? await getLinkByVireek(ctx, "customer", String(v.row.customer_id)) : null;
    const resolved = resolveLineItems(v.lines, await itemMap(ctx), ctx.settings.defaults.fallbackItemId, ctx.a.caps.lineNeedsItem);
    if (!customer) block("amounts", `The customer is not linked to ${who} yet.`);
    else if (!resolved.ok) block("amounts", resolved.reason);
    else {
      const live = rawExt ?? (await fetchExt(ctx, "invoice", ext));
      const payload = ctx.a.buildInvoice(
        { invoiceNumber: String(v.row.invoice_number), issueDate: String(v.row.issue_date), dueDate: String(v.row.due_date), taxCents: Number(v.row.tax_cents), lines: resolved.lines },
        customer.external_id, { defaults: ctx.settings.defaults }, { id: ext, version: doc.version, raw: live },
      );
      const w = await writeExt(ctx, "invoice", ctx.a.update(ctx.c, "invoice", ext, payload, doc.version || null), ext);
      if (w.ok) {
        version = ctx.a.meta("invoice", w.record).version;
        ctx.stats.updated_ext++;
        log(ctx, { entity: "invoice", direction: "to_ext", action: "updated", vireek_id: id, external_id: ext, link_id: link?.id, message: `Invoice updated in ${who}` });
        warnTotals(ctx, v, w.record, ext);
      } else {
        if (pushAmounts) block("amounts", `${who} rejected the update: ${w.message}`);
        fail("to_ext", `${who} rejected the invoice update: ${w.message}`, w.ref);
      }
    }
  }

  // ---- due date (no ledger impact) ----
  if (res.toVireek.due_date !== undefined && res.toVireek.due_date !== null) {
    const { error } = await ctx.admin.from("ar_invoices").update({ due_date: res.toVireek.due_date }).eq("id", id).eq("user_id", ctx.ownerId);
    if (error) fail("from_ext", `Could not update the due date: ${error.message}`);
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
  const token = failed ? null : version;
  if (link) await saveLink(ctx, link, { base: next, sync_token: token, conflict });
  else await createLink(ctx, "invoice", id, ext, next, token);
  return failed ? "error" : conflict ? "conflict" : "ok";
}

async function applyExtInvoice(ctx: Ctx, pulled: PulledRecord): Promise<"retry" | void> {
  const es = ctx.settings.entities.invoice;
  const who = label(ctx);
  const existingLink = await getLinkByExternal(ctx, "invoice", pulled.id);
  if (existingLink && pulled.version && existingLink.sync_token === pulled.version && !existingLink.conflict) return;
  const raw = pulled.raw ?? (await fetchExt(ctx, "invoice", pulled.id));
  if (!raw) return;
  const parsed = ctx.a.parseInvoice(raw, ctx.settings.defaults.currency);
  if (!parsed.ok) {
    if (!parsed.silent) {
      ctx.stats.skipped++;
      warnOnce(ctx, `inv:${pulled.id}:${pulled.version}`, { entity: "invoice", direction: "from_ext", action: "skipped", external_id: pulled.id, message: `Invoice ${pulled.id} skipped: ${parsed.reason}` });
    }
    return;
  }
  const doc = parsed.doc;
  const version = pulled.version || doc.version;
  const link = existingLink;
  if (link) {
    const v = await loadInvoice(ctx, link.vireek_id);
    if (!v) { ctx.stats.skipped++; return; }
    await reconcileInvoice(ctx, link, v, doc, raw, { version });
    return;
  }
  if (doc.voided) return;

  if (doc.docNumber) {
    const { data } = await ctx.admin.from("ar_invoices").select("id").eq("user_id", ctx.ownerId).eq("invoice_number", doc.docNumber).eq("total_cents", doc.totalCents).maybeSingle();
    if (data && !(await getLinkByVireek(ctx, "invoice", (data as unknown as VRow).id))) {
      const v = await loadInvoice(ctx, (data as unknown as VRow).id);
      if (v) {
        await reconcileInvoice(ctx, null, v, doc, raw, { note: "Matched an existing invoice", version });
        log(ctx, { entity: "invoice", direction: "both", action: "linked", vireek_id: v.row.id, external_id: doc.id, message: `Linked to existing invoice ${doc.docNumber}` });
        return;
      }
    }
  }
  if (!canCreateInVireek(es)) { ctx.stats.skipped++; return; }
  const cust = doc.customerId ? await getLinkByExternal(ctx, "customer", doc.customerId) : null;
  if (!cust) {
    warnOnce(ctx, `invcust:${doc.id}`, { entity: "invoice", direction: "from_ext", action: "skipped", external_id: doc.id, message: `Invoice ${doc.docNumber ?? doc.id} waits for its customer to sync (enable Customers, then Sync now).` });
    return "retry";
  }
  if (doc.totalCents <= 0) { ctx.stats.skipped++; return; }
  const { data: newId, error } = await ctx.admin.rpc("qbo_create_ar_invoice", {
    p_owner: ctx.ownerId, p_customer_id: cust.vireek_id, p_issue_date: doc.txnDate, p_due_date: doc.dueDate, p_tax_cents: doc.taxCents, p_lines: await linesJson(ctx, doc.lines), p_invoice_number: doc.docNumber,
  });
  if (error || !newId) {
    ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction: "from_ext", action: "error", external_id: doc.id, message: `Could not create invoice ${doc.docNumber ?? doc.id}: ${error?.message ?? "no id"}` });
    return;
  }
  const v = await loadInvoice(ctx, newId as string);
  await createLink(ctx, "invoice", newId as string, doc.id, v ? invoiceVireekCanon(v) : invoiceExtCanon(doc), version);
  ctx.stats.created_vireek++;
  log(ctx, { entity: "invoice", direction: "from_ext", action: "created", vireek_id: newId as string, external_id: doc.id, message: `Created invoice ${doc.docNumber ?? doc.id} from ${who}` });
}

const PUSHABLE = new Set(["sent", "partially_paid", "paid", "overdue"]);

async function createInvoiceInExt(ctx: Ctx, v: VInvoice): Promise<"retry" | void> {
  if (!PUSHABLE.has(String(v.row.status))) return;
  const who = label(ctx);
  const number = String(v.row.invoice_number);
  const customer = v.row.customer_id ? await getLinkByVireek(ctx, "customer", String(v.row.customer_id)) : null;
  if (!customer) {
    warnOnce(ctx, `vinvcust:${v.row.id}`, { entity: "invoice", direction: "to_ext", action: "skipped", vireek_id: v.row.id, message: `Invoice ${number} waits for its customer to be linked to ${who}.` });
    return "retry";
  }
  const resolved = resolveLineItems(v.lines, await itemMap(ctx), ctx.settings.defaults.fallbackItemId, ctx.a.caps.lineNeedsItem);
  if (!resolved.ok) {
    warnOnce(ctx, `vinvitem:${number}`, { entity: "invoice", direction: "to_ext", action: "skipped", vireek_id: v.row.id, message: `Invoice ${number} not sent: ${resolved.reason}` });
    return "retry";
  }
  if (ctx.settings.defaults.sendDocNumber) {
    const find = ctx.a.find(ctx.c, "invoice", "number", number);
    if (find) {
      const fr = await api(ctx, find);
      if (ctx.a.classify(fr.status, fr.json).kind === "ok") {
        for (const hit of ctx.a.parseFind("invoice", fr.json, "number", number)) {
          const hid = ctx.a.meta("invoice", hit).id;
          const full = hid ? await fetchExt(ctx, "invoice", hid) : null;
          const p = full ? ctx.a.parseInvoice(full, ctx.settings.defaults.currency) : null;
          if (full && p && p.ok && p.doc.totalCents === Number(v.row.total_cents) && !(await getLinkByExternal(ctx, "invoice", p.doc.id))) {
            await reconcileInvoice(ctx, null, v, p.doc, full, { note: `Matched an existing ${who} invoice` });
            log(ctx, { entity: "invoice", direction: "both", action: "linked", vireek_id: v.row.id, external_id: p.doc.id, message: `Linked to existing ${who} invoice ${number}` });
            return;
          }
        }
      }
    }
  }
  const payload = ctx.a.buildInvoice(
    { invoiceNumber: number, issueDate: String(v.row.issue_date), dueDate: String(v.row.due_date), taxCents: Number(v.row.tax_cents), lines: resolved.lines },
    customer.external_id, { defaults: ctx.settings.defaults },
  );
  let w = await writeExt(ctx, "invoice", ctx.a.create(ctx.c, "invoice", payload, rid("vk-inv", String(v.row.id), payload)));
  if (w.ok && ctx.a.caps.markSentAfterCreate) {
    const mk = ctx.a.markSent(ctx.c, w.id);
    if (mk) {
      const mr = await api(ctx, mk);
      if (ctx.a.classify(mr.status, mr.json).kind !== "ok") log(ctx, { entity: "invoice", direction: "to_ext", action: "error", vireek_id: String(v.row.id), external_id: w.id, message: `Created, but ${who} could not mark the invoice as sent: ${faultText(ctx, mr)}`, ref: mr.ref });
      else { const again = await fetchExt(ctx, "invoice", w.id); if (again) w = { ...w, record: again }; }
    }
  }
  if (!w.ok) {
    ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction: "to_ext", action: "error", vireek_id: String(v.row.id), message: `Could not create invoice ${number} in ${who}: ${w.message}`, ref: w.ref });
    return;
  }
  const m = ctx.a.meta("invoice", w.record);
  await createLink(ctx, "invoice", String(v.row.id), m.id, invoiceVireekCanon(v), m.version);
  ctx.stats.created_ext++;
  log(ctx, { entity: "invoice", direction: "to_ext", action: "created", vireek_id: String(v.row.id), external_id: m.id, message: `Created invoice ${number} in ${who}` });
  warnTotals(ctx, v, w.record, m.id);
}

async function pushInvoices(ctx: Ctx, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities.invoice;
  if (es.direction === "from_ext") return;
  let cur: PushState = ctx.cursors.invoice?.push ?? { ts: null, id: null };

  const handle = async (id: string): Promise<"retry" | void> => {
    const v = await loadInvoice(ctx, id);
    if (!v) return;
    const link = await getLinkByVireek(ctx, "invoice", id);
    if (link) {
      const vC = invoiceVireekCanon(v);
      const changed = (["due_date", "amounts", "voided"] as const).some((k) => {
        const type = fieldsFor(ctx.provider, "invoice").find((f) => f.key === k)?.type ?? "text";
        return normalizeValue(type, vC[k]) !== normalizeValue(type, link.base?.[k]);
      });
      if (!changed && !link.conflict) return;
      const raw = await fetchExt(ctx, "invoice", link.external_id);
      const p = raw ? ctx.a.parseInvoice(raw, ctx.settings.defaults.currency) : null;
      if (!raw || !p || !p.ok) {
        if (p && !p.ok && !p.silent) warnOnce(ctx, `inv:${link.external_id}`, { entity: "invoice", direction: "none", action: "skipped", vireek_id: id, external_id: link.external_id, link_id: link.id, message: `${label(ctx)} invoice cannot be compared: ${p.reason}` });
        return;
      }
      await reconcileInvoice(ctx, link, v, p.doc, raw);
      return;
    }
    if (canCreateInExt(es) && pullDoneOnce) return createInvoiceInExt(ctx, v);
  };

  const stillRetry: string[] = [];
  for (const id of [...(ctx.cursors.invoice?.push?.retry ?? [])]) if ((await handle(id)) === "retry") stillRetry.push(id);
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

async function applyExtPayment(ctx: Ctx, pulled: PulledRecord): Promise<"retry" | void> {
  const es = ctx.settings.entities.payment;
  const who = label(ctx);
  const raw = pulled.raw ?? (await fetchExt(ctx, "payment", pulled.id));
  const doc = raw ? ctx.a.parsePayment(raw) : null;
  if (!doc) return;
  if (doc.voided) {
    warnOnce(ctx, `pv:${doc.id}`, { entity: "payment", direction: "from_ext", action: "skipped", external_id: doc.id, message: `Payment voided in ${who}. Payments are never reversed automatically: void it in Vireek if needed.` });
    return;
  }
  if (!canCreateInVireek(es)) return;
  let retry = false;
  for (const app of doc.applications) {
    const key = paymentLinkKey(doc.id, app.invoiceId);
    if (await getLinkByExternal(ctx, "payment", key)) continue;
    const invLink = await getLinkByExternal(ctx, "invoice", app.invoiceId);
    if (!invLink) {
      warnOnce(ctx, `pi:${key}`, { entity: "payment", direction: "from_ext", action: "skipped", external_id: key, message: `Payment ${doc.id} waits for its invoice to sync.` });
      retry = true;
      continue;
    }
    const inv = await loadInvoice(ctx, invLink.vireek_id);
    if (!inv || inv.row.status === "void") continue;
    const remaining = Number(inv.row.total_cents) - Number(inv.row.amount_paid_cents);
    if (app.amountCents > remaining) {
      ctx.stats.errors++;
      log(ctx, { entity: "payment", direction: "from_ext", action: "error", external_id: key, vireek_id: inv.row.id, message: `Payment of ${app.amountCents / 100} exceeds the Vireek balance of ${remaining / 100}. Not recorded.` });
      continue;
    }
    const dep = doc.depositAccountId ? await getLinkByExternal(ctx, "account", doc.depositAccountId) : null;
    const { data: payId, error } = await ctx.admin.rpc("qbo_record_ar_payment", {
      p_owner: ctx.ownerId, p_invoice_id: inv.row.id, p_amount_cents: app.amountCents, p_method: paymentMethodFromName(doc.methodName), p_date: doc.txnDate, p_deposit_account_id: dep?.vireek_id ?? null,
    });
    if (error || !payId) {
      ctx.stats.errors++;
      log(ctx, { entity: "payment", direction: "from_ext", action: "error", external_id: key, vireek_id: inv.row.id, message: `Could not record the payment: ${error?.message ?? "no id"}` });
      continue;
    }
    await createLink(ctx, "payment", payId as string, key, {}, null);
    ctx.stats.created_vireek++;
    log(ctx, { entity: "payment", direction: "from_ext", action: "created", vireek_id: payId as string, external_id: key, message: `Recorded payment of ${app.amountCents / 100} from ${who}` });
  }
  return retry ? "retry" : undefined;
}

async function pushPayments(ctx: Ctx, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities.payment;
  if (!canCreateInExt(es) || !pullDoneOnce) return;
  const who = label(ctx);
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
      warnOnce(ctx, `vp:${p.id}`, { entity: "payment", direction: "to_ext", action: "skipped", vireek_id: p.id, message: `Payment on invoice ${String(invRow.invoice_number)} waits for the invoice and customer to be linked to ${who}.` });
      return "retry";
    }
    const dep = p.deposit_account_id ? await getLinkByVireek(ctx, "account", String(p.deposit_account_id)) : null;
    const depositId = dep?.external_id ?? ctx.settings.defaults.depositAccountId;
    if (!depositId) {
      warnOnce(ctx, "no-deposit", { entity: "payment", direction: "none", action: "skipped", message: `Payments were not sent to ${who}: choose a deposit account under Mapping → Defaults.` });
      return "retry";
    }
    const input = { customerId: custLink.external_id, invoiceId: invLink.external_id, amountCents: Number(p.amount_cents), date: String(p.payment_date), depositAccountId: depositId, method: paymentMethodFromName(String(p.payment_method)), note: `Vireek payment ${p.id} (${String(p.payment_method)})` };
    const req = ctx.a.createPayment(ctx.c, input, rid("vk-pay", p.id));
    const w = await writeExt(ctx, "payment", req);
    if (!w.ok) {
      ctx.stats.errors++;
      log(ctx, { entity: "payment", direction: "to_ext", action: "error", vireek_id: p.id, message: `Could not create the payment in ${who}: ${w.message}`, ref: w.ref });
      return;
    }
    await createLink(ctx, "payment", p.id, paymentLinkKey(w.id, invLink.external_id), {}, null);
    ctx.stats.created_ext++;
    log(ctx, { entity: "payment", direction: "to_ext", action: "created", vireek_id: p.id, external_id: paymentLinkKey(w.id, invLink.external_id), message: `Sent payment of ${Number(p.amount_cents) / 100} to ${who}` });
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
// RUN LIFECYCLE
// ============================================================

async function acquireLock(admin: AnyClient, connId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await admin.from("acct_connections").update({ sync_locked_until: new Date(Date.now() + LOCK_MS).toISOString() }).eq("id", connId).or(`sync_locked_until.is.null,sync_locked_until.lt.${now}`).select("id");
  return (data?.length ?? 0) > 0;
}

function connInfo(conn: ConnRow): ConnInfo {
  return { provider: conn.provider, tenantId: conn.tenant_id, region: conn.region && isZohoRegion(conn.region) ? conn.region : null, config: conn.config ?? {} };
}

async function buildCtx(admin: AnyClient, conn: ConnRow, runId: string | null, deadline: number): Promise<Ctx> {
  const key = encKey();
  const { data: sec } = await admin.from("acct_connection_secrets").select("access_token_enc, refresh_token_enc, expires_at").eq("connection_id", conn.id).maybeSingle();
  if (!sec || !key) throw new AuthError("No stored credentials. Please reconnect.");
  const valid = validateSettings(conn.provider, conn.settings && Object.keys(conn.settings as object).length ? conn.settings : defaultSettings(conn.provider));
  if (!valid.ok) throw new Error(`Saved settings are invalid: ${valid.error}`);
  const p = PROVIDERS[conn.provider];
  const ctx: Ctx = {
    admin, conn, ownerId: conn.user_id, provider: conn.provider, p, a: p.adapter, c: connInfo(conn), settings: valid.settings, cursors: { ...(conn.cursors ?? {}) },
    runId, stats: emptyStats(), logs: [], deadline,
    access: await decryptSecret(sec.access_token_enc as string, key),
    refresh: sec.refresh_token_enc ? await decryptSecret(sec.refresh_token_enc as string, key) : null,
    lastProgressAt: 0, lastCallAt: 0, warned: new Set(),
  };
  const exp = sec.expires_at ? Date.parse(sec.expires_at as string) : null;
  if (exp !== null && exp - Date.now() < 120_000) await refreshAccess(ctx);
  return ctx;
}

async function mirrorIntegration(admin: AnyClient, conn: ConnRow, status: "connected" | "error" | "disconnected", extra: Record<string, unknown> = {}) {
  const { data: c } = await admin.from("acct_connections").select("company_name, tenant_id").eq("id", conn.id).maybeSingle();
  await admin.from("integrations").upsert(
    { user_id: conn.user_id, integration_type: conn.provider, status, config: { tenant_id: c?.tenant_id ?? conn.tenant_id, company_name: c?.company_name ?? null, ...extra } },
    { onConflict: "user_id,integration_type" },
  );
}

async function executeRun(admin: AnyClient, conn: ConnRow, runId: string) {
  let ctx: Ctx | null = null;
  let status: "success" | "partial" | "failed" = "success";
  let error: string | null = null;
  let markError = false;
  let allFinished = true;
  const who = PROVIDERS[conn.provider] ? conn.provider : "provider";

  try {
    await admin.from("acct_sync_log").delete().eq("connection_id", conn.id).lt("created_at", new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString());
    ctx = await buildCtx(admin, conn, runId, Date.now() + RUN_BUDGET_MS);
    let dependenciesDone = true;
    for (const entity of ACCT_ENTITIES) {
      const es = ctx.settings.entities[entity];
      if (!es.enabled) continue;
      if (overDeadline(ctx)) { allFinished = false; break; }
      if ((entity === "invoice" || entity === "payment") && !dependenciesDone) { allFinished = false; continue; }
      const c = ctx;
      const apply = entity === "invoice" ? (r: PulledRecord) => applyExtInvoice(c, r) : entity === "payment" ? (r: PulledRecord) => applyExtPayment(c, r) : async (r: PulledRecord) => { await applySimple(c, entity as SimpleEntity, r); };
      const finished = es.direction === "to_ext" ? true : await pullEntity(ctx, entity, apply);
      if (!finished) {
        allFinished = false;
        if (entity !== "invoice" && entity !== "payment") dependenciesDone = false;
      }
      const pullDoneOnce = es.direction === "to_ext" || !!ctx.cursors[entity]?.pull?.since;
      if (entity === "invoice") await pushInvoices(ctx, pullDoneOnce);
      else if (entity === "payment") await pushPayments(ctx, pullDoneOnce);
      else await pushSimple(ctx, entity as SimpleEntity, pullDoneOnce);
    }
    if (!allFinished || overDeadline(ctx)) { status = "partial"; error = "Large sync in progress. It will continue automatically on the next run."; }
    if (ctx.stats.errors > 0 && status === "success") status = "partial";
  } catch (err) {
    status = "failed";
    const name = ctx ? label(ctx) : who;
    if (err instanceof AuthError) { markError = true; error = `${name} needs to be re-authorised. Disconnect and connect again.`; }
    else if (err instanceof RateLimitError) { status = "partial"; error = `${name} is rate limiting requests. The sync will retry on the next run.`; }
    else { error = err instanceof Error ? err.message.slice(0, 400) : "Unexpected sync error."; console.error("acct-sync-run failed", conn.id, err); }
  } finally {
    if (ctx) {
      await flushLogs(ctx);
      if (ctx.runId) await admin.from("acct_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
    }
    await admin.from("acct_sync_runs").update({ status, error, finished_at: new Date().toISOString(), ...(ctx ? { stats: ctx.stats } : {}) }).eq("id", runId);
    await admin.from("acct_connections").update({
      sync_locked_until: null,
      ...(ctx ? { cursors: ctx.cursors } : {}),
      ...(status !== "failed" || !markError ? {} : { status: "error" }),
      ...(status === "failed" ? { last_error: error } : { last_error: status === "partial" ? error : null, last_synced_at: new Date().toISOString() }),
    }).eq("id", conn.id);
    if (markError) await mirrorIntegration(admin, conn, "error", { error_code: "token_revoked", error_message: error, failed_at: new Date().toISOString() });
    else if (status !== "failed") await mirrorIntegration(admin, conn, "connected", { last_synced_at: new Date().toISOString() });
  }
}

async function beginRun(admin: AnyClient, conn: ConnRow, trigger: "manual" | "scheduled" | "webhook"): Promise<string | null> {
  if (!(await acquireLock(admin, conn.id))) return null;
  await admin.from("acct_sync_runs").update({ status: "failed", error: "Interrupted.", finished_at: new Date().toISOString() }).eq("connection_id", conn.id).eq("status", "running").lt("started_at", new Date(Date.now() - 10 * 60_000).toISOString());
  const { data } = await admin.from("acct_sync_runs").insert({ user_id: conn.user_id, connection_id: conn.id, provider: conn.provider, trigger, status: "running" }).select("id").single();
  if (!data) {
    await admin.from("acct_connections").update({ sync_locked_until: null }).eq("id", conn.id);
    return null;
  }
  return data.id as string;
}

const background = (p: Promise<unknown>) => {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(p);
  else void p;
};

const CONN_COLS = "id, user_id, provider, tenant_id, region, config, status, settings, cursors";

/** Live lists for the mapping UI (accounts / items / tax codes / subsidiaries). Names only; never cached or stored. */
async function listOptions(ctx: Ctx) {
  const out: Record<string, OptionRow[]> = { accounts: [], items: [], taxCodes: [], subsidiaries: [] };
  for (const spec of ctx.a.options(ctx.c)) {
    try {
      const r = await api(ctx, spec.req);
      if (ctx.a.classify(r.status, r.json).kind === "ok") out[spec.key] = spec.parse(r.json);
    } catch (err) {
      if (err instanceof AuthError) throw err;
    }
  }
  return out;
}

/** Best effort: tell the provider to forget us, so the app disappears from the organisation's connected apps. */
async function revokeAtProvider(admin: AnyClient, conn: ConnRow) {
  try {
    const key = encKey();
    const { data: sec } = await admin.from("acct_connection_secrets").select("access_token_enc, refresh_token_enc").eq("connection_id", conn.id).maybeSingle();
    if (!sec || !key) return;
    const access = await decryptSecret(sec.access_token_enc as string, key);
    const refresh = sec.refresh_token_enc ? await decryptSecret(sec.refresh_token_enc as string, key) : null;
    const p = PROVIDERS[conn.provider];
    if (conn.provider === "xero") {
      const cid = String((conn.config ?? {}).connection_id ?? "");
      if (/^[0-9a-f-]{36}$/i.test(cid)) await fetch(`${XERO_CONNECTIONS_URL}/${cid}`, { method: "DELETE", headers: { Authorization: `Bearer ${access}` } });
      if (refresh) {
        const t = await p.auth.tokenRequest("refresh", { clientId: envOf(p, "CLIENT_ID"), clientSecret: envOf(p, "CLIENT_SECRET") });
        await fetch(XERO_REVOKE_URL, { method: "POST", headers: t.headers, body: new URLSearchParams({ token: refresh, token_type_hint: "refresh_token" }).toString() });
      }
    } else if (conn.provider === "zoho_books" && refresh && conn.region) {
      await fetch(zohoRevokeUrl(conn.region, refresh), { method: "POST" });
    }
  } catch (err) {
    console.error("acct revoke failed", conn.provider, err instanceof Error ? err.message : err);
  }
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
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  // ---- scheduled sync + webhook ------------------------------------------
  if (body.action === "cron" || body.action === "webhook") {
    const secret = Deno.env.get("CRON_SECRET");
    if (!secret || req.headers.get("X-Cron-Secret") !== secret) return json({ error: "Forbidden" }, 403);
    let q = admin.from("acct_connections").select(CONN_COLS).eq("status", "connected");
    let trigger: "scheduled" | "webhook" = "scheduled";
    if (body.action === "webhook") {
      const tenants = Array.isArray(body.tenant_ids) ? (body.tenant_ids as unknown[]).filter((t): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{3,64}$/.test(t)) : [];
      if (!isProvider(body.provider) || !tenants.length) return json({ queued: 0 }, 202);
      q = q.eq("provider", body.provider).in("tenant_id", tenants);
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
  const { data: allowed } = await caller.rpc("can_manage_accounting");
  if (allowed !== true) return json({ error: "You don't have permission to manage accounting sync." }, 403);

  const loadConn = async (id: unknown): Promise<ConnRow | null> => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data } = await admin.from("acct_connections").select(CONN_COLS).eq("id", id).eq("user_id", ownerId).maybeSingle();
    return (data as ConnRow | null) ?? null;
  };

  if (body.action === "run" || body.action === "resync") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    if (conn.status === "disconnected") return json({ error: "This connection is disconnected." }, 409);
    const runId = await beginRun(admin, conn, "manual");
    if (!runId) return json({ error: "A sync is already running." }, 409);
    if (body.action === "resync") {
      // Full re-read: forget the change markers and cursors. Merge is idempotent, so this only repairs.
      await admin.from("acct_record_links").update({ sync_token: null }).eq("connection_id", conn.id);
      await admin.from("acct_connections").update({ cursors: {} }).eq("id", conn.id);
      conn.cursors = {};
    }
    background(executeRun(admin, conn, runId));
    return json({ run_id: runId }, 202);
  }

  if (body.action === "save_settings") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    const v = validateSettings(conn.provider, body.settings);
    if (!v.ok) return json({ error: v.error }, 400);
    // A changed field mapping must re-read that entity so the new fields get their first merge.
    const cursors = { ...(conn.cursors ?? {}) };
    const old = validateSettings(conn.provider, conn.settings && Object.keys(conn.settings as object).length ? conn.settings : defaultSettings(conn.provider));
    for (const e of ACCT_ENTITIES) {
      const sig = (s: AcctSettings) => JSON.stringify([s.entities[e].enabled, s.entities[e].direction, s.entities[e].fields]);
      if (!old.ok || sig(old.settings) !== sig(v.settings)) delete cursors[e];
    }
    const update: Record<string, unknown> = { settings: v.settings, cursors };
    if (typeof body.auto_sync === "boolean") update.auto_sync = body.auto_sync;
    const { error } = await admin.from("acct_connections").update(update).eq("id", conn.id);
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
      return json({ error: err instanceof AuthError ? "Reconnect and try again." : "Could not load the lists from your accounting system." }, 502);
    }
  }

  if (body.action === "disconnect") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    await revokeAtProvider(admin, conn);
    await admin.from("acct_connection_secrets").delete().eq("connection_id", conn.id);
    await admin.from("acct_record_links").delete().eq("connection_id", conn.id);
    await admin.from("acct_connections").update({ status: "disconnected", cursors: {}, last_error: null, sync_locked_until: null }).eq("id", conn.id);
    await mirrorIntegration(admin, conn, "disconnected", { error_code: "manual_disconnect" });
    return json({ ok: true });
  }

  if (body.action === "resolve_conflict") {
    const winner = body.winner === "vireek" || body.winner === "ext" ? body.winner : null;
    if (!winner || typeof body.link_id !== "string") return json({ error: "Invalid request." }, 400);
    const { data: link } = await admin.from("acct_record_links").select(`${LINK_COLS}, connection_id`).eq("id", body.link_id).eq("user_id", ownerId).maybeSingle();
    if (!link) return json({ error: "Conflict not found." }, 404);
    const conn = await loadConn((link as { connection_id: string }).connection_id);
    if (!conn || conn.status !== "connected") return json({ error: "This connection is not active." }, 409);
    if (!(await acquireLock(admin, conn.id))) return json({ error: "A sync is running. Try again in a moment." }, 409);
    let ctx: Ctx | null = null;
    try {
      ctx = await buildCtx(admin, conn, null, Date.now() + 60_000);
      const l = link as unknown as LinkRow;
      const ruleOverride = winner === "vireek" ? "vireek_wins" : "ext_wins";
      const note = `Conflict resolved (kept ${winner === "vireek" ? "Vireek" : label(ctx)})`;
      if (l.entity === "payment") return json({ error: "Payments are never edited. Void the payment in Vireek if it is wrong." }, 400);
      const raw = await fetchExt(ctx, l.entity, l.external_id);
      let result: Outcome;
      if (l.entity === "invoice") {
        const v = await loadInvoice(ctx, l.vireek_id);
        const p = raw ? ctx.a.parseInvoice(raw, ctx.settings.defaults.currency) : null;
        if (!v || !raw || !p || !p.ok) return json({ error: "One of the two records no longer exists or cannot be compared." }, 410);
        result = await reconcileInvoice(ctx, l, v, p.doc, raw, { ruleOverride, note });
      } else {
        const vRow = await getVireekRow(ctx, l.entity as SimpleEntity, l.vireek_id);
        if (!vRow || !raw) return json({ error: "One of the two records no longer exists." }, 410);
        result = await reconcile(ctx, l.entity as SimpleEntity, l, vRow, raw, { ruleOverride, note });
      }
      await flushLogs(ctx);
      return result === "error" ? json({ error: "Could not apply that choice. See the sync log." }, 502) : json({ ok: true });
    } catch (err) {
      console.error("acct resolve_conflict failed", err);
      return json({ error: err instanceof AuthError ? "Reconnect and try again." : "Could not resolve this conflict." }, 502);
    } finally {
      await admin.from("acct_connections").update({ sync_locked_until: null }).eq("id", conn.id);
      if (ctx) await flushLogs(ctx);
    }
  }

  return json({ error: "Unknown action." }, 400);
});
