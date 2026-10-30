// supabase/functions/intacct-sync-run/index.ts
//
// Two-way sync of GL accounts, customers, invoices and payments with Sage Intacct.
// *** NOT LIVE-VERIFIED: developed against an in-memory mock only (see _shared/intacct/engine.ts). ***
// Mirrors qbo-sync-run: same actions, same three-way field merge, same safety rules.
//
// Actions (POST JSON):
//   { action: "run",              connection_id }                       -> 202 { run_id }
//   { action: "resync",           connection_id }                       -> 202 { run_id }  re-read everything (idempotent)
//   { action: "save_settings",    connection_id, settings, auto_sync? } -> { ok, settings }
//   { action: "options",          connection_id }                       -> { accounts, banks }  live lists for the mapping UI
//   { action: "disconnect",       connection_id }                       -> { ok }
//   { action: "resolve_conflict", link_id, winner: "vireek"|"intacct" } -> { ok }
//   { action: "cron" } + header X-Cron-Secret                           -> 202  scheduled sync of all due connections
//
// SECRETS: see intacct-connect/index.ts. Schedule with the pg_cron snippet at the end of
// supabase/migrations/20271231130000_sage_intacct_sync.sql.
// Deploy: supabase functions deploy intacct-sync-run --no-verify-jwt   (cron sends X-Cron-Secret; user actions verify the JWT in code)
//
// HOW A RUN WORKS (order: accounts, customers, invoices, payments; each: PULL then PUSH)
//   PULL = keyset pages of Intacct records changed since the last pass (resumable cursor),
//   PUSH = Vireek records changed since the last push cursor. `reconcile` is a field-level three-way merge
//   against the base snapshot on the link, so only fields that changed since the last sync move.
//
// IDEMPOTENCY AND RETRIES
//   - Every create is find-before-create on a deterministic key (see ops.ts); a lost response is recovered
//     on the next run without duplicating. Writes are never blindly retried after a network error / 5xx.
//   - Reads and provably-rejected requests (429, throttle fault, expired session) retry with backoff.
//   - A failing record is logged and skipped; only auth failures and rate limits abort the run.
//
// SAFETY
//   - Tenant scope: ownerId comes from get_account_owner_id() (or the connection row for cron) and is applied to every query.
//   - Money documents go through the existing general-ledger functions (balanced, period-locked). An invoice
//     with payments is never re-itemised or voided automatically. Posted Intacct invoices are never edited or
//     reversed by sync (only the due date is pushed). Deletes are never propagated. Payments are create-only.
//   - Credentials are AES-GCM encrypted at rest and only sent to allow-listed *.intacct.com hosts.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  ENTITY_META, IA_ENTITIES, PAGE_CAP_PER_RUN, PULL_OVERLAP_MS, VIREEK_FIELDS,
  accountTypeFromIntacct, canCreateInIntacct, canCreateInVireek, decryptSecret, defaultSettings, emptyStats, encryptSecret, escapeLike, field,
  generatedAccountCode, intacctToCanon, invoiceAmountSig, isRecordNo, mergeEntity, mergeFieldsFor, normalBalanceFor, normalizeValue,
  paymentLinkKey, paymentMethodFromName, parseIaInvoice, parseIaPayment, parseIaTimestamp, recordMeta, validateSettings, vireekIdFromRef,
  type Canon, type IaEntity, type IaInvoiceDoc, type IaSettings, type InvoiceLine, type RawRecord, type SyncStats, type VireekAccountType,
} from "../_shared/intacct/engine.ts";
import { IaAuthError, IaOpError, IaThrottleError, IaTransportError, IntacctClient, type IaSession } from "../_shared/intacct/client.ts";
import { ensureAccount, ensureCustomer, ensureInvoice, ensurePayment, fetchLines, findRecords, getRecord, listOptions, pullPage, updateAccount, updateCustomer, updateInvoiceDue } from "../_shared/intacct/ops.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;
// deno-lint-ignore no-explicit-any
type AnyClient = SupabaseClient<any, any, any>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const RUN_BUDGET_MS = 110_000;
const LOCK_MS = 6 * 60_000;
const LOG_RETENTION_DAYS = 30;
const PUSH_PAGE = 100;
const RETRY_CAP = 200;

// ============================================================
// TYPES
// ============================================================

interface PullState { since: string | null; after: number; passStarted: string | null; retry?: string[] }
interface PushState { ts: string | null; id: string | null; retry?: string[] }
interface EntityCursor { pull?: PullState; push?: PushState }
interface ConnRow { id: string; user_id: string; company_id: string; entity_id: string | null; status: string; settings: unknown; cursors: Record<string, EntityCursor> | null }
interface LinkRow { id: string; entity: IaEntity; vireek_id: string; external_id: string; base: Canon; conflict: { fields: string[]; sig: string; reason?: string } | null }
type VRow = Record<string, unknown> & { id: string; updated_at?: string };
type Outcome = "ok" | "conflict" | "error" | "skipped";
type Simple = "account" | "customer";

interface LogEntry {
  entity: IaEntity; direction: "to_intacct" | "from_intacct" | "both" | "none";
  action: "created" | "updated" | "linked" | "voided" | "conflict" | "skipped" | "error";
  vireek_id?: string | null; external_id?: string | null; link_id?: string | null; message: string; details?: unknown; rid?: string | null;
}
interface Ctx {
  admin: AnyClient; conn: ConnRow; ownerId: string; client: IntacctClient; settings: IaSettings; cursors: Record<string, EntityCursor>;
  runId: string | null; stats: SyncStats; logs: Record<string, unknown>[]; deadline: number; lastProgressAt: number; warned: Set<string>;
  acctTypeByNo?: Map<string, string>; acctVireekByNo?: Map<string, string>; acctNoByVireek?: Map<string, string>;
}

// ============================================================
// LOG / RUN BOOKKEEPING
// ============================================================

function log(ctx: Ctx, e: LogEntry) {
  ctx.logs.push({
    user_id: ctx.ownerId, connection_id: ctx.conn.id, run_id: ctx.runId, entity: e.entity, direction: e.direction, action: e.action,
    vireek_id: e.vireek_id ?? null, external_id: e.external_id ?? null, link_id: e.link_id ?? null, message: e.message.slice(0, 500), details: e.details ?? null, request_id: e.rid ?? null,
  });
}
async function flushLogs(ctx: Ctx) {
  if (!ctx.logs.length) return;
  const rows = ctx.logs.splice(0);
  const { error } = await ctx.admin.from("intacct_sync_log").insert(rows);
  if (error) console.error("intacct-sync log insert failed", error.message);
}
async function touchRun(ctx: Ctx, force = false) {
  if (!ctx.runId) return;
  if (!force && Date.now() - ctx.lastProgressAt < 3000) return;
  ctx.lastProgressAt = Date.now();
  await ctx.admin.from("intacct_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
  if (ctx.logs.length >= 40) await flushLogs(ctx);
}
const overDeadline = (ctx: Ctx) => Date.now() > ctx.deadline;
const warnOnce = (ctx: Ctx, key: string, e: LogEntry) => { if (!ctx.warned.has(key)) { ctx.warned.add(key); log(ctx, e); } };

/** Run one record's work. Auth failures and rate limits abort the run; anything else is logged and the run continues. */
async function guard<T>(ctx: Ctx, entity: IaEntity, ids: { vireek?: string | null; external?: string | null }, label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IaAuthError || err instanceof IaThrottleError) throw err;
    ctx.stats.errors++;
    const unknown = err instanceof IaTransportError && err.unknownOutcome;
    log(ctx, { entity, direction: "none", action: "error", vireek_id: ids.vireek, external_id: ids.external, rid: ctx.client.lastControlId, message: `${label}: ${err instanceof Error ? err.message : "unexpected error"}${unknown ? " It will be re-checked on the next run, so nothing is duplicated." : ""}` });
    return undefined;
  }
}

// ============================================================
// VIREEK-SIDE HELPERS
// ============================================================

const COLS: Record<Simple, string> = {
  account: "id, code, name, type, is_active, is_system, updated_at",
  customer: "id, name, email, phone, address, notes, updated_at",
};
const INVOICE_COLS = "id, customer_id, invoice_number, status, issue_date, due_date, subtotal_cents, tax_cents, total_cents, amount_paid_cents, updated_at";
const PAYMENT_COLS = "id, invoice_id, amount_cents, payment_date, payment_method, deposit_account_id, created_at";

