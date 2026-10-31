// supabase/functions/ns-sync-run/index.ts
//
// Sync of customers, service items, invoices and payments with NetSuite (SuiteTalk REST, token auth).
// NOT LIVE-VERIFIED: follows the NetSuite REST docs and is covered by mock tests only.
//
// Actions (POST JSON):
//   { action: "run",              connection_id }                       -> 202 { run_id }   manual "Sync now"
//   { action: "resync",           connection_id }                       -> 202 { run_id }   re-read everything (merge is idempotent)
//   { action: "save_settings",    connection_id, settings, auto_sync? } -> { ok, settings }
//   { action: "options",          connection_id }                       -> { accounts, items, taxCodes, subsidiaries } live from NetSuite
//   { action: "disconnect",       connection_id }                       -> { ok }
//   { action: "resolve_conflict", link_id, winner: "vireek"|"ns" }      -> { ok }
//   { action: "cron" }    + header X-Cron-Secret                        -> 202   scheduled sync of all due connections
//
// REQUIRED SECRETS: NS_TOKEN_ENCRYPTION_KEY (falls back to QBO_TOKEN_ENCRYPTION_KEY), CRON_SECRET.
// Schedule with the pg_cron snippet at the bottom of supabase/migrations/20280115000000_netsuite_sync.sql.
// Deploy: supabase functions deploy ns-sync-run --no-verify-jwt
//   (pg_cron calls it with X-Cron-Secret and no JWT; every user action verifies the JWT in code.)
//
// HOW A RUN WORKS (order: customers, items, invoices, payments; each: PULL then PUSH)
//   1. PULL changed NetSuite records (SuiteQL id list + GET each record) and reconcile each one.
//   2. PUSH changed Vireek records and reconcile each one against the live NetSuite record.
//   `reconcile` is a field-level THREE-WAY merge against the base snapshot stored on the link, so only
//   fields that changed since the last sync move and our own writes never echo back.
//
// IDEMPOTENCY
//   - Every record Vireek creates in NetSuite is written with a deterministic externalId (vk-c-/vk-t-/vk-i-/vk-p-<uuid>)
//     through PUT .../eid:<externalId>, and looked up by that id first: a replayed write never duplicates.
//   - Links are unique per (connection, entity, netsuite id) and per (connection, entity, vireek id).
//   - Re-running a sync with nothing changed performs reads only.
//
// SAFETY
//   - Tenant scope: ownerId comes from get_account_owner_id() (or the connection row for cron) and is
//     applied to every query on top of the service-role client.
//   - Records are only CREATED on the other side after the first full pull of that entity finished.
//   - Money documents go through the general-ledger functions (balanced, period-locked). An invoice with
//     payments is never re-itemised or voided automatically: it becomes a conflict for a human to resolve.
//   - Deletes are never propagated in either direction. Payments are create-only.
//   - NetSuite cannot void an invoice over REST: a Vireek void becomes a conflict explaining what to do.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { NsAuthError, NsClient, NsFaultError, NsRateLimitError } from "../_shared/netsuite/client.ts";
import {
  ENTITY_META,
  NS_CANNOT_VOID_REASON,
  NS_ENTITIES,
  NS_SUITEQL_PAGE,
  PAGE_CAP_PER_RUN,
  PULL_OVERLAP_MS,
  addressFromDefault,
  buildNsInvoiceCreate,
  buildNsInvoicePatch,
  buildNsPaymentCreate,
  canCreateInNs,
  canCreateInVireek,
  canonToNs,
  changedIdsQuery,
  customerAddressPayload,
  customerEntityId,
  decryptSecret,
  defaultSettings,
  emptyStats,
  escapeLike,
  externalIdFor,
  findQuery,
  initialBase,
  invoiceAmountSig,
  isSyncableItem,
  isValidNsId,
  mergeEntity,
  mergeFieldsFor,
  normalizeValue,
  nsBool,
  nsToCanon,
  paymentLinkKey,
  paymentMethodFromName,
  parseNsInvoice,
  parseNsPayment,
  parseTimestamp,
  recordMeta,
  resolveLineItems,
  toCents,
  validateSettings,
  VIREEK_FIELDS,
  type Canon,
  type InvoiceLine,
  type NsEntity,
  type NsEnvironment,
  type NsInvoiceDoc,
  type NsSettings,
  type RawRecord,
  type SyncStats,
} from "../_shared/netsuite/engine.ts";

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

// ============================================================
// TYPES
// ============================================================

interface PullState { since: string | null; pos: number; passStarted: string | null; retry?: string[]; precise?: boolean }
interface PushState { ts: string | null; id: string | null; retry?: string[] }
interface EntityCursor { pull?: PullState; push?: PushState }
interface ConnRow {
  id: string;
  user_id: string;
  account_id: string;
  environment: NsEnvironment;
  status: string;
  settings: unknown;
  cursors: Record<string, EntityCursor> | null;
}
interface LinkRow {
  id: string;
  entity: NsEntity;
  vireek_id: string;
  external_id: string;
  base: Canon & { __lm?: string | null };
  conflict: { fields: string[]; sig: string; reason?: string } | null;
}
type VRow = Record<string, unknown> & { id: string; updated_at?: string };
type Outcome = "ok" | "conflict" | "error" | "skipped";
type Simple = "customer" | "item";

interface LogEntry {
  entity: NsEntity;
  direction: "to_ns" | "from_ns" | "both" | "none";
  action: "created" | "updated" | "linked" | "voided" | "conflict" | "skipped" | "error";
  vireek_id?: string | null;
  external_id?: string | null;
  link_id?: string | null;
  message: string;
  details?: unknown;
}

interface Ctx {
  admin: AnyClient;
  conn: ConnRow;
  ownerId: string;
  client: NsClient;
  settings: NsSettings;
  cursors: Record<string, EntityCursor>;
  runId: string | null;
  stats: SyncStats;
  logs: Record<string, unknown>[];
  deadline: number;
  lastProgressAt: number;
  warned: Set<string>;
  itemByName?: Map<string, string>;
}

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
  });
}
async function flushLogs(ctx: Ctx) {
  if (!ctx.logs.length) return;
  const rows = ctx.logs.splice(0);
  const { error } = await ctx.admin.from("ns_sync_log").insert(rows);
  if (error) console.error("ns-sync log insert failed", error.message);
}
async function touchRun(ctx: Ctx, force = false) {
  if (!ctx.runId) return;
  if (!force && Date.now() - ctx.lastProgressAt < 3000) return;
  ctx.lastProgressAt = Date.now();
  await ctx.admin.from("ns_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
  if (ctx.logs.length >= 40) await flushLogs(ctx);
}
const overDeadline = (ctx: Ctx) => Date.now() > ctx.deadline;
const warnOnce = (ctx: Ctx, key: string, e: LogEntry) => {
  if (ctx.warned.has(key)) return;
  ctx.warned.add(key);
  log(ctx, e);
};

// ============================================================
// NETSUITE HELPERS
// ============================================================

const fetchNs = (ctx: Ctx, entity: NsEntity, id: string) => ctx.client.getRecord(entity, id);

/** SuiteQL lookup returning the internal ids found. A failed lookup is an error, never "not found". */
async function findNsIds(ctx: Ctx, entity: NsEntity, field: Parameters<typeof findQuery>[1], value: string): Promise<string[]> {
  const page = await ctx.client.suiteql(findQuery(entity, field, value), 5, 0);
  return page.rows.map((r) => String(r.id)).filter(isValidNsId);
}

// ============================================================
// VIREEK-SIDE HELPERS
// ============================================================

const COLS: Record<Simple, string> = {
  customer: "id, name, email, phone, address, notes, customer_type, updated_at",
  item: "id, service_name, description, price_cents, active, updated_at",
};
const INVOICE_COLS = "id, customer_id, invoice_number, status, issue_date, due_date, subtotal_cents, tax_cents, total_cents, amount_paid_cents, updated_at";
const PAYMENT_COLS = "id, invoice_id, amount_cents, payment_date, payment_method, deposit_account_id, created_at";

function vireekCanon(entity: Simple, r: VRow): Canon {
  if (entity === "customer") return { name: r.name as string, email: r.email as string, phone: r.phone as string, notes: r.notes as string };
  return { name: r.service_name as string, description: r.description as string, active: r.active === false ? "inactive" : "active" };
}

/** Canon values -> Vireek column values (only the keys given). */
function toColumns(entity: Simple, v: Canon): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(v, k);
  if (entity === "customer") {
    for (const k of ["name", "email", "phone", "notes"]) if (has(k)) out[k] = v[k];
  } else {
    if (has("name")) out.service_name = v.name;
    if (has("description")) out.description = v.description;
    if (has("active")) out.active = v.active !== "inactive";
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

const LINK_COLS = "id, entity, vireek_id, external_id, base, conflict";
async function getLinkByExternal(ctx: Ctx, entity: NsEntity, externalId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin.from("ns_record_links").select(LINK_COLS).eq("connection_id", ctx.conn.id).eq("entity", entity).eq("external_id", externalId).maybeSingle();
  return (data as LinkRow | null) ?? null;
}
async function getLinkByVireek(ctx: Ctx, entity: NsEntity, vireekId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin.from("ns_record_links").select(LINK_COLS).eq("connection_id", ctx.conn.id).eq("entity", entity).eq("vireek_id", vireekId).maybeSingle();
  return (data as LinkRow | null) ?? null;
}
async function createLink(ctx: Ctx, entity: NsEntity, vireekId: string, externalId: string, base: Canon): Promise<LinkRow | null> {
  const { data, error } = await ctx.admin
    .from("ns_record_links")
    .insert({ user_id: ctx.ownerId, connection_id: ctx.conn.id, entity, vireek_id: vireekId, external_id: externalId, base })
    .select(LINK_COLS)
    .single();
  if (error) {
    // A duplicate means another run already linked this pair: that is the idempotent outcome, not a failure.
    if (!/duplicate key/i.test(error.message)) console.error("ns link insert failed", error.message);
    return null;
  }
  return data as LinkRow;
}
async function saveLink(ctx: Ctx, link: LinkRow, patch: { base?: Canon; conflict?: LinkRow["conflict"] }) {
  await ctx.admin.from("ns_record_links").update({ ...patch, last_synced_at: new Date().toISOString() }).eq("id", link.id);
}

/** Carries the SuiteQL modification stamp on the base snapshot (used to skip unchanged records cheaply). */
const withLm = (base: Canon, lm: string | null | undefined, link: LinkRow | null): Canon => ({ ...base, __lm: lm ?? link?.base?.__lm ?? null });

function addRetry(list: string[] | undefined, id: string): string[] {
  const set = new Set(list ?? []);
  set.add(id);
  return [...set].slice(-RETRY_CAP);
}

// ============================================================
// SIMPLE ENTITIES: customers, items
// ============================================================

function conflictSig(fields: string[], v: Canon, n: Canon): string {
  return JSON.stringify([fields, fields.map((f) => [v[f] ?? null, n[f] ?? null])]);
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
  opts: { ruleOverride?: "vireek_wins" | "ns_wins"; note?: string; lm?: string | null } = {},
): Promise<Outcome> {
  const es = ctx.settings.entities[entity];
  const meta = recordMeta(raw);
  const vC = vireekCanon(entity, vRow);
  const nC = nsToCanon(entity, raw);
  const res = mergeEntity({ entity, settings: es, base: stripMeta(link?.base ?? null), vireek: vC, ns: nC, vireekTs: tsOf(vRow), nsTs: meta.modifiedAt, ruleOverride: opts.ruleOverride });
  const next: Canon = { ...res.next };
  let failed = false;

  if (Object.keys(res.toVireek).length) {
    const err = await applyVireekUpdate(ctx, entity, vRow.id, res.toVireek);
    if (err) {
      failed = true;
      ctx.stats.errors++;
      log(ctx, { entity, direction: "from_ns", action: "error", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `Could not update Vireek: ${err}` });
      for (const k of Object.keys(res.toVireek)) next[k] = link?.base?.[k] ?? null;
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity, direction: "from_ns", action: "updated", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: opts.note ?? `Updated from NetSuite (${Object.keys(res.toVireek).join(", ")})`, details: res.toVireek });
    }
  }

  if (Object.keys(res.toCrm).length) {
    const payload = canonToNs(entity, res.toCrm, { defaults: ctx.settings.defaults, isPerson: nsBool(raw.isPerson) }, false);
    const w = Object.keys(payload).length ? await ctx.client.patch(entity, meta.id, payload) : ({ ok: true } as const);
    if (w.ok) {
      ctx.stats.updated_ns++;
      log(ctx, { entity, direction: "to_ns", action: "updated", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: opts.note ?? `Updated in NetSuite (${Object.keys(res.toCrm).join(", ")})`, details: res.toCrm });
    } else {
      failed = true;
      ctx.stats.errors++;
      log(ctx, { entity, direction: "to_ns", action: "error", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `NetSuite rejected the update: ${w.message}` });
      for (const k of Object.keys(res.toCrm)) next[k] = link?.base?.[k] ?? null;
    }
  }

  let conflict: LinkRow["conflict"] = null;
  if (res.conflicts.length) {
    const fields = res.conflicts.map((c) => c.field);
    const sig = conflictSig(fields, vC, nC);
    conflict = { fields, sig };
    if (link?.conflict?.sig !== sig) {
      ctx.stats.conflicts++;
      log(ctx, { entity, direction: "none", action: "conflict", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `Both sides changed: ${fields.join(", ")}`, details: res.conflicts });
    }
  }

  const base = withLm(next, failed ? link?.base?.__lm : opts.lm, link);
  if (link) await saveLink(ctx, link, { base, conflict });
  else await createLink(ctx, entity, vRow.id, meta.id, base);
  return failed ? "error" : conflict ? "conflict" : "ok";
}

async function findVireekMatch(ctx: Ctx, entity: Simple, nC: Canon): Promise<VRow | null> {
  const t = ENTITY_META[entity].table;
  const q = (col: string, val: string) => ctx.admin.from(t).select(COLS[entity]).eq("user_id", ctx.ownerId).ilike(col, escapeLike(val)).limit(1).maybeSingle();
  let row: unknown = null;
  if (entity === "customer") {
    if (nC.email) row = (await q("email", String(nC.email))).data;
    if (!row && nC.name) row = (await q("name", String(nC.name))).data;
  } else if (nC.name) {
    row = (await q("service_name", String(nC.name))).data;
  }
  const r = row as VRow | null;
  if (!r) return null;
  return (await getLinkByVireek(ctx, entity, r.id)) ? null : r; // already linked to another NetSuite record
}