function vireekCanon(entity: Simple, r: VRow): Canon {
  return entity === "customer"
    ? { name: r.name as string, email: r.email as string, phone: r.phone as string, address: r.address as string, notes: r.notes as string }
    : { code: r.code as string, name: r.name as string, active: r.is_active === false ? "inactive" : "active" };
}
function toColumns(entity: Simple, v: Canon): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(v, k);
  if (entity === "customer") { for (const k of ["name", "email", "phone", "address", "notes"]) if (has(k)) out[k] = v[k]; }
  else { if (has("code")) out.code = v.code; if (has("name")) out.name = v.name; if (has("active")) out.is_active = v.active !== "inactive"; }
  return out;
}
const tsOf = (r: VRow): number | null => (r.updated_at ? parseIaTimestamp(r.updated_at as string) ?? Date.parse(r.updated_at as string) : null);
const stripMeta = (b: Canon | null): Canon | null => (b ? Object.fromEntries(Object.entries(b).filter(([k]) => !k.startsWith("__"))) : null);
const conflictSig = (fields: string[], v: Canon, q: Canon) => JSON.stringify([fields, fields.map((f) => [v[f] ?? null, q[f] ?? null])]);
const addRetry = (list: string[] | undefined, id: string): string[] => [...new Set([...(list ?? []), id])].slice(-RETRY_CAP);

async function getVireekRow(ctx: Ctx, entity: Simple, id: string): Promise<VRow | null> {
  const { data } = await ctx.admin.from(ENTITY_META[entity].table).select(COLS[entity]).eq("id", id).eq("user_id", ctx.ownerId).maybeSingle();
  return (data as VRow | null) ?? null;
}

// ---- links ----
const LINK_COLS = "id, entity, vireek_id, external_id, base, conflict";
async function getLinkByExternal(ctx: Ctx, entity: IaEntity, externalId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin.from("intacct_record_links").select(LINK_COLS).eq("connection_id", ctx.conn.id).eq("entity", entity).eq("external_id", externalId).maybeSingle();
  return (data as LinkRow | null) ?? null;
}
async function getLinkByVireek(ctx: Ctx, entity: IaEntity, vireekId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin.from("intacct_record_links").select(LINK_COLS).eq("connection_id", ctx.conn.id).eq("entity", entity).eq("vireek_id", vireekId).maybeSingle();
  return (data as LinkRow | null) ?? null;
}
async function createLink(ctx: Ctx, entity: IaEntity, vireekId: string, externalId: string, base: Canon): Promise<LinkRow | null> {
  const { data, error } = await ctx.admin.from("intacct_record_links").insert({ user_id: ctx.ownerId, connection_id: ctx.conn.id, entity, vireek_id: vireekId, external_id: externalId, base }).select(LINK_COLS).single();
  if (error) { console.error("intacct link insert failed", error.message); return null; }
  if (entity === "account") ctx.acctTypeByNo = undefined;
  return data as LinkRow;
}
async function saveLink(ctx: Ctx, link: LinkRow, patch: { base?: Canon; conflict?: LinkRow["conflict"] }) {
  await ctx.admin.from("intacct_record_links").update({ ...patch, last_synced_at: new Date().toISOString() }).eq("id", link.id);
  if (link.entity === "account") ctx.acctTypeByNo = undefined;
}

/** Linked GL accounts: account number -> Vireek type / Vireek id (and the reverse). Cached per run. */
async function loadAccountMaps(ctx: Ctx) {
  if (ctx.acctTypeByNo && ctx.acctVireekByNo && ctx.acctNoByVireek) return;
  const types = new Map<string, string>(); const byNo = new Map<string, string>(); const byV = new Map<string, string>();
  const { data } = await ctx.admin.from("intacct_record_links").select("vireek_id, base").eq("connection_id", ctx.conn.id).eq("entity", "account");
  for (const l of (data ?? []) as { vireek_id: string; base: Canon }[]) {
    const code = typeof l.base?.code === "string" ? l.base.code : null;
    if (!code) continue;
    byNo.set(code, l.vireek_id); byV.set(l.vireek_id, code);
    if (typeof l.base.__type === "string") types.set(code, l.base.__type);
  }
  ctx.acctTypeByNo = types; ctx.acctVireekByNo = byNo; ctx.acctNoByVireek = byV;
}

// ============================================================
// SIMPLE ENTITIES: accounts, customers
// ============================================================

async function applyVireekUpdate(ctx: Ctx, entity: Simple, id: string, values: Canon): Promise<string | null> {
  const cols = toColumns(entity, values);
  if (!Object.keys(cols).length) return null;
  const { error } = await ctx.admin.from(ENTITY_META[entity].table).update(cols).eq("id", id).eq("user_id", ctx.ownerId);
  return error ? error.message : null;
}

async function reconcile(ctx: Ctx, entity: Simple, link: LinkRow | null, vRow: VRow, raw: RawRecord, opts: { ruleOverride?: "vireek_wins" | "intacct_wins"; note?: string } = {}): Promise<Outcome> {
  const es = ctx.settings.entities[entity];
  const meta = recordMeta(raw);
  const vC = vireekCanon(entity, vRow);
  const iC = intacctToCanon(entity, raw);
  const res = mergeEntity({ entity, settings: es, base: stripMeta(link?.base ?? null), vireek: vC, intacct: iC, vireekTs: tsOf(vRow), intacctTs: meta.modifiedAt, ruleOverride: opts.ruleOverride });
  const next: Canon = { ...res.next };
  let failed = false;

  if (Object.keys(res.toVireek).length) {
    const err = await applyVireekUpdate(ctx, entity, vRow.id, res.toVireek);
    if (err) {
      failed = true; ctx.stats.errors++;
      log(ctx, { entity, direction: "from_intacct", action: "error", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `Could not update Vireek: ${err}` });
      for (const k of Object.keys(res.toVireek)) next[k] = link?.base?.[k] ?? null;
    } else {
      ctx.stats.updated_vireek++;
      log(ctx, { entity, direction: "from_intacct", action: "updated", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: opts.note ?? `Updated from Sage Intacct (${Object.keys(res.toVireek).join(", ")})`, details: res.toVireek });
    }
  }
  if (Object.keys(res.toCrm).length) {
    try {
      if (entity === "customer") await updateCustomer(ctx.client, raw, res.toCrm);
      else await updateAccount(ctx.client, raw, res.toCrm);
      ctx.stats.updated_intacct++;
      log(ctx, { entity, direction: "to_intacct", action: "updated", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: opts.note ?? `Updated in Sage Intacct (${Object.keys(res.toCrm).join(", ")})`, details: res.toCrm });
    } catch (err) {
      if (err instanceof IaAuthError || err instanceof IaThrottleError) throw err;
      failed = true; ctx.stats.errors++;
      log(ctx, { entity, direction: "to_intacct", action: "error", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, rid: ctx.client.lastControlId, message: `Sage Intacct rejected the update: ${err instanceof Error ? err.message : "error"}` });
      for (const k of Object.keys(res.toCrm)) next[k] = link?.base?.[k] ?? null;
    }
  }
  let conflict: LinkRow["conflict"] = null;
  if (res.conflicts.length) {
    const fields = res.conflicts.map((c) => c.field);
    const sig = conflictSig(fields, vC, iC);
    conflict = { fields, sig };
    if (link?.conflict?.sig !== sig) {
      ctx.stats.conflicts++;
      log(ctx, { entity, direction: "none", action: "conflict", vireek_id: vRow.id, external_id: meta.id, link_id: link?.id, message: `Both sides changed: ${fields.join(", ")}`, details: res.conflicts });
    }
  }
  const base: Canon = { ...next, ...(entity === "account" ? { __type: String(vRow.type) } : {}) };
  if (link) await saveLink(ctx, link, { base, conflict });
  else await createLink(ctx, entity, vRow.id, meta.id, base);
  return failed ? "error" : conflict ? "conflict" : "ok";
}

async function findVireekMatch(ctx: Ctx, entity: Simple, iC: Canon): Promise<VRow | null> {
  const t = ENTITY_META[entity].table;
  const q = (col: string, val: string) => ctx.admin.from(t).select(COLS[entity]).eq("user_id", ctx.ownerId).ilike(col, escapeLike(val)).limit(1).maybeSingle();
  let row: unknown = null;
  if (entity === "customer") {
    if (iC.email) row = (await q("email", String(iC.email))).data;
    if (!row && iC.name) row = (await q("name", String(iC.name))).data;
  } else {
    if (iC.code) row = (await ctx.admin.from(t).select(COLS[entity]).eq("user_id", ctx.ownerId).eq("code", String(iC.code)).limit(1).maybeSingle()).data;
    if (!row && iC.name) row = (await q("name", String(iC.name))).data;
  }
  const r = row as VRow | null;
  if (!r) return null;
  return (await getLinkByVireek(ctx, entity, r.id)) ? null : r;
}