async function createVireekRow(ctx: Ctx, entity: Simple, raw: RawRecord, nC: Canon): Promise<{ row?: VRow; error?: string; skip?: string }> {
  let insert: Record<string, unknown>;
  if (entity === "customer") {
    if (!nC.name) return { skip: "Customer has no name." };
    insert = { ...toColumns("customer", nC), address: addressFromDefault(raw.defaultAddress), user_id: ctx.ownerId, source: "import", lifecycle_stage: "active", customer_type: nsBool(raw.isPerson) ? "residential" : "commercial" };
  } else {
    if (!nC.name) return { skip: "Item has no name." };
    insert = { ...toColumns("item", nC), user_id: ctx.ownerId, pricing_model: "flat", price_cents: 0 };
  }
  const { data, error } = await ctx.admin.from(ENTITY_META[entity].table).insert(insert).select(COLS[entity]).single();
  if (error || !data) return { error: error?.message ?? "insert failed" };
  return { row: data as unknown as VRow };
}

async function applyNsRecord(ctx: Ctx, entity: Simple, raw: RawRecord, lm: string | null): Promise<void> {
  const es = ctx.settings.entities[entity];
  const meta = recordMeta(raw);
  if (!isValidNsId(meta.id)) return;
  if (entity === "item" && !isSyncableItem(raw)) return;
  const nC = nsToCanon(entity, raw);
  const link = await getLinkByExternal(ctx, entity, meta.id);

  if (link) {
    const vRow = await getVireekRow(ctx, entity, link.vireek_id);
    if (!vRow) {
      warnOnce(ctx, `gone:${link.id}`, { entity, direction: "none", action: "skipped", vireek_id: link.vireek_id, external_id: meta.id, link_id: link.id, message: "Deleted in Vireek: not recreated and not changed in NetSuite." });
      ctx.stats.skipped++;
      return;
    }
    await reconcile(ctx, entity, link, vRow, raw, { lm });
    return;
  }

  const match = await findVireekMatch(ctx, entity, nC);
  if (match) {
    const out = await reconcile(ctx, entity, null, match, raw, { note: "Matched an existing record", lm });
    if (out !== "error") log(ctx, { entity, direction: "both", action: "linked", vireek_id: match.id, external_id: meta.id, message: "Linked to the matching record" });
    return;
  }
  if (!canCreateInVireek(es)) {
    ctx.stats.skipped++;
    return;
  }
  const made = await createVireekRow(ctx, entity, raw, nC);
  if (made.skip) {
    ctx.stats.skipped++;
    log(ctx, { entity, direction: "from_ns", action: "skipped", external_id: meta.id, message: made.skip });
    return;
  }
  if (made.error || !made.row) {
    ctx.stats.errors++;
    log(ctx, { entity, direction: "from_ns", action: "error", external_id: meta.id, message: `Could not create in Vireek: ${made.error}` });
    return;
  }
  await createLink(ctx, entity, made.row.id, meta.id, withLm(initialBase(entity, es, vireekCanon(entity, made.row), nC), lm, null));
  ctx.stats.created_vireek++;
  log(ctx, { entity, direction: "from_ns", action: "created", vireek_id: made.row.id, external_id: meta.id, message: `Created from NetSuite: ${String(nC.name ?? meta.id).slice(0, 80)}` });
}

function vireekChangedSinceBase(entity: Simple, link: LinkRow, row: VRow, es: NsSettings["entities"][Simple]): boolean {
  const v = vireekCanon(entity, row);
  const base = link.base ?? {};
  return mergeFieldsFor(entity, es).some((f) => normalizeValue(f.type, v[f.key]) !== normalizeValue(f.type, base[f.key]));
}

async function createInNs(ctx: Ctx, entity: Simple, row: VRow): Promise<void> {
  const es = ctx.settings.entities[entity];
  const vC = vireekCanon(entity, row);
  const label = String(vC.name ?? row.id).slice(0, 80);
  const kind = entity === "customer" ? "c" : "t";

  if (entity === "item" && !ctx.settings.defaults.incomeAccountId) {
    warnOnce(ctx, "no-income", { entity, direction: "none", action: "skipped", message: "Items were not created in NetSuite: choose a default income account under Mapping → Defaults." });
    ctx.stats.skipped++;
    return;
  }

  // 1. Never duplicate: a record we already wrote (externalId), or one that matches by identity, is linked.
  let hitId = (await findNsIds(ctx, entity, "externalId", externalIdFor(kind, row.id)))[0] ?? null;
  if (!hitId) {
    const candidates: string[] = [];
    if (entity === "customer" && vC.email) candidates.push(...(await findNsIds(ctx, entity, "email", String(vC.email))));
    if (!candidates.length && vC.name) candidates.push(...(await findNsIds(ctx, entity, "name", String(vC.name))));
    for (const id of candidates) {
      if (!(await getLinkByExternal(ctx, entity, id))) {
        hitId = id; // not yet linked to any other Vireek record
        break;
      }
    }
  }
  if (hitId) {
    const raw = await fetchNs(ctx, entity, hitId);
    if (raw) {
      const out = await reconcile(ctx, entity, null, row, raw, { note: "Matched an existing NetSuite record" });
      if (out !== "error") log(ctx, { entity, direction: "both", action: "linked", vireek_id: row.id, external_id: hitId, message: `Linked to existing NetSuite record: ${label}` });
      return;
    }
  }

  // 2. Create (PUT to the externalId URL: idempotent even if this write is repeated).
  const values: Canon = {};
  for (const f of mergeFieldsFor(entity, es)) if (f.direction !== "from_crm") values[f.key] = vC[f.key] ?? null;
  if (!("name" in values)) values.name = vC.name ?? null;
  const isPerson = entity === "customer" && row.customer_type !== "commercial";
  const payload: RawRecord = canonToNs(entity, values, { defaults: ctx.settings.defaults, isPerson }, true);
  if (entity === "customer") {
    Object.assign(payload, customerAddressPayload(row.address as string | null) ?? {});
    if (ctx.settings.defaults.sendEntityId) payload.entityId = customerEntityId(String(vC.name ?? ""), row.id);
  }
  const w = await ctx.client.upsert(entity, externalIdFor(kind, row.id), payload);
  if (!w.ok) {
    ctx.stats.errors++;
    log(ctx, { entity, direction: "to_ns", action: "error", vireek_id: row.id, message: `Could not create in NetSuite (${label}): ${w.message}` });
    return;
  }
  await createLink(ctx, entity, row.id, w.id, initialBase(entity, es, vC, nsToCanon(entity, w.record)));
  ctx.stats.created_ns++;
  log(ctx, { entity, direction: "to_ns", action: "created", vireek_id: row.id, external_id: w.id, message: `Created in NetSuite: ${label}` });
}

async function pushSimple(ctx: Ctx, entity: Simple, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities[entity];
  if (es.direction === "from_ns") return;
  const t = ENTITY_META[entity].table;
  let cur: PushState = ctx.cursors[entity]?.push ?? { ts: null, id: null };

  const handle = async (row: VRow) => {
    const link = await getLinkByVireek(ctx, entity, row.id);
    if (link) {
      if (!vireekChangedSinceBase(entity, link, row, es) && !link.conflict) return;
      const raw = await fetchNs(ctx, entity, link.external_id);
      if (!raw) {
        warnOnce(ctx, `qgone:${link.id}`, { entity, direction: "none", action: "skipped", vireek_id: row.id, external_id: link.external_id, link_id: link.id, message: "Deleted in NetSuite: not recreated and not changed in Vireek." });
        return;
      }
      await reconcile(ctx, entity, link, row, raw);
    } else if (canCreateInNs(es) && pullDoneOnce) {
      await createInNs(ctx, entity, row);
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
// GENERIC PULL (SuiteQL id list -> GET each changed record)
// ============================================================

/** True when SuiteQL returned a time of day (so an equal stamp really means "unchanged"). */
const hasTime = (lm: string | null): lm is string => !!lm && /\d{1,2}:\d{2}/.test(lm);

async function isFresh(ctx: Ctx, entity: NsEntity, id: string, lm: string): Promise<boolean> {
  if (entity === "payment") {
    const { data } = await ctx.admin.from("ns_record_links").select("base").eq("connection_id", ctx.conn.id).eq("entity", "payment").like("external_id", `${escapeLike(id)}:%`).limit(1).maybeSingle();
    return !!data && (data as { base: Canon }).base?.__lm === lm;
  }
  const link = await getLinkByExternal(ctx, entity, id);
  return !!link && !link.conflict && link.base?.__lm === lm;
}

async function pullEntity(ctx: Ctx, entity: NsEntity, apply: (raw: RawRecord, lm: string | null) => Promise<"retry" | void>): Promise<boolean> {
  const cur: PullState = ctx.cursors[entity]?.pull ?? { since: null, pos: 0, passStarted: null };
  const passStarted = cur.passStarted ?? new Date().toISOString();
  const sinceMs = cur.since ? Date.parse(cur.since) - PULL_OVERLAP_MS : null;
  let pos = cur.pos || 0;
  let seen = 0;
  let precise = cur.precise ?? false;
  let retry: string[] = [];

  for (const id of cur.retry ?? []) {
    const raw = isValidNsId(id) ? await fetchNs(ctx, entity, id) : null;
    if (raw && (await apply(raw, null)) === "retry") retry = addRetry(retry, id);
  }
  const save = (state: Omit<PullState, "retry" | "precise">) => {
    ctx.cursors[entity] = { ...ctx.cursors[entity], pull: { ...state, retry, precise } };
  };

  while (true) {
    if (overDeadline(ctx)) {
      save({ since: cur.since, pos, passStarted });
      return false;
    }
    const page = await ctx.client.suiteql(changedIdsQuery(entity, sinceMs), NS_SUITEQL_PAGE, pos);
    const lmOf = (row: RawRecord): string | null => {
      const v = row.lastmodifieddate ?? row.lastModifiedDate;
      return typeof v === "string" ? v : null;
    };
    if (page.rows.length) precise = hasTime(lmOf(page.rows[0]));
    for (const row of page.rows) {
      const id = String(row.id ?? "");
      if (!isValidNsId(id)) continue;
      const lm = lmOf(row);
      const stamped = hasTime(lm);
      if (stamped && (await isFresh(ctx, entity, id, lm))) continue;
      const raw = await fetchNs(ctx, entity, id);
      if (!raw) continue;
      if ((await apply(raw, stamped ? lm : null)) === "retry") retry = addRetry(retry, id);
    }
    if (!precise && page.rows.length) {
      warnOnce(ctx, `date-only:${entity}`, { entity, direction: "none", action: "skipped", message: "NetSuite returned date-only modification times, so each sync re-reads records changed in the last 26 hours. This is safe, just slower." });
    }
    seen += page.rows.length;
    pos += page.rows.length;
    await touchRun(ctx);
    if (!page.hasMore || page.rows.length === 0) {
      save({ since: passStarted, pos: 0, passStarted: null });
      return true;
    }
    if (seen >= PAGE_CAP_PER_RUN) {
      save({ since: cur.since, pos, passStarted });
      return false;
    }
  }
}

// ============================================================
// INVOICES
// ============================================================

interface VInvoice { row: VRow; lines: InvoiceLine[] }

async function loadInvoice(ctx: Ctx, id: string): Promise<VInvoice | null> {
  const { data } = await ctx.admin.from("ar_invoices").select(INVOICE_COLS).eq("id", id).eq("user_id", ctx.ownerId).maybeSingle();
  if (!data) return null;
  const { data: ls } = await ctx.admin.from("ar_invoice_lines").select("description, quantity, unit_price_cents, amount_cents").eq("invoice_id", id).order("line_number");
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
function invoiceNsCanon(d: NsInvoiceDoc): Canon {
  return { due_date: d.dueDate, amounts: d.voided ? null : invoiceAmountSig(d), voided: d.voided ? "void" : "active" };
}

async function itemMap(ctx: Ctx): Promise<Map<string, string>> {
  if (ctx.itemByName) return ctx.itemByName;
  const map = new Map<string, string>();
  const { data: links } = await ctx.admin.from("ns_record_links").select("vireek_id, external_id").eq("connection_id", ctx.conn.id).eq("entity", "item");
  const ids = (links ?? []) as { vireek_id: string; external_id: string }[];
  if (ids.length) {
    const { data: items } = await ctx.admin.from("price_book_items").select("id, service_name").eq("user_id", ctx.ownerId).in("id", ids.map((l) => l.vireek_id));
    const ext = new Map(ids.map((l) => [l.vireek_id, l.external_id]));
    for (const it of (items ?? []) as { id: string; service_name: string }[]) map.set(it.service_name.toLowerCase().replace(/\s+/g, " ").trim(), ext.get(it.id)!);
  }
  ctx.itemByName = map;
  return map;
}

const linesJson = (lines: InvoiceLine[]) =>
  lines.map((l) => ({ description: l.description, quantity: l.qty, unit_price_cents: l.unitPriceCents, amount_cents: l.amountCents, revenue_account_id: null }));

const isPaymentsBlock = (msg: string) => /PAYMENTS_EXIST/.test(msg);

async function reconcileInvoice(
  ctx: Ctx,
  link: LinkRow | null,
  v: VInvoice,
  doc: NsInvoiceDoc,
  opts: { ruleOverride?: "vireek_wins" | "ns_wins"; note?: string; lm?: string | null } = {},
): Promise<Outcome> {
  const es = ctx.settings.entities.invoice;
  const vC = invoiceVireekCanon(v);
  const nC = invoiceNsCanon(doc);
  const res = mergeEntity({ entity: "invoice", settings: es, base: stripMeta(link?.base ?? null), vireek: vC, ns: nC, vireekTs: tsOf(v.row), nsTs: doc.modifiedAt, ruleOverride: opts.ruleOverride });
  const next: Canon = { ...res.next };
  const blocked: string[] = [];
  const reasons: string[] = [];
  let failed = false;
  const id = v.row.id;
  const ext = doc.id;
  const fail = (direction: "to_ns" | "from_ns", message: string) => {
    failed = true;
    ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction, action: "error", vireek_id: id, external_id: ext, link_id: link?.id, message });
  };
  const block = (field: string, reason: string) => {
    blocked.push(field);
    reasons.push(reason);
  };

  // ---- void ----
  if (res.toVireek.voided === "void") {
    const { error } = await ctx.admin.rpc("ns_void_ar_invoice", { p_owner: ctx.ownerId, p_invoice_id: id });
    if (error) {
      if (isPaymentsBlock(error.message)) block("voided", "Voided in NetSuite, but Vireek has payments on this invoice. Void or refund the payments in Vireek first.");
      else fail("from_ns", `Could not void in Vireek: ${error.message}`);
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity: "invoice", direction: "from_ns", action: "voided", vireek_id: id, external_id: ext, link_id: link?.id, message: "Voided to match NetSuite" });
    }
  }
  // NetSuite cannot void over REST: never guess, tell a human exactly what to do.
  if (res.toCrm.voided === "void") block("voided", NS_CANNOT_VOID_REASON);
  const voidedNow = vC.voided === "void" || nC.voided === "void" || res.toVireek.voided === "void";

  // ---- amounts (never when a void is involved) ----
  if (!voidedNow && typeof res.toVireek.amounts === "string") {
    const { error } = await ctx.admin.rpc("ns_replace_ar_invoice", {
      p_owner: ctx.ownerId, p_invoice_id: id, p_issue_date: doc.txnDate, p_due_date: doc.dueDate, p_tax_cents: doc.taxCents, p_lines: linesJson(doc.lines),
    });
    if (error) {
      if (isPaymentsBlock(error.message)) block("amounts", "Amounts changed in NetSuite after a payment was recorded in Vireek. Review it, then choose which side to keep.");
      else fail("from_ns", `Could not apply NetSuite amounts: ${error.message}`);
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity: "invoice", direction: "from_ns", action: "updated", vireek_id: id, external_id: ext, link_id: link?.id, message: "Line items and totals updated from NetSuite" });
    }
  }
  const pushAmounts = !voidedNow && typeof res.toCrm.amounts === "string";
  const pushDue = !voidedNow && res.toCrm.due_date !== undefined;
  if (pushAmounts || pushDue) {
    const resolved = pushAmounts ? resolveLineItems(v.lines, await itemMap(ctx), ctx.settings.defaults.fallbackItemId) : { ok: true as const, lines: v.lines };
    if (!resolved.ok) block("amounts", resolved.reason);
    else {
      const { body, replace } = buildNsInvoicePatch(
        { invoiceNumber: String(v.row.invoice_number), issueDate: String(v.row.issue_date), dueDate: String(v.row.due_date), taxCents: Number(v.row.tax_cents), lines: resolved.lines },
        ctx.settings.defaults,
        { amounts: pushAmounts, due: pushDue },
      );
      const w = await ctx.client.patch("invoice", ext, body, replace);
      if (w.ok) {
        ctx.stats.updated_ns++;
        log(ctx, { entity: "invoice", direction: "to_ns", action: "updated", vireek_id: id, external_id: ext, link_id: link?.id, message: "Invoice updated in NetSuite" });
        warnTotals(ctx, v, w.record, ext);
      } else {
        if (pushAmounts) block("amounts", `NetSuite rejected the update: ${w.message}`);
        fail("to_ns", `NetSuite rejected the invoice update: ${w.message}`);
      }
    }
  }

  // ---- due date (no ledger impact) ----
  if (res.toVireek.due_date !== undefined && res.toVireek.due_date !== null) {
    const { error } = await ctx.admin.from("ar_invoices").update({ due_date: res.toVireek.due_date }).eq("id", id).eq("user_id", ctx.ownerId);
    if (error) fail("from_ns", `Could not update the due date: ${error.message}`);
    else ctx.stats.updated_vireek++;
  }

  for (const f of blocked) next[f] = link?.base?.[f] ?? null;
  const fields = [...new Set([...res.conflicts.map((c) => c.field), ...blocked])];
  let conflict: LinkRow["conflict"] = null;
  if (fields.length) {
    const sig = conflictSig(fields, vC, nC);
    conflict = { fields, sig, ...(reasons.length ? { reason: reasons[0] } : {}) };
    if (link?.conflict?.sig !== sig) {
      ctx.stats.conflicts++;
      log(ctx, { entity: "invoice", direction: "none", action: "conflict", vireek_id: id, external_id: ext, link_id: link?.id, message: reasons[0] ?? `Both sides changed: ${fields.join(", ")}`, details: res.conflicts });
    }
  }
  const base = withLm(next, failed ? link?.base?.__lm : opts.lm, link);
  if (link) await saveLink(ctx, link, { base, conflict });
  else await createLink(ctx, "invoice", id, ext, base);
  return failed ? "error" : conflict ? "conflict" : "ok";
}