async function createVireekRow(ctx: Ctx, entity: Simple, raw: RawRecord, iC: Canon): Promise<{ row?: VRow; error?: string; skip?: string }> {
  const meta = recordMeta(raw);
  let insert: Record<string, unknown>;
  if (entity === "customer") {
    if (!iC.name) return { skip: "Customer has no name." };
    insert = { ...toColumns("customer", iC), user_id: ctx.ownerId, source: "import", lifecycle_stage: "active", customer_type: "residential" };
  } else {
    const type = accountTypeFromIntacct(raw);
    if (!type || !iC.name) return { skip: "Account type could not be determined (needs statement type and normal balance)." };
    insert = { ...toColumns("account", iC), user_id: ctx.ownerId, code: iC.code ?? generatedAccountCode(meta.id), type, normal_balance: normalBalanceFor(type), is_system: false };
  }
  let { data, error } = await ctx.admin.from(ENTITY_META[entity].table).insert(insert).select(COLS[entity]).single();
  if (error && entity === "account" && /duplicate|unique/i.test(error.message)) {
    ({ data, error } = await ctx.admin.from(ENTITY_META[entity].table).insert({ ...insert, code: generatedAccountCode(meta.id) }).select(COLS[entity]).single());
  }
  if (error || !data) return { error: error?.message ?? "insert failed" };
  return { row: data as unknown as VRow };
}

async function applyIntacctRecord(ctx: Ctx, entity: Simple, raw: RawRecord): Promise<void> {
  const es = ctx.settings.entities[entity];
  const meta = recordMeta(raw);
  if (!meta.id) return;
  const iC = intacctToCanon(entity, raw);
  const link = await getLinkByExternal(ctx, entity, meta.id);
  if (link) {
    const vRow = await getVireekRow(ctx, entity, link.vireek_id);
    if (!vRow) {
      warnOnce(ctx, `gone:${link.id}`, { entity, direction: "none", action: "skipped", vireek_id: link.vireek_id, external_id: meta.id, link_id: link.id, message: "Deleted in Vireek: not recreated and not changed in Sage Intacct." });
      ctx.stats.skipped++;
      return;
    }
    await reconcile(ctx, entity, link, vRow, raw);
    return;
  }
  const match = await findVireekMatch(ctx, entity, iC);
  if (match) {
    const out = await reconcile(ctx, entity, null, match, raw, { note: "Matched an existing record" });
    if (out !== "error") log(ctx, { entity, direction: "both", action: "linked", vireek_id: match.id, external_id: meta.id, message: "Linked to the matching record" });
    return;
  }
  if (!canCreateInVireek(es)) { ctx.stats.skipped++; return; }
  const made = await createVireekRow(ctx, entity, raw, iC);
  if (made.skip) { ctx.stats.skipped++; log(ctx, { entity, direction: "from_intacct", action: "skipped", external_id: meta.id, message: made.skip }); return; }
  if (made.error || !made.row) { ctx.stats.errors++; log(ctx, { entity, direction: "from_intacct", action: "error", external_id: meta.id, message: `Could not create in Vireek: ${made.error}` }); return; }
  const merged = mergeEntity({ entity, settings: es, base: null, vireek: vireekCanon(entity, made.row), intacct: iC, vireekTs: null, intacctTs: null });
  await createLink(ctx, entity, made.row.id, meta.id, { ...merged.next, ...(entity === "account" ? { __type: String(made.row.type) } : {}) });
  ctx.stats.created_vireek++;
  log(ctx, { entity, direction: "from_intacct", action: "created", vireek_id: made.row.id, external_id: meta.id, message: `Created from Sage Intacct: ${String(iC.name ?? meta.id).slice(0, 80)}` });
}

function vireekChangedSinceBase(entity: Simple, link: LinkRow, row: VRow, es: IaSettings["entities"][Simple]): boolean {
  const v = vireekCanon(entity, row);
  const base = link.base ?? {};
  return mergeFieldsFor(entity, es).some((f) => normalizeValue(f.type, v[f.key]) !== normalizeValue(f.type, base[f.key]));
}

async function createInIntacct(ctx: Ctx, entity: Simple, row: VRow): Promise<void> {
  const es = ctx.settings.entities[entity];
  const vC = vireekCanon(entity, row);
  const label = String(vC.name ?? row.id).slice(0, 80);
  const values: Canon = {};
  for (const f of mergeFieldsFor(entity, es)) if (f.direction !== "from_crm") values[f.key] = vC[f.key] ?? null;
  if (entity === "customer" && !values.name) values.name = vC.name;
  if (entity === "account") { values.code = vC.code; values.name = vC.name; }
  const made = entity === "customer"
    ? await ensureCustomer(ctx.client, { vireekId: row.id, values })
    : await ensureAccount(ctx.client, { values, type: String(row.type) as VireekAccountType });
  const m = recordMeta(made.record);
  const out = await reconcile(ctx, entity, null, row, made.record, { note: made.created ? "Created in Sage Intacct" : "Matched an existing Sage Intacct record" });
  if (made.created) {
    ctx.stats.created_intacct++;
    log(ctx, { entity, direction: "to_intacct", action: "created", vireek_id: row.id, external_id: m.id, message: `Created in Sage Intacct: ${label}` });
  } else if (out !== "error") log(ctx, { entity, direction: "both", action: "linked", vireek_id: row.id, external_id: m.id, message: `Linked to existing Sage Intacct record: ${label}` });
}

async function pullSimple(ctx: Ctx, entity: Simple): Promise<boolean> {
  const cur = ctx.cursors[entity]?.pull ?? { since: null, after: 0, passStarted: null };
  const passStarted = cur.passStarted ?? new Date().toISOString();
  const since = cur.since ? Date.parse(cur.since) - PULL_OVERLAP_MS : null;
  let after = cur.after || 0;
  let seen = 0;
  for (;;) {
    if (overDeadline(ctx)) { ctx.cursors[entity] = { ...ctx.cursors[entity], pull: { since: cur.since, after, passStarted } }; return false; }
    const page = await pullPage(ctx.client, entity, { since, afterRecordNo: after });
    for (const raw of page.records) await guard(ctx, entity, { external: recordMeta(raw).id }, "Could not apply a Sage Intacct record", () => applyIntacctRecord(ctx, entity, raw));
    seen += page.records.length;
    after = page.maxRecordNo;
    await touchRun(ctx);
    if (!page.more) { ctx.cursors[entity] = { ...ctx.cursors[entity], pull: { since: passStarted, after: 0, passStarted: null } }; return true; }
    if (seen >= PAGE_CAP_PER_RUN) { ctx.cursors[entity] = { ...ctx.cursors[entity], pull: { since: cur.since, after, passStarted } }; return false; }
  }
}