function warnTotals(ctx: Ctx, v: VInvoice, rec: RawRecord, ext: string) {
  const expected = Number(v.row.total_cents);
  if (toCents(rec.total) !== expected) {
    log(ctx, { entity: "invoice", direction: "to_ns", action: "conflict", vireek_id: v.row.id, external_id: ext, message: `NetSuite total (${toCents(rec.total) / 100}) differs from Vireek (${expected / 100}); NetSuite calculates its own sales tax. Check the tax code under Mapping → Defaults.` });
    ctx.stats.conflicts++;
  }
}

async function applyNsInvoice(ctx: Ctx, raw: RawRecord, lm: string | null): Promise<"retry" | void> {
  const es = ctx.settings.entities.invoice;
  const meta = recordMeta(raw);
  if (!isValidNsId(meta.id)) return;
  const parsed = parseNsInvoice(raw);
  if (!parsed.ok) {
    ctx.stats.skipped++;
    warnOnce(ctx, `inv:${meta.id}:${meta.modifiedAt}`, { entity: "invoice", direction: "from_ns", action: "skipped", external_id: meta.id, message: `Invoice ${String(raw.tranId ?? meta.id)} skipped: ${parsed.reason}` });
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
    await reconcileInvoice(ctx, link, v, doc, { lm });
    return;
  }
  if (doc.voided) return;

  // Match an invoice both sides already have (same number and total) instead of duplicating it.
  if (doc.tranId) {
    const { data } = await ctx.admin.from("ar_invoices").select("id").eq("user_id", ctx.ownerId).eq("invoice_number", doc.tranId).eq("total_cents", doc.totalCents).maybeSingle();
    if (data && !(await getLinkByVireek(ctx, "invoice", (data as unknown as VRow).id))) {
      const v = await loadInvoice(ctx, (data as unknown as VRow).id);
      if (v) {
        await reconcileInvoice(ctx, null, v, doc, { note: "Matched an existing invoice", lm });
        log(ctx, { entity: "invoice", direction: "both", action: "linked", vireek_id: v.row.id, external_id: doc.id, message: `Linked to existing invoice ${doc.tranId}` });
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
    warnOnce(ctx, `invcust:${doc.id}`, { entity: "invoice", direction: "from_ns", action: "skipped", external_id: doc.id, message: `Invoice ${doc.tranId ?? doc.id} waits for its customer to sync (enable Customers, then Sync now).` });
    return "retry";
  }
  if (doc.totalCents <= 0) {
    ctx.stats.skipped++;
    return;
  }
  const { data: newId, error } = await ctx.admin.rpc("ns_create_ar_invoice", {
    p_owner: ctx.ownerId, p_customer_id: cust.vireek_id, p_issue_date: doc.txnDate, p_due_date: doc.dueDate, p_tax_cents: doc.taxCents, p_lines: linesJson(doc.lines), p_invoice_number: doc.tranId,
  });
  if (error || !newId) {
    ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction: "from_ns", action: "error", external_id: doc.id, message: `Could not create invoice ${doc.tranId ?? doc.id}: ${error?.message ?? "no id"}` });
    return;
  }
  const v = await loadInvoice(ctx, newId as string);
  await createLink(ctx, "invoice", newId as string, doc.id, withLm(v ? invoiceVireekCanon(v) : invoiceNsCanon(doc), lm, null));
  ctx.stats.created_vireek++;
  log(ctx, { entity: "invoice", direction: "from_ns", action: "created", vireek_id: newId as string, external_id: doc.id, message: `Created invoice ${doc.tranId ?? doc.id} from NetSuite` });
}

const PUSHABLE = new Set(["sent", "partially_paid", "paid", "overdue"]);

async function createInvoiceInNs(ctx: Ctx, v: VInvoice): Promise<"retry" | void> {
  if (!PUSHABLE.has(String(v.row.status))) return;
  const number = String(v.row.invoice_number);
  const customer = v.row.customer_id ? await getLinkByVireek(ctx, "customer", String(v.row.customer_id)) : null;
  if (!customer) {
    warnOnce(ctx, `vinvcust:${v.row.id}`, { entity: "invoice", direction: "to_ns", action: "skipped", vireek_id: v.row.id, message: `Invoice ${number} waits for its customer to be linked to NetSuite.` });
    return "retry";
  }
  const resolved = resolveLineItems(v.lines, await itemMap(ctx), ctx.settings.defaults.fallbackItemId);
  if (!resolved.ok) {
    warnOnce(ctx, `vinvitem:${number}`, { entity: "invoice", direction: "to_ns", action: "skipped", vireek_id: v.row.id, message: `Invoice ${number} not sent: ${resolved.reason}` });
    return "retry";
  }

  // An invoice NetSuite already has (written by us before, or entered by hand under the same number) is linked, not duplicated.
  const exts = await findNsIds(ctx, "invoice", "externalId", externalIdFor("i", String(v.row.id)));
  const byNumber = ctx.settings.defaults.sendTranId && !exts.length ? await findNsIds(ctx, "invoice", "tranId", number) : [];
  for (const nsId of [...exts, ...byNumber]) {
    if (await getLinkByExternal(ctx, "invoice", nsId)) continue;
    const raw = await fetchNs(ctx, "invoice", nsId);
    const p = raw ? parseNsInvoice(raw) : null;
    if (p && p.ok && (exts.includes(nsId) || p.doc.totalCents === Number(v.row.total_cents))) {
      await reconcileInvoice(ctx, null, v, p.doc, { note: "Matched an existing NetSuite invoice" });
      log(ctx, { entity: "invoice", direction: "both", action: "linked", vireek_id: v.row.id, external_id: nsId, message: `Linked to existing NetSuite invoice ${number}` });
      return;
    }
  }

  const payload = buildNsInvoiceCreate(
    { invoiceNumber: number, issueDate: String(v.row.issue_date), dueDate: String(v.row.due_date), taxCents: Number(v.row.tax_cents), lines: resolved.lines },
    customer.external_id,
    ctx.settings.defaults,
  );
  const w = await ctx.client.upsert("invoice", externalIdFor("i", String(v.row.id)), payload);
  if (!w.ok) {
    ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction: "to_ns", action: "error", vireek_id: v.row.id, message: `Could not create invoice ${number} in NetSuite: ${w.message}` });
    return;
  }
  await createLink(ctx, "invoice", String(v.row.id), w.id, invoiceVireekCanon(v));
  ctx.stats.created_ns++;
  log(ctx, { entity: "invoice", direction: "to_ns", action: "created", vireek_id: String(v.row.id), external_id: w.id, message: `Created invoice ${number} in NetSuite` });
  warnTotals(ctx, v, w.record, w.id);
}