async function pushSimple(ctx: Ctx, entity: Simple, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities[entity];
  if (es.direction === "from_intacct") return;
  const t = ENTITY_META[entity].table;
  let cur: PushState = ctx.cursors[entity]?.push ?? { ts: null, id: null };
  const handle = async (row: VRow) => {
    const link = await getLinkByVireek(ctx, entity, row.id);
    if (link) {
      if (!vireekChangedSinceBase(entity, link, row, es) && !link.conflict) return;
      const raw = await getRecord(ctx.client, entity, link.external_id);
      if (!raw) {
        warnOnce(ctx, `qgone:${link.id}`, { entity, direction: "none", action: "skipped", vireek_id: row.id, external_id: link.external_id, link_id: link.id, message: "Deleted in Sage Intacct: not recreated and not changed in Vireek." });
        return;
      }
      await reconcile(ctx, entity, link, row, raw);
    } else if (canCreateInIntacct(es) && pullDoneOnce) {
      await createInIntacct(ctx, entity, row);
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
      await guard(ctx, entity, { vireek: row.id }, "Could not sync a Vireek record", () => handle(row));
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

interface VInvoice { row: VRow; lines: (InvoiceLine & { revenueAccountId: string | null })[] }

async function loadInvoice(ctx: Ctx, id: string): Promise<VInvoice | null> {
  const { data } = await ctx.admin.from("ar_invoices").select(INVOICE_COLS).eq("id", id).eq("user_id", ctx.ownerId).maybeSingle();
  if (!data) return null;
  const { data: ls } = await ctx.admin.from("ar_invoice_lines").select("description, quantity, unit_price_cents, amount_cents, revenue_account_id").eq("invoice_id", id).order("line_number");
  const lines = ((ls ?? []) as Record<string, unknown>[]).map((l) => ({
    description: String(l.description ?? ""), qty: Number(l.quantity ?? 1), unitPriceCents: Number(l.unit_price_cents ?? 0), amountCents: Number(l.amount_cents ?? 0), accountNo: null as string | null,
    revenueAccountId: (l.revenue_account_id as string | null) ?? null,
  }));
  return { row: data as VRow, lines };
}
function invoiceVireekCanon(v: VInvoice): Canon {
  const voided = v.row.status === "void";
  return { due_date: v.row.due_date as string, amounts: voided ? null : invoiceAmountSig({ lines: v.lines, taxCents: Number(v.row.tax_cents), totalCents: Number(v.row.total_cents) }), voided: voided ? "void" : "active" };
}
const invoiceIntacctCanon = (d: IaInvoiceDoc): Canon => ({ due_date: d.dueDate, amounts: d.voided ? null : invoiceAmountSig(d), voided: d.voided ? "void" : "active" });

async function linesJson(ctx: Ctx, lines: InvoiceLine[]) {
  await loadAccountMaps(ctx);
  return lines.map((l) => ({ description: l.description, quantity: l.qty, unit_price_cents: l.unitPriceCents, amount_cents: l.amountCents, revenue_account_id: (l.accountNo && ctx.acctVireekByNo!.get(l.accountNo)) || null }));
}
const isPaymentsBlock = (msg: string) => /PAYMENTS_EXIST/.test(msg);
async function relabel(ctx: Ctx, type: "ar_invoice" | "ar_payment", id: string) {
  await ctx.admin.rpc("intacct_relabel_je", { p_owner: ctx.ownerId, p_source_type: type, p_source_id: id });
}

/** Parse an Intacct invoice header with its lines (one extra request, or none when `lines` is supplied). */
async function parseInvoice(ctx: Ctx, raw: RawRecord, lines?: RawRecord[]) {
  await loadAccountMaps(ctx);
  const no = field(raw, "RECORDNO") ?? "";
  const ls = lines ?? ((await fetchLines(ctx.client, "invoiceLine", [no])).get(no) ?? []);
  return parseIaInvoice(raw, ls, ctx.settings.defaults, ctx.acctTypeByNo);
}

async function reconcileInvoice(ctx: Ctx, link: LinkRow | null, v: VInvoice, doc: IaInvoiceDoc, opts: { ruleOverride?: "vireek_wins" | "intacct_wins"; note?: string } = {}): Promise<Outcome> {
  const es = ctx.settings.entities.invoice;
  const vC = invoiceVireekCanon(v);
  const iC = invoiceIntacctCanon(doc);
  const res = mergeEntity({ entity: "invoice", settings: es, base: stripMeta(link?.base ?? null), vireek: vC, intacct: iC, vireekTs: tsOf(v.row), intacctTs: doc.modifiedAt, ruleOverride: opts.ruleOverride });
  const next: Canon = { ...res.next };
  const blocked: string[] = []; const reasons: string[] = [];
  let failed = false;
  const id = v.row.id; const ext = doc.id;
  const fail = (direction: "to_intacct" | "from_intacct", message: string) => {
    failed = true; ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction, action: "error", vireek_id: id, external_id: ext, link_id: link?.id, rid: ctx.client.lastControlId, message });
  };
  const block = (f: string, reason: string) => { blocked.push(f); reasons.push(reason); };

  // ---- reversal ----
  if (res.toVireek.voided === "void") {
    const { error } = await ctx.admin.rpc("qbo_void_ar_invoice", { p_owner: ctx.ownerId, p_invoice_id: id });
    if (error) {
      if (isPaymentsBlock(error.message)) block("voided", "Reversed in Sage Intacct, but Vireek has payments on this invoice. Void or refund the payments in Vireek first.");
      else fail("from_intacct", `Could not void in Vireek: ${error.message}`);
    } else {
      await relabel(ctx, "ar_invoice", id);
      ctx.stats.updated_vireek++;
      log(ctx, { entity: "invoice", direction: "from_intacct", action: "voided", vireek_id: id, external_id: ext, link_id: link?.id, message: "Voided to match the reversal in Sage Intacct" });
    }
  }
  if (res.toCrm.voided === "void") block("voided", "Voided in Vireek. Sync never reverses a posted invoice in Sage Intacct: reverse it there, then choose Keep Sage Intacct.");
  const voidedNow = vC.voided === "void" || iC.voided === "void" || res.toVireek.voided === "void";

  // ---- amounts ----
  if (!voidedNow && typeof res.toVireek.amounts === "string") {
    const { error } = await ctx.admin.rpc("qbo_replace_ar_invoice", { p_owner: ctx.ownerId, p_invoice_id: id, p_issue_date: doc.txnDate, p_due_date: doc.dueDate, p_tax_cents: doc.taxCents, p_lines: await linesJson(ctx, doc.lines) });
    if (error) {
      if (isPaymentsBlock(error.message)) block("amounts", "Amounts changed in Sage Intacct after a payment was recorded in Vireek. Review it, then choose which side to keep.");
      else fail("from_intacct", `Could not apply Sage Intacct amounts: ${error.message}`);
    } else {
      await relabel(ctx, "ar_invoice", id);
      ctx.stats.updated_vireek++;
      log(ctx, { entity: "invoice", direction: "from_intacct", action: "updated", vireek_id: id, external_id: ext, link_id: link?.id, message: "Line amounts and totals updated from Sage Intacct" });
    }
  }
  if (!voidedNow && typeof res.toCrm.amounts === "string") block("amounts", "Amounts changed in Vireek after this invoice was posted in Sage Intacct. Sync does not edit posted invoices: correct it in Sage Intacct, then choose Keep Sage Intacct.");

  // ---- due date (the only field pushed to a posted invoice) ----
  if (!voidedNow && res.toCrm.due_date !== undefined && res.toCrm.due_date !== null) {
    try {
      await updateInvoiceDue(ctx.client, ext, String(res.toCrm.due_date));
      ctx.stats.updated_intacct++;
      log(ctx, { entity: "invoice", direction: "to_intacct", action: "updated", vireek_id: id, external_id: ext, link_id: link?.id, message: "Due date updated in Sage Intacct" });
    } catch (err) {
      if (err instanceof IaAuthError || err instanceof IaThrottleError) throw err;
      block("due_date", `Sage Intacct rejected the due date: ${err instanceof Error ? err.message : "error"}`);
      fail("to_intacct", `Sage Intacct rejected the due date: ${err instanceof Error ? err.message : "error"}`);
    }
  }
  if (res.toVireek.due_date !== undefined && res.toVireek.due_date !== null) {
    const { error } = await ctx.admin.from("ar_invoices").update({ due_date: res.toVireek.due_date }).eq("id", id).eq("user_id", ctx.ownerId);
    if (error) fail("from_intacct", `Could not update the due date: ${error.message}`);
    else ctx.stats.updated_vireek++;
  }

  for (const f of blocked) next[f] = link?.base?.[f] ?? null;
  const fields = [...new Set([...res.conflicts.map((c) => c.field), ...blocked])];
  let conflict: LinkRow["conflict"] = null;
  if (fields.length) {
    const sig = conflictSig(fields, vC, iC);
    conflict = { fields, sig, ...(reasons.length ? { reason: reasons[0] } : {}) };
    if (link?.conflict?.sig !== sig) {
      ctx.stats.conflicts++;
      log(ctx, { entity: "invoice", direction: "none", action: "conflict", vireek_id: id, external_id: ext, link_id: link?.id, message: reasons[0] ?? `Both sides changed: ${fields.join(", ")}`, details: res.conflicts });
    }
  }
  if (link) await saveLink(ctx, link, { base: next, conflict });
  else await createLink(ctx, "invoice", id, ext, next);
  return failed ? "error" : conflict ? "conflict" : "ok";
}

async function applyIntacctInvoice(ctx: Ctx, raw: RawRecord, lines?: RawRecord[]): Promise<"retry" | void> {
  const es = ctx.settings.entities.invoice;
  const no = field(raw, "RECORDNO");
  if (!no) return;
  const parsed = await parseInvoice(ctx, raw, lines);
  if (!parsed.ok) {
    ctx.stats.skipped++;
    warnOnce(ctx, `inv:${no}:${field(raw, "WHENMODIFIED")}`, { entity: "invoice", direction: "from_intacct", action: "skipped", external_id: no, message: `Invoice ${field(raw, "RECORDID") ?? no} skipped: ${parsed.reason}` });
    return;
  }
  const doc = parsed.doc;
  const link = await getLinkByExternal(ctx, "invoice", doc.id);
  if (link) {
    const v = await loadInvoice(ctx, link.vireek_id);
    if (!v) { ctx.stats.skipped++; return; }
    await reconcileInvoice(ctx, link, v, doc);
    return;
  }
  if (doc.voided) return;

  // An invoice Vireek itself sent (its reference is embedded) or one both sides already have is linked, never duplicated.
  let matchId = vireekIdFromRef(doc.ref, "VK-I-");
  if (matchId && !(await loadInvoice(ctx, matchId))) matchId = null;
  if (!matchId && doc.docNumber) {
    const { data } = await ctx.admin.from("ar_invoices").select("id").eq("user_id", ctx.ownerId).eq("invoice_number", doc.docNumber).eq("total_cents", doc.totalCents).maybeSingle();
    matchId = (data as { id: string } | null)?.id ?? null;
  }
  if (matchId && !(await getLinkByVireek(ctx, "invoice", matchId))) {
    const v = await loadInvoice(ctx, matchId);
    if (v) {
      await reconcileInvoice(ctx, null, v, doc, { note: "Matched an existing invoice" });
      log(ctx, { entity: "invoice", direction: "both", action: "linked", vireek_id: v.row.id, external_id: doc.id, message: `Linked to existing invoice ${doc.docNumber ?? doc.id}` });
      return;
    }
  }
  if (!canCreateInVireek(es)) { ctx.stats.skipped++; return; }
  const cust = doc.customerId ? await findCustomerLinkByCustomerId(ctx, doc.customerId) : null;
  if (!cust) {
    warnOnce(ctx, `invcust:${doc.id}`, { entity: "invoice", direction: "from_intacct", action: "skipped", external_id: doc.id, message: `Invoice ${doc.docNumber ?? doc.id} waits for its customer to sync (enable Customers, then Sync now).` });
    return "retry";
  }
  if (doc.totalCents <= 0) { ctx.stats.skipped++; return; }
  const { data: newId, error } = await ctx.admin.rpc("qbo_create_ar_invoice", {
    p_owner: ctx.ownerId, p_customer_id: cust.vireek_id, p_issue_date: doc.txnDate, p_due_date: doc.dueDate, p_tax_cents: doc.taxCents, p_lines: await linesJson(ctx, doc.lines), p_invoice_number: doc.docNumber,
  });
  if (error || !newId) {
    ctx.stats.errors++;
    log(ctx, { entity: "invoice", direction: "from_intacct", action: "error", external_id: doc.id, message: `Could not create invoice ${doc.docNumber ?? doc.id}: ${error?.message ?? "no id"}` });
    return;
  }
  await relabel(ctx, "ar_invoice", newId as string);
  const v = await loadInvoice(ctx, newId as string);
  await createLink(ctx, "invoice", newId as string, doc.id, v ? invoiceVireekCanon(v) : invoiceIntacctCanon(doc));
  ctx.stats.created_vireek++;
  log(ctx, { entity: "invoice", direction: "from_intacct", action: "created", vireek_id: newId as string, external_id: doc.id, message: `Created invoice ${doc.docNumber ?? doc.id} from Sage Intacct` });
}

/** Customer link from an Intacct CUSTOMERID: links are keyed by RECORDNO, so resolve the id through the live record. */
async function findCustomerLinkByCustomerId(ctx: Ctx, customerId: string): Promise<LinkRow | null> {
  const no = field((await findRecords(ctx.client, "customer", "CUSTOMERID", customerId))[0] ?? {}, "RECORDNO");
  return no ? getLinkByExternal(ctx, "customer", no) : null;
}
async function customerIdForLink(ctx: Ctx, link: LinkRow): Promise<string | null> {
  const raw = await getRecord(ctx.client, "customer", link.external_id);
  return raw ? field(raw, "CUSTOMERID") : null;
}

const PUSHABLE = new Set(["sent", "partially_paid", "paid", "overdue"]);

async function createInvoiceInIntacct(ctx: Ctx, v: VInvoice): Promise<"retry" | void> {
  if (!PUSHABLE.has(String(v.row.status))) return;
  const custLink = v.row.customer_id ? await getLinkByVireek(ctx, "customer", String(v.row.customer_id)) : null;
  const customerId = custLink ? await customerIdForLink(ctx, custLink) : null;
  if (!customerId) {
    warnOnce(ctx, `vinvcust:${v.row.id}`, { entity: "invoice", direction: "to_intacct", action: "skipped", vireek_id: v.row.id, message: `Invoice ${String(v.row.invoice_number)} waits for its customer to be linked to Sage Intacct.` });
    return "retry";
  }
  await loadAccountMaps(ctx);
  const lines = v.lines.map((l) => ({ ...l, accountNo: (l.revenueAccountId && ctx.acctNoByVireek!.get(l.revenueAccountId)) || ctx.settings.defaults.revenueAccountNo }));
  const made = await ensureInvoice(ctx.client, {
    vireekId: String(v.row.id), customerId,
    inv: { invoiceNumber: String(v.row.invoice_number), issueDate: String(v.row.issue_date), dueDate: String(v.row.due_date), taxCents: Number(v.row.tax_cents), lines },
    defaults: ctx.settings.defaults,
  });
  if ("error" in made) {
    warnOnce(ctx, `vinvcfg:${v.row.invoice_number}`, { entity: "invoice", direction: "to_intacct", action: "skipped", vireek_id: v.row.id, message: `Invoice ${String(v.row.invoice_number)} not sent: ${made.error}` });
    return "retry";
  }
  const m = recordMeta(made.record);
  const parsed = await parseInvoice(ctx, made.record);
  const existing = await getLinkByExternal(ctx, "invoice", m.id);
  if (existing) return;
  if (!made.created && parsed.ok) {
    await reconcileInvoice(ctx, null, v, parsed.doc, { note: "Matched an existing Sage Intacct invoice" });
    log(ctx, { entity: "invoice", direction: "both", action: "linked", vireek_id: v.row.id, external_id: m.id, message: `Linked to existing Sage Intacct invoice ${String(v.row.invoice_number)}` });
    return;
  }
  await createLink(ctx, "invoice", String(v.row.id), m.id, invoiceVireekCanon(v));
  ctx.stats.created_intacct++;
  log(ctx, { entity: "invoice", direction: "to_intacct", action: "created", vireek_id: String(v.row.id), external_id: m.id, message: `Created invoice ${String(v.row.invoice_number)} in Sage Intacct` });
  if (parsed.ok && parsed.doc.totalCents !== Number(v.row.total_cents)) {
    ctx.stats.conflicts++;
    log(ctx, { entity: "invoice", direction: "to_intacct", action: "conflict", vireek_id: String(v.row.id), external_id: m.id, message: `Sage Intacct total (${parsed.doc.totalCents / 100}) differs from Vireek (${Number(v.row.total_cents) / 100}). Check the tax account under Mapping → Defaults.` });
  }
}

async function pullGeneric(ctx: Ctx, entity: "invoice" | "payment"): Promise<boolean> {
  const cur = ctx.cursors[entity]?.pull ?? { since: null, after: 0, passStarted: null };
  const passStarted = cur.passStarted ?? new Date().toISOString();
  const since = cur.since ? Date.parse(cur.since) - PULL_OVERLAP_MS : null;
  let after = cur.after || 0;
  let seen = 0;
  let retry: string[] = [];
  const kind = entity === "invoice" ? "invoiceLine" : "paymentLine";
  const apply = async (raw: RawRecord, lines: RawRecord[]) => {
    const r = await guard(ctx, entity, { external: field(raw, "RECORDNO") }, `Could not apply a Sage Intacct ${entity}`, () => (entity === "invoice" ? applyIntacctInvoice(ctx, raw, lines) : applyIntacctPayment(ctx, raw, lines)));
    if (r === "retry") retry = addRetry(retry, field(raw, "RECORDNO") ?? "");
  };
  const save = (s: Omit<PullState, "retry">) => { ctx.cursors[entity] = { ...ctx.cursors[entity], pull: { ...s, retry } }; };

  const waiting = (cur.retry ?? []).filter(isRecordNo);
  if (waiting.length) {
    const lines = await fetchLines(ctx.client, kind, waiting);
    for (const id of waiting) { const raw = await getRecord(ctx.client, entity, id); if (raw) await apply(raw, lines.get(id) ?? []); }
  }
  for (;;) {
    if (overDeadline(ctx)) { save({ since: cur.since, after, passStarted }); return false; }
    const page = await pullPage(ctx.client, entity, { since, afterRecordNo: after });
    const lines = await fetchLines(ctx.client, kind, page.records.map((r) => field(r, "RECORDNO") ?? "").filter(isRecordNo));
    for (const raw of page.records) await apply(raw, lines.get(field(raw, "RECORDNO") ?? "") ?? []);
    seen += page.records.length;
    after = page.maxRecordNo;
    await touchRun(ctx);
    if (!page.more) { save({ since: passStarted, after: 0, passStarted: null }); return true; }
    if (seen >= PAGE_CAP_PER_RUN) { save({ since: cur.since, after, passStarted }); return false; }
  }
}

async function pushInvoices(ctx: Ctx, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities.invoice;
  if (es.direction === "from_intacct") return;
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
      const raw = await getRecord(ctx.client, "invoice", link.external_id);
      const p = raw ? await parseInvoice(ctx, raw) : null;
      if (!p || !p.ok) {
        if (p && !p.ok) warnOnce(ctx, `inv:${link.external_id}`, { entity: "invoice", direction: "none", action: "skipped", vireek_id: id, external_id: link.external_id, link_id: link.id, message: `Sage Intacct invoice cannot be compared: ${p.reason}` });
        return;
      }
      await reconcileInvoice(ctx, link, v, p.doc);
      return;
    }
    if (canCreateInIntacct(es) && pullDoneOnce) return createInvoiceInIntacct(ctx, v);
  };
  const stillRetry: string[] = [];
  const run = async (id: string) => { if ((await guard(ctx, "invoice", { vireek: id }, "Could not sync an invoice", () => handle(id))) === "retry") stillRetry.push(id); };
  for (const id of ctx.cursors.invoice?.push?.retry ?? []) await run(id);
  while (!overDeadline(ctx)) {
    let q = ctx.admin.from("ar_invoices").select("id, updated_at").eq("user_id", ctx.ownerId).order("updated_at", { ascending: true }).order("id", { ascending: true }).limit(PUSH_PAGE);
    if (cur.ts) q = q.or(`updated_at.gt.${cur.ts},and(updated_at.eq.${cur.ts},id.gt.${cur.id})`);
    const { data, error } = await q;
    if (error) throw new Error(`Could not read ar_invoices: ${error.message}`);
    const rows = (data ?? []) as VRow[];
    for (const row of rows) {
      if (overDeadline(ctx)) break;
      await run(row.id);
      cur = { ts: row.updated_at ?? cur.ts, id: row.id };
      ctx.cursors.invoice = { ...ctx.cursors.invoice, push: { ...cur, retry: addRetryMany(stillRetry) } };
    }
    await touchRun(ctx);
    if (rows.length < PUSH_PAGE) break;
  }
  ctx.cursors.invoice = { ...ctx.cursors.invoice, push: { ...cur, retry: addRetryMany(stillRetry) } };
}
const addRetryMany = (ids: string[]) => [...new Set(ids)].slice(-RETRY_CAP);