async function pushInvoices(ctx: Ctx, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities.invoice;
  if (es.direction === "from_ns") return;
  let cur: PushState = ctx.cursors.invoice?.push ?? { ts: null, id: null };
  const typeOf = (k: string) => VIREEK_FIELDS.invoice.find((f) => f.key === k)!.type;

  const handle = async (id: string): Promise<"retry" | void> => {
    const v = await loadInvoice(ctx, id);
    if (!v) return;
    const link = await getLinkByVireek(ctx, "invoice", id);
    if (link) {
      const vC = invoiceVireekCanon(v);
      const changed = (["due_date", "amounts", "voided"] as const).some((k) => normalizeValue(typeOf(k), vC[k]) !== normalizeValue(typeOf(k), link.base?.[k]));
      if (!changed && !link.conflict) return;
      const raw = await fetchNs(ctx, "invoice", link.external_id);
      const p = raw ? parseNsInvoice(raw) : null;
      if (!p || !p.ok) {
        if (p && !p.ok) warnOnce(ctx, `inv:${link.external_id}`, { entity: "invoice", direction: "none", action: "skipped", vireek_id: id, external_id: link.external_id, link_id: link.id, message: `NetSuite invoice cannot be compared: ${p.reason}` });
        return;
      }
      await reconcileInvoice(ctx, link, v, p.doc);
      return;
    }
    if (canCreateInNs(es) && pullDoneOnce) return createInvoiceInNs(ctx, v);
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

async function applyNsPayment(ctx: Ctx, raw: RawRecord, lm: string | null): Promise<"retry" | void> {
  const es = ctx.settings.entities.payment;
  const doc = parseNsPayment(raw);
  if (!doc) return;
  if (doc.voided) {
    warnOnce(ctx, `pv:${doc.id}`, { entity: "payment", direction: "from_ns", action: "skipped", external_id: doc.id, message: "Payment voided in NetSuite. Payments are never reversed automatically: void it in Vireek if needed." });
    return;
  }
  if (!canCreateInVireek(es)) return;
  let retry = false;
  for (const app of doc.applications) {
    const key = paymentLinkKey(doc.id, app.invoiceId);
    const existing = await getLinkByExternal(ctx, "payment", key);
    if (existing) {
      if (lm && existing.base?.__lm !== lm) await saveLink(ctx, existing, { base: { ...(existing.base ?? {}), __lm: lm } });
      continue;
    }
    const invLink = await getLinkByExternal(ctx, "invoice", app.invoiceId);
    if (!invLink) {
      warnOnce(ctx, `pi:${key}`, { entity: "payment", direction: "from_ns", action: "skipped", external_id: key, message: `Payment ${doc.id} waits for its invoice to sync.` });
      retry = true;
      continue;
    }
    const inv = await loadInvoice(ctx, invLink.vireek_id);
    if (!inv || inv.row.status === "void") continue;
    const remaining = Number(inv.row.total_cents) - Number(inv.row.amount_paid_cents);
    if (app.amountCents > remaining) {
      ctx.stats.errors++;
      log(ctx, { entity: "payment", direction: "from_ns", action: "error", external_id: key, vireek_id: inv.row.id, message: `Payment of ${app.amountCents / 100} exceeds the Vireek balance of ${remaining / 100}. Not recorded.` });
      continue;
    }
    const { data: payId, error } = await ctx.admin.rpc("ns_record_ar_payment", {
      p_owner: ctx.ownerId, p_invoice_id: inv.row.id, p_amount_cents: app.amountCents, p_method: paymentMethodFromName(doc.methodName), p_date: doc.txnDate, p_deposit_account_id: null,
    });
    if (error || !payId) {
      ctx.stats.errors++;
      log(ctx, { entity: "payment", direction: "from_ns", action: "error", external_id: key, vireek_id: inv.row.id, message: `Could not record the payment: ${error?.message ?? "no id"}` });
      continue;
    }
    await createLink(ctx, "payment", payId as string, key, { __lm: lm });
    ctx.stats.created_vireek++;
    log(ctx, { entity: "payment", direction: "from_ns", action: "created", vireek_id: payId as string, external_id: key, message: `Recorded payment of ${app.amountCents / 100} from NetSuite` });
  }
  return retry ? "retry" : undefined;
}

async function pushPayments(ctx: Ctx, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities.payment;
  if (!canCreateInNs(es) || !pullDoneOnce) return;
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
      warnOnce(ctx, `vp:${p.id}`, { entity: "payment", direction: "to_ns", action: "skipped", vireek_id: p.id, message: `Payment on invoice ${String(invRow.invoice_number)} waits for the invoice and customer to be linked to NetSuite.` });
      return "retry";
    }
    const ext = externalIdFor("p", p.id);
    // Already written by an earlier (interrupted) run: link it, never create a second payment.
    const existing = (await findNsIds(ctx, "payment", "externalId", ext))[0];
    let nsId = existing ?? null;
    if (!nsId) {
      const payload = buildNsPaymentCreate({
        customerId: custLink.external_id, invoiceId: invLink.external_id, amountCents: Number(p.amount_cents), date: String(p.payment_date),
        accountId: ctx.settings.defaults.depositAccountId, subsidiaryId: ctx.settings.defaults.subsidiaryId, note: `Vireek payment ${p.id} (${String(p.payment_method)})`,
      });
      const w = await ctx.client.upsert("payment", ext, payload);
      if (!w.ok) {
        ctx.stats.errors++;
        log(ctx, { entity: "payment", direction: "to_ns", action: "error", vireek_id: p.id, message: `Could not create the payment in NetSuite: ${w.message}` });
        return;
      }
      nsId = w.id;
      ctx.stats.created_ns++;
      log(ctx, { entity: "payment", direction: "to_ns", action: "created", vireek_id: p.id, external_id: paymentLinkKey(nsId, invLink.external_id), message: `Sent payment of ${Number(p.amount_cents) / 100} to NetSuite` });
    } else {
      log(ctx, { entity: "payment", direction: "both", action: "linked", vireek_id: p.id, external_id: paymentLinkKey(nsId, invLink.external_id), message: "Linked to the payment already in NetSuite" });
    }
    await createLink(ctx, "payment", p.id, paymentLinkKey(nsId, invLink.external_id), {});
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
  const { data } = await admin
    .from("ns_connections")
    .update({ sync_locked_until: new Date(Date.now() + LOCK_MS).toISOString() })
    .eq("id", connId)
    .or(`sync_locked_until.is.null,sync_locked_until.lt.${now}`)
    .select("id");
  return (data?.length ?? 0) > 0;
}

const encryptionKey = () => Deno.env.get("NS_TOKEN_ENCRYPTION_KEY") || Deno.env.get("QBO_TOKEN_ENCRYPTION_KEY") || "";

async function buildCtx(admin: AnyClient, conn: ConnRow, runId: string | null, deadline: number): Promise<Ctx> {
  const encKey = encryptionKey();
  const { data: sec } = await admin.from("ns_connection_secrets").select("credentials_enc").eq("connection_id", conn.id).maybeSingle();
  if (!sec || !encKey) throw new NsAuthError("No stored credentials. Please reconnect.");
  const valid = validateSettings(conn.settings && Object.keys(conn.settings as object).length ? conn.settings : defaultSettings());
  if (!valid.ok) throw new Error(`Saved settings are invalid: ${valid.error}`);
  let c: { consumerKey: string; consumerSecret: string; tokenId: string; tokenSecret: string };
  try {
    c = JSON.parse(await decryptSecret(sec.credentials_enc as string, encKey));
  } catch {
    throw new NsAuthError("Stored credentials could not be read. Please reconnect.");
  }
  return {
    admin, conn, ownerId: conn.user_id,
    client: new NsClient({ credentials: { accountId: conn.account_id, ...c } }),
    settings: valid.settings, cursors: { ...(conn.cursors ?? {}) },
    runId, stats: emptyStats(), logs: [], deadline, lastProgressAt: 0, warned: new Set(),
  };
}

async function mirrorIntegration(admin: AnyClient, conn: ConnRow, status: "connected" | "error" | "disconnected", extra: Record<string, unknown> = {}) {
  const { data: c } = await admin.from("ns_connections").select("company_name, environment, account_id").eq("id", conn.id).maybeSingle();
  await admin.from("integrations").upsert(
    { user_id: conn.user_id, integration_type: "netsuite", status, config: { account_id: c?.account_id ?? conn.account_id, company_name: c?.company_name ?? null, environment: c?.environment ?? conn.environment, ...extra } },
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
    await admin.from("ns_sync_log").delete().eq("connection_id", conn.id).lt("created_at", new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString());
    ctx = await buildCtx(admin, conn, runId, Date.now() + RUN_BUDGET_MS);
    const c = ctx;
    let dependenciesDone = true;

    for (const entity of NS_ENTITIES) {
      const es = c.settings.entities[entity];
      if (!es.enabled) continue;
      if (overDeadline(c)) {
        allFinished = false;
        break;
      }
      // Invoices and payments need their customers / items fully synced first.
      if ((entity === "invoice" || entity === "payment") && !dependenciesDone) {
        allFinished = false;
        continue;
      }
      let finished = true;
      if (es.direction !== "to_ns") {
        finished =
          entity === "invoice" ? await pullEntity(c, entity, (raw, lm) => applyNsInvoice(c, raw, lm))
          : entity === "payment" ? await pullEntity(c, entity, (raw, lm) => applyNsPayment(c, raw, lm))
          : await pullEntity(c, entity, (raw, lm) => applyNsRecord(c, entity, raw, lm));
      }
      if (!finished) {
        allFinished = false;
        if (entity === "customer" || entity === "item") dependenciesDone = false;
      }
      const pullDoneOnce = es.direction === "to_ns" || !!c.cursors[entity]?.pull?.since;
      if (entity === "invoice") await pushInvoices(c, pullDoneOnce);
      else if (entity === "payment") await pushPayments(c, pullDoneOnce);
      else await pushSimple(c, entity, pullDoneOnce);
    }
    if (!allFinished || overDeadline(c)) {
      status = "partial";
      error = "Large sync in progress. It will continue automatically on the next run.";
    }
    if (c.stats.errors > 0 && status === "success") status = "partial";
  } catch (err) {
    status = "failed";
    if (err instanceof NsAuthError) {
      markError = true;
      errorCode = "credentials_rejected";
      error = "NetSuite rejected the credentials. The token may have been revoked: disconnect and connect again.";
    } else if (err instanceof NsRateLimitError) {
      status = "partial";
      error = "NetSuite is rate limiting requests. The sync will retry on the next run.";
    } else if (err instanceof NsFaultError && err.kind === "permission") {
      error = `The NetSuite token's role is missing a permission: ${err.message}`.slice(0, 400);
    } else {
      error = err instanceof Error ? err.message.slice(0, 400) : "Unexpected sync error.";
      console.error("ns-sync-run failed", conn.id, error);
    }
  } finally {
    if (ctx) {
      await flushLogs(ctx);
      if (ctx.runId) await admin.from("ns_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
    }
    await admin.from("ns_sync_runs").update({ status, error, finished_at: new Date().toISOString(), ...(ctx ? { stats: ctx.stats } : {}) }).eq("id", runId);
    await admin
      .from("ns_connections")
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

async function beginRun(admin: AnyClient, conn: ConnRow, trigger: "manual" | "scheduled"): Promise<string | null> {
  if (!(await acquireLock(admin, conn.id))) return null;
  await admin.from("ns_sync_runs").update({ status: "failed", error: "Interrupted.", finished_at: new Date().toISOString() }).eq("connection_id", conn.id).eq("status", "running").lt("started_at", new Date(Date.now() - 10 * 60_000).toISOString());
  const { data } = await admin.from("ns_sync_runs").insert({ user_id: conn.user_id, connection_id: conn.id, trigger, status: "running" }).select("id").single();
  if (!data) {
    await admin.from("ns_connections").update({ sync_locked_until: null }).eq("id", conn.id);
    return null;
  }
  return data.id as string;
}

const background = (p: Promise<unknown>) => {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(p);
  else void p;
};

const CONN_COLS = "id, user_id, account_id, environment, status, settings, cursors";

/** Live lists for the mapping UI. Names only; never cached or stored. Column names are read tolerantly. */
async function listOptions(ctx: Ctx) {
  const pick = async (q: string) => {
    try {
      return (await ctx.client.suiteql(q, 1000, 0)).rows;
    } catch (err) {
      if (err instanceof NsAuthError || err instanceof NsRateLimitError) throw err;
      return []; // e.g. no subsidiary table on a non-OneWorld account, or no permission for that list
    }
  };
  const s = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
  const first = (r: Record<string, unknown>, keys: string[]) => keys.map((k) => s(r[k])).find((x) => x) ?? "";
  const accounts = (await pick("SELECT * FROM account WHERE isInactive = 'F'")).map((r) => ({
    id: s(r.id), name: `${first(r, ["acctnumber"]) ? `${first(r, ["acctnumber"])} ` : ""}${first(r, ["accountsearchdisplayname", "fullname", "acctname", "name"])}`.trim(), type: first(r, ["accounttype", "accttype"]),
  }));
  const items = (await pick("SELECT * FROM item WHERE itemType = 'Service' AND isInactive = 'F'")).map((r) => ({ id: s(r.id), name: first(r, ["itemid", "displayname", "name"]) }));
  const taxCodes = (await pick("SELECT * FROM salesTaxItem WHERE isInactive = 'F'")).map((r) => ({ id: s(r.id), name: first(r, ["itemid", "name", "displayname"]) }));
  const subsidiaries = (await pick("SELECT * FROM subsidiary WHERE isElimination = 'F'")).map((r) => ({ id: s(r.id), name: first(r, ["name", "fullname"]) }));
  const ok = (x: { id: string; name: string }) => isValidNsId(x.id) && !!x.name;
  return { accounts: accounts.filter(ok), items: items.filter(ok), taxCodes: taxCodes.filter(ok), subsidiaries: subsidiaries.filter(ok) };
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

  // ---- scheduled sync ----------------------------------------------------
  if (body.action === "cron") {
    const secret = Deno.env.get("CRON_SECRET");
    if (!secret || req.headers.get("X-Cron-Secret") !== secret) return json({ error: "Forbidden" }, 403);
    const due = new Date(Date.now() - 14 * 60_000).toISOString();
    const { data: conns } = await admin
      .from("ns_connections")
      .select(CONN_COLS)
      .eq("status", "connected")
      .eq("auto_sync", true)
      .or(`last_synced_at.is.null,last_synced_at.lt.${due}`)
      .order("last_synced_at", { ascending: true, nullsFirst: true })
      .limit(5);
    background((async () => {
      for (const c of (conns ?? []) as ConnRow[]) {
        const runId = await beginRun(admin, c, "scheduled");
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
  const { data: allowed } = await caller.rpc("can_manage_netsuite");
  if (allowed !== true) return json({ error: "You don't have permission to manage NetSuite sync." }, 403);

  const loadConn = async (id: unknown): Promise<ConnRow | null> => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data } = await admin.from("ns_connections").select(CONN_COLS).eq("id", id).eq("user_id", ownerId).maybeSingle();
    return (data as ConnRow | null) ?? null;
  };

  if (body.action === "run" || body.action === "resync") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    if (conn.status === "disconnected") return json({ error: "NetSuite is disconnected." }, 409);
    const runId = await beginRun(admin, conn, "manual");
    if (!runId) return json({ error: "A sync is already running." }, 409);
    // Full re-read: merge is idempotent, so this only repairs; it never duplicates or overwrites unchanged data.
    if (body.action === "resync") {
      await admin.from("ns_connections").update({ cursors: {} }).eq("id", conn.id);
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
    for (const e of NS_ENTITIES) {
      const sig = (s: NsSettings) => JSON.stringify([s.entities[e].enabled, s.entities[e].direction, s.entities[e].fields]);
      if (!old.ok || sig(old.settings) !== sig(v.settings)) delete cursors[e];
    }
    const update: Record<string, unknown> = { settings: v.settings, cursors };
    if (typeof body.auto_sync === "boolean") update.auto_sync = body.auto_sync;
    const { error } = await admin.from("ns_connections").update(update).eq("id", conn.id);
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
      return json({ error: err instanceof NsAuthError ? "Reconnect NetSuite and try again." : "Could not load NetSuite lists." }, 502);
    }
  }

  if (body.action === "disconnect") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    // NetSuite tokens can only be revoked inside NetSuite (Setup → Users/Roles → Access Tokens). We delete our copy.
    await admin.from("ns_connection_secrets").delete().eq("connection_id", conn.id);
    await admin.from("ns_record_links").delete().eq("connection_id", conn.id);
    await admin.from("ns_connections").update({ status: "disconnected", cursors: {}, last_error: null, sync_locked_until: null }).eq("id", conn.id);
    await mirrorIntegration(admin, conn, "disconnected", { error_code: "manual_disconnect" });
    return json({ ok: true });
  }

  if (body.action === "resolve_conflict") {
    const winner = body.winner === "vireek" || body.winner === "ns" ? body.winner : null;
    if (!winner || typeof body.link_id !== "string") return json({ error: "Invalid request." }, 400);
    const { data: link } = await admin.from("ns_record_links").select(`${LINK_COLS}, connection_id`).eq("id", body.link_id).eq("user_id", ownerId).maybeSingle();
    if (!link) return json({ error: "Conflict not found." }, 404);
    const conn = await loadConn((link as { connection_id: string }).connection_id);
    if (!conn || conn.status !== "connected") return json({ error: "NetSuite is not connected." }, 409);
    if (!(await acquireLock(admin, conn.id))) return json({ error: "A sync is running. Try again in a moment." }, 409);
    let ctx: Ctx | null = null;
    try {
      ctx = await buildCtx(admin, conn, null, Date.now() + 60_000);
      const l = link as unknown as LinkRow;
      if (l.entity === "payment") return json({ error: "Payments are never edited. Void the payment in Vireek if it is wrong." }, 400);
      const ruleOverride = winner === "vireek" ? "vireek_wins" : "ns_wins";
      const note = `Conflict resolved (kept ${winner === "vireek" ? "Vireek" : "NetSuite"})`;
      const raw = await fetchNs(ctx, l.entity, l.external_id);
      let result: Outcome;
      if (l.entity === "invoice") {
        const v = await loadInvoice(ctx, l.vireek_id);
        const p = raw ? parseNsInvoice(raw) : null;
        if (!v || !p || !p.ok) return json({ error: "One of the two records no longer exists or cannot be compared." }, 410);
        result = await reconcileInvoice(ctx, l, v, p.doc, { ruleOverride, note });
      } else {
        const vRow = await getVireekRow(ctx, l.entity, l.vireek_id);
        if (!vRow || !raw) return json({ error: "One of the two records no longer exists." }, 410);
        result = await reconcile(ctx, l.entity, l, vRow, raw, { ruleOverride, note });
      }
      await flushLogs(ctx);
      return result === "error" ? json({ error: "Could not apply that choice. See the sync log." }, 502) : json({ ok: true });
    } catch (err) {
      console.error("ns resolve_conflict failed", err instanceof Error ? err.message : err);
      return json({ error: err instanceof NsAuthError ? "Reconnect NetSuite and try again." : "Could not resolve this conflict." }, 502);
    } finally {
      await admin.from("ns_connections").update({ sync_locked_until: null }).eq("id", conn.id);
      if (ctx) await flushLogs(ctx);
    }
  }

  return json({ error: "Unknown action." }, 400);
});