// ============================================================
// PAYMENTS (create-only)
// ============================================================

async function applyIntacctPayment(ctx: Ctx, raw: RawRecord, lines: RawRecord[]): Promise<"retry" | void> {
  const es = ctx.settings.entities.payment;
  const doc = parseIaPayment(raw, lines);
  if (!doc) return;
  if (doc.voided) {
    warnOnce(ctx, `pv:${doc.id}`, { entity: "payment", direction: "from_intacct", action: "skipped", external_id: doc.id, message: "Payment reversed in Sage Intacct. Payments are never reversed automatically: void it in Vireek if needed." });
    return;
  }
  if (!canCreateInVireek(es)) return;
  // A payment Vireek itself sent carries its id in the document number: link it, never record it twice.
  const own = vireekIdFromRef(doc.docNumber, "VK-P-");
  if (own) {
    const { data: ex } = await ctx.admin.from("ar_payments").select("id").eq("id", own).eq("user_id", ctx.ownerId).maybeSingle();
    if (ex) {
      for (const app of doc.applications) {
        const key = paymentLinkKey(doc.id, app.invoiceNo);
        if (!(await getLinkByExternal(ctx, "payment", key)) && !(await getLinkByVireek(ctx, "payment", own))) await createLink(ctx, "payment", own, key, {});
      }
      return;
    }
  }
  let retry = false;
  for (const app of doc.applications) {
    const key = paymentLinkKey(doc.id, app.invoiceNo);
    if (await getLinkByExternal(ctx, "payment", key)) continue;
    const invLink = await getLinkByExternal(ctx, "invoice", app.invoiceNo);
    if (!invLink) {
      warnOnce(ctx, `pi:${key}`, { entity: "payment", direction: "from_intacct", action: "skipped", external_id: key, message: `Payment ${doc.id} waits for its invoice to sync.` });
      retry = true;
      continue;
    }
    const inv = await loadInvoice(ctx, invLink.vireek_id);
    if (!inv || inv.row.status === "void") continue;
    const remaining = Number(inv.row.total_cents) - Number(inv.row.amount_paid_cents);
    if (app.amountCents > remaining) {
      ctx.stats.errors++;
      log(ctx, { entity: "payment", direction: "from_intacct", action: "error", external_id: key, vireek_id: inv.row.id, message: `Payment of ${app.amountCents / 100} exceeds the Vireek balance of ${remaining / 100}. Not recorded.` });
      continue;
    }
    const { data: payId, error } = await ctx.admin.rpc("qbo_record_ar_payment", {
      p_owner: ctx.ownerId, p_invoice_id: inv.row.id, p_amount_cents: app.amountCents, p_method: paymentMethodFromName(doc.methodName), p_date: doc.txnDate, p_deposit_account_id: null,
    });
    if (error || !payId) {
      ctx.stats.errors++;
      log(ctx, { entity: "payment", direction: "from_intacct", action: "error", external_id: key, vireek_id: inv.row.id, message: `Could not record the payment: ${error?.message ?? "no id"}` });
      continue;
    }
    await relabel(ctx, "ar_payment", inv.row.id);
    await createLink(ctx, "payment", payId as string, key, {});
    ctx.stats.created_vireek++;
    log(ctx, { entity: "payment", direction: "from_intacct", action: "created", vireek_id: payId as string, external_id: key, message: `Recorded payment of ${app.amountCents / 100} from Sage Intacct` });
  }
  return retry ? "retry" : undefined;
}

async function pushPayments(ctx: Ctx, pullDoneOnce: boolean): Promise<void> {
  const es = ctx.settings.entities.payment;
  if (!canCreateInIntacct(es) || !pullDoneOnce) return;
  let cur: PushState = ctx.cursors.payment?.push ?? { ts: null, id: null };
  const stillRetry: string[] = [];
  const handle = async (p: VRow): Promise<"retry" | void> => {
    if (await getLinkByVireek(ctx, "payment", p.id)) return;
    const bank = ctx.settings.defaults.bankAccountId;
    if (!bank) {
      warnOnce(ctx, "no-bank", { entity: "payment", direction: "none", action: "skipped", message: "Payments were not sent to Sage Intacct: choose a bank account under Mapping → Defaults." });
      ctx.stats.skipped++;
      return "retry";
    }
    const invLink = await getLinkByVireek(ctx, "invoice", String(p.invoice_id));
    const { data: inv } = await ctx.admin.from("ar_invoices").select("customer_id, status, invoice_number").eq("id", p.invoice_id).eq("user_id", ctx.ownerId).maybeSingle();
    const invRow = inv as unknown as VRow | null;
    if (!invRow || invRow.status === "void") return;
    const custLink = invRow.customer_id ? await getLinkByVireek(ctx, "customer", String(invRow.customer_id)) : null;
    const customerId = custLink ? await customerIdForLink(ctx, custLink) : null;
    if (!invLink || !customerId) {
      warnOnce(ctx, `vp:${p.id}`, { entity: "payment", direction: "to_intacct", action: "skipped", vireek_id: p.id, message: `Payment on invoice ${String(invRow.invoice_number)} waits for the invoice and customer to be linked to Sage Intacct.` });
      return "retry";
    }
    const made = await ensurePayment(ctx.client, {
      vireekId: p.id, customerId, invoiceNo: invLink.external_id, amountCents: Number(p.amount_cents), date: String(p.payment_date), bankAccountId: bank,
      method: (["card", "ach", "check", "cash"].includes(String(p.payment_method)) ? String(p.payment_method) : "other") as "card" | "ach" | "check" | "cash" | "other", memo: `Vireek payment ${p.id}`,
    });
    await createLink(ctx, "payment", p.id, paymentLinkKey(recordMeta(made.record).id, invLink.external_id), {});
    if (made.created) {
      ctx.stats.created_intacct++;
      log(ctx, { entity: "payment", direction: "to_intacct", action: "created", vireek_id: p.id, external_id: recordMeta(made.record).id, message: `Sent payment of ${Number(p.amount_cents) / 100} to Sage Intacct` });
    } else log(ctx, { entity: "payment", direction: "both", action: "linked", vireek_id: p.id, external_id: recordMeta(made.record).id, message: "Linked to the payment already in Sage Intacct" });
  };
  const run = async (p: VRow) => { if ((await guard(ctx, "payment", { vireek: p.id }, "Could not send a payment", () => handle(p))) === "retry") stillRetry.push(p.id); };
  for (const id of ctx.cursors.payment?.push?.retry ?? []) {
    const { data } = await ctx.admin.from("ar_payments").select(PAYMENT_COLS).eq("id", id).eq("user_id", ctx.ownerId).maybeSingle();
    if (data) await run(data as VRow);
  }
  while (!overDeadline(ctx)) {
    let q = ctx.admin.from("ar_payments").select(PAYMENT_COLS).eq("user_id", ctx.ownerId).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(PUSH_PAGE);
    if (cur.ts) q = q.or(`created_at.gt.${cur.ts},and(created_at.eq.${cur.ts},id.gt.${cur.id})`);
    const { data, error } = await q;
    if (error) throw new Error(`Could not read ar_payments: ${error.message}`);
    const rows = (data ?? []) as VRow[];
    for (const row of rows) {
      if (overDeadline(ctx)) break;
      await run(row);
      cur = { ts: String(row.created_at), id: row.id };
      ctx.cursors.payment = { ...ctx.cursors.payment, push: { ...cur, retry: addRetryMany(stillRetry) } };
    }
    await touchRun(ctx);
    if (rows.length < PUSH_PAGE) break;
  }
  ctx.cursors.payment = { ...ctx.cursors.payment, push: { ...cur, retry: addRetryMany(stillRetry) } };
}

// ============================================================
// RUN LIFECYCLE
// ============================================================

async function acquireLock(admin: AnyClient, connId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await admin.from("intacct_connections").update({ sync_locked_until: new Date(Date.now() + LOCK_MS).toISOString() }).eq("id", connId).or(`sync_locked_until.is.null,sync_locked_until.lt.${now}`).select("id");
  return (data?.length ?? 0) > 0;
}

async function buildCtx(admin: AnyClient, conn: ConnRow, runId: string | null, deadline: number): Promise<Ctx> {
  const encKey = Deno.env.get("INTACCT_ENCRYPTION_KEY") ?? "";
  const senderId = Deno.env.get("INTACCT_SENDER_ID") ?? "";
  const senderPassword = Deno.env.get("INTACCT_SENDER_PASSWORD") ?? "";
  const { data: sec } = await admin.from("intacct_connection_secrets").select("credentials_enc, session_enc, session_endpoint, session_expires_at").eq("connection_id", conn.id).maybeSingle();
  if (!sec || !encKey || !senderId || !senderPassword) throw new IaAuthError("No stored credentials. Please reconnect.");
  const valid = validateSettings(conn.settings && Object.keys(conn.settings as object).length ? conn.settings : defaultSettings());
  if (!valid.ok) throw new Error(`Saved settings are invalid: ${valid.error}`);
  let creds: { userId: string; password: string };
  try { creds = JSON.parse(await decryptSecret(sec.credentials_enc as string, encKey)); } catch { throw new IaAuthError("Stored credentials could not be read. Please reconnect."); }
  let session: IaSession | null = null;
  try {
    if (sec.session_enc && sec.session_endpoint && sec.session_expires_at) session = { id: await decryptSecret(sec.session_enc as string, encKey), endpoint: sec.session_endpoint as string, expiresAt: Date.parse(sec.session_expires_at as string) };
  } catch { session = null; }
  const client = new IntacctClient({
    senderId, senderPassword, credentials: { companyId: conn.company_id, userId: creds.userId, password: creds.password, entityId: conn.entity_id }, session,
    onSession: async (s) => {
      await admin.from("intacct_connection_secrets").update(s
        ? { session_enc: await encryptSecret(s.id, encKey), session_endpoint: s.endpoint, session_expires_at: new Date(s.expiresAt).toISOString(), updated_at: new Date().toISOString() }
        : { session_enc: null, session_endpoint: null, session_expires_at: null, updated_at: new Date().toISOString() }).eq("connection_id", conn.id);
    },
  });
  return { admin, conn, ownerId: conn.user_id, client, settings: valid.settings, cursors: { ...(conn.cursors ?? {}) }, runId, stats: emptyStats(), logs: [], deadline, lastProgressAt: 0, warned: new Set() };
}

async function mirrorIntegration(admin: AnyClient, conn: ConnRow, status: "connected" | "error" | "disconnected", extra: Record<string, unknown> = {}) {
  await admin.from("integrations").upsert({ user_id: conn.user_id, integration_type: "sage_intacct", status, config: { company_id: conn.company_id, entity_id: conn.entity_id, ...extra } }, { onConflict: "user_id,integration_type" });
}

async function executeRun(admin: AnyClient, conn: ConnRow, runId: string) {
  let ctx: Ctx | null = null;
  let status: "success" | "partial" | "failed" = "success";
  let error: string | null = null;
  let markError = false;
  let allFinished = true;

  try {
    await admin.from("intacct_sync_log").delete().eq("connection_id", conn.id).lt("created_at", new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString());
    ctx = await buildCtx(admin, conn, runId, Date.now() + RUN_BUDGET_MS);
    let dependenciesDone = true;
    for (const entity of IA_ENTITIES) {
      const es = ctx.settings.entities[entity];
      if (!es.enabled) continue;
      if (overDeadline(ctx)) { allFinished = false; break; }
      if ((entity === "invoice" || entity === "payment") && !dependenciesDone) { allFinished = false; continue; }
      let finished: boolean;
      if (es.direction === "to_intacct") finished = true;
      else if (entity === "invoice" || entity === "payment") finished = await pullGeneric(ctx, entity);
      else finished = await pullSimple(ctx, entity);
      if (!finished) { allFinished = false; if (entity !== "invoice" && entity !== "payment") dependenciesDone = false; }
      const pullDoneOnce = es.direction === "to_intacct" || !!ctx.cursors[entity]?.pull?.since;
      if (entity === "invoice") await pushInvoices(ctx, pullDoneOnce);
      else if (entity === "payment") await pushPayments(ctx, pullDoneOnce);
      else await pushSimple(ctx, entity, pullDoneOnce);
    }
    if (!allFinished || overDeadline(ctx)) { status = "partial"; error = "Large sync in progress. It will continue automatically on the next run."; }
    if (ctx.stats.errors > 0 && status === "success") status = "partial";
  } catch (err) {
    status = "failed";
    if (err instanceof IaAuthError) { markError = true; error = `Sage Intacct needs to be reconnected: ${err.message}`.slice(0, 400); }
    else if (err instanceof IaThrottleError) { status = "partial"; error = "Sage Intacct is rate limiting requests. The sync will retry on the next run."; }
    else if (err instanceof IaTransportError) { status = "partial"; error = "Could not reach Sage Intacct. The sync will retry on the next run."; }
    else { error = err instanceof Error ? err.message.slice(0, 400) : "Unexpected sync error."; console.error("intacct-sync-run failed", conn.id, err); }
  } finally {
    if (ctx) {
      await flushLogs(ctx);
      if (ctx.runId) await admin.from("intacct_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
    }
    await admin.from("intacct_sync_runs").update({ status, error, finished_at: new Date().toISOString(), ...(ctx ? { stats: ctx.stats } : {}) }).eq("id", runId);
    await admin.from("intacct_connections").update({
      sync_locked_until: null,
      ...(ctx ? { cursors: ctx.cursors } : {}),
      ...(markError ? { status: "error" } : {}),
      ...(status === "failed" ? { last_error: error } : { last_error: status === "partial" ? error : null, last_synced_at: new Date().toISOString() }),
    }).eq("id", conn.id);
    if (markError) await mirrorIntegration(admin, conn, "error", { error_message: error, failed_at: new Date().toISOString() });
    else if (status !== "failed") await mirrorIntegration(admin, conn, "connected", { last_synced_at: new Date().toISOString() });
  }
}

async function beginRun(admin: AnyClient, conn: ConnRow, trigger: "manual" | "scheduled"): Promise<string | null> {
  if (!(await acquireLock(admin, conn.id))) return null;
  await admin.from("intacct_sync_runs").update({ status: "failed", error: "Interrupted.", finished_at: new Date().toISOString() }).eq("connection_id", conn.id).eq("status", "running").lt("started_at", new Date(Date.now() - 10 * 60_000).toISOString());
  const { data } = await admin.from("intacct_sync_runs").insert({ user_id: conn.user_id, connection_id: conn.id, trigger, status: "running" }).select("id").single();
  if (!data) { await admin.from("intacct_connections").update({ sync_locked_until: null }).eq("id", conn.id); return null; }
  return data.id as string;
}

const background = (p: Promise<unknown>) => { if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(p); else void p; };
const CONN_COLS = "id, user_id, company_id, entity_id, status, settings, cursors";

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

  if (body.action === "cron") {
    const secret = Deno.env.get("CRON_SECRET");
    if (!secret || req.headers.get("X-Cron-Secret") !== secret) return json({ error: "Forbidden" }, 403);
    const due = new Date(Date.now() - 14 * 60_000).toISOString();
    const { data: conns } = await admin.from("intacct_connections").select(CONN_COLS).eq("status", "connected").eq("auto_sync", true).or(`last_synced_at.is.null,last_synced_at.lt.${due}`).order("last_synced_at", { ascending: true, nullsFirst: true }).limit(5);
    background((async () => {
      for (const c of (conns ?? []) as ConnRow[]) {
        const runId = await beginRun(admin, c, "scheduled");
        if (runId) await executeRun(admin, c, runId);
      }
    })());
    return json({ queued: conns?.length ?? 0 }, 202);
  }

  const authHeaderValue = req.headers.get("Authorization");
  if (!authHeaderValue) return json({ error: "Missing Authorization header" }, 401);
  const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authHeaderValue } }, auth: { persistSession: false } });
  const { data: userData } = await caller.auth.getUser();
  if (!userData?.user) return json({ error: "Not authenticated" }, 401);
  const { data: ownerData } = await caller.rpc("get_account_owner_id");
  if (!ownerData) return json({ error: "Could not resolve your account." }, 401);
  const ownerId = ownerData as string;
  const { data: allowed } = await caller.rpc("can_manage_intacct");
  if (allowed !== true) return json({ error: "You don't have permission to manage Sage Intacct sync." }, 403);

  const loadConn = async (id: unknown): Promise<ConnRow | null> => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data } = await admin.from("intacct_connections").select(CONN_COLS).eq("id", id).eq("user_id", ownerId).maybeSingle();
    return (data as ConnRow | null) ?? null;
  };

  if (body.action === "run" || body.action === "resync") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    if (conn.status === "disconnected") return json({ error: "Sage Intacct is disconnected." }, 409);
    const runId = await beginRun(admin, conn, "manual");
    if (!runId) return json({ error: "A sync is already running." }, 409);
    if (body.action === "resync") {
      await admin.from("intacct_connections").update({ cursors: {} }).eq("id", conn.id);
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
    const cursors = { ...(conn.cursors ?? {}) };
    const old = validateSettings(conn.settings && Object.keys(conn.settings as object).length ? conn.settings : defaultSettings());
    for (const e of IA_ENTITIES) {
      const sig = (s: IaSettings) => JSON.stringify([s.entities[e].enabled, s.entities[e].direction, s.entities[e].fields]);
      if (!old.ok || sig(old.settings) !== sig(v.settings)) delete cursors[e];
    }
    const update: Record<string, unknown> = { settings: v.settings, cursors };
    if (typeof body.auto_sync === "boolean") update.auto_sync = body.auto_sync;
    const { error } = await admin.from("intacct_connections").update(update).eq("id", conn.id);
    if (error) return json({ error: "Could not save settings." }, 500);
    return json({ ok: true, settings: v.settings });
  }

  if (body.action === "options") {
    const conn = await loadConn(body.connection_id);
    if (!conn || conn.status === "disconnected") return json({ error: "Connection not found." }, 404);
    try {
      const ctx = await buildCtx(admin, conn, null, Date.now() + 30_000);
      return json(await listOptions(ctx.client));
    } catch (err) {
      return json({ error: err instanceof IaAuthError ? "Reconnect Sage Intacct and try again." : "Could not load Sage Intacct lists." }, 502);
    }
  }

  if (body.action === "disconnect") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    await admin.from("intacct_connection_secrets").delete().eq("connection_id", conn.id);
    await admin.from("intacct_record_links").delete().eq("connection_id", conn.id);
    await admin.from("intacct_connections").update({ status: "disconnected", cursors: {}, last_error: null, sync_locked_until: null }).eq("id", conn.id);
    await mirrorIntegration(admin, conn, "disconnected", { error_code: "manual_disconnect" });
    return json({ ok: true });
  }

  if (body.action === "resolve_conflict") {
    const winner = body.winner === "vireek" || body.winner === "intacct" ? body.winner : null;
    if (!winner || typeof body.link_id !== "string") return json({ error: "Invalid request." }, 400);
    const { data: link } = await admin.from("intacct_record_links").select(`${LINK_COLS}, connection_id`).eq("id", body.link_id).eq("user_id", ownerId).maybeSingle();
    if (!link) return json({ error: "Conflict not found." }, 404);
    const conn = await loadConn((link as { connection_id: string }).connection_id);
    if (!conn || conn.status !== "connected") return json({ error: "Sage Intacct is not connected." }, 409);
    if (!(await acquireLock(admin, conn.id))) return json({ error: "A sync is running. Try again in a moment." }, 409);
    let ctx: Ctx | null = null;
    try {
      ctx = await buildCtx(admin, conn, null, Date.now() + 60_000);
      const l = link as unknown as LinkRow;
      const ruleOverride = winner === "vireek" ? "vireek_wins" : "intacct_wins";
      const note = `Conflict resolved (kept ${winner === "vireek" ? "Vireek" : "Sage Intacct"})`;
      if (l.entity === "payment") return json({ error: "Payments are never edited. Void the payment in Vireek if it is wrong." }, 400);
      const raw = await getRecord(ctx.client, l.entity, l.external_id);
      let result: Outcome;
      if (l.entity === "invoice") {
        const v = await loadInvoice(ctx, l.vireek_id);
        const p = raw ? await parseInvoice(ctx, raw) : null;
        if (!v || !p || !p.ok) return json({ error: "One of the two records no longer exists or cannot be compared." }, 410);
        result = await reconcileInvoice(ctx, l, v, p.doc, { ruleOverride, note });
      } else {
        const vRow = await getVireekRow(ctx, l.entity as Simple, l.vireek_id);
        if (!vRow || !raw) return json({ error: "One of the two records no longer exists." }, 410);
        result = await reconcile(ctx, l.entity as Simple, l, vRow, raw, { ruleOverride, note });
      }
      await flushLogs(ctx);
      return result === "error" ? json({ error: "Could not apply that choice. See the sync log." }, 502) : json({ ok: true });
    } catch (err) {
      console.error("intacct resolve_conflict failed", err);
      return json({ error: err instanceof IaAuthError ? "Reconnect Sage Intacct and try again." : "Could not resolve this conflict." }, 502);
    } finally {
      await admin.from("intacct_connections").update({ sync_locked_until: null }).eq("id", conn.id);
      if (ctx) await flushLogs(ctx);
    }
  }

  return json({ error: "Unknown action." }, 400);
});
