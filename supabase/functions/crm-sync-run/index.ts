// supabase/functions/crm-sync-run/index.ts
//
// Two-way sync of contacts, leads and deals with Salesforce, Pipedrive and Zoho CRM.
//
// Actions (POST JSON):
//   { action: "run",              connection_id }                 -> 202 { run_id }   manual "Sync now"
//   { action: "save_settings",    connection_id, settings, auto_sync? } -> { ok, settings }
//   { action: "disconnect",       connection_id }                 -> { ok }
//   { action: "resolve_conflict", link_id, winner: "vireek"|"crm" } -> { ok }
//   { action: "cron" }  + header X-Cron-Secret                    -> 202   scheduled sync of all due connections
//
// REQUIRED SECRETS: see crm-oauth-start/index.ts (CRM_TOKEN_ENCRYPTION_KEY, CRON_SECRET,
// <PROVIDER>_CLIENT_ID / <PROVIDER>_CLIENT_SECRET). Schedule with the pg_cron snippet at the
// bottom of supabase/migrations/20270503000000_crm_sync.sql.
//
// Deploy: supabase functions deploy crm-sync-run --no-verify-jwt
//   (pg_cron calls it with X-Cron-Secret and no JWT; every other action verifies the user's JWT in code.)
//
// HOW A RUN WORKS (per enabled entity: contact, lead, deal)
//   1. PULL  changed CRM records (watermark / resumable cursor) and reconcile each one.
//   2. PUSH  changed Vireek records and reconcile each one against the live CRM record.
//   `reconcile` is a field-level THREE-WAY merge against the base snapshot stored on the link, so
//   only fields that changed since the last sync move, formatting-only differences never cause a
//   write, and our own writes never echo back. Conflicts follow the entity's rule (newest / Vireek /
//   CRM / manual review).
//
// SAFETY
//   - Tenant scope: ownerId comes from get_account_owner_id() (or the connection row for cron) and
//     is applied to every query, on top of the service-role client.
//   - Vireek records are only CREATED IN THE CRM after the first full pull of that entity finished,
//     so an unfinished import can't create duplicates of records it hasn't seen yet.
//   - Deletes are never propagated in either direction.
//   - Tokens are AES-GCM encrypted at rest and only ever sent to allow-listed provider hosts.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  CRM_CAPS,
  CRM_ENTITIES,
  ENTITY_META,
  PAGE_CAP_PER_RUN,
  PROVIDER_META,
  PULL_OVERLAP_MS,
  buildCreateRequest,
  buildCrmPayload,
  buildGetRequest,
  buildListRequest,
  buildTokenRequest,
  buildUpdateRequest,
  coerceValue,
  decryptSecret,
  emptyStats,
  encryptSecret,
  escapeLike,
  isAllowedApiBase,
  normalizeValue,
  parseGetResponse,
  parseListResponse,
  parseWriteResponse,
  recordMeta,
  threeWayMerge,
  toCanonical,
  validateSettings,
  vireekField,
  type Canon,
  type ConflictRule,
  type CrmEntity,
  type CrmProvider,
  type CrmSettings,
  type EntitySettings,
  type MergeField,
  type RawRecord,
  type SyncStats,
} from "../_shared/crm/engine.ts";

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

class AuthError extends Error {}
class RateLimitError extends Error {}

// ============================================================
// TYPES
// ============================================================

interface PullState {
  since: string | null;
  resume: string | null;
  passStarted: string | null;
  progress: string | null;
}
interface PushState {
  ts: string | null;
  id: string | null;
}
interface EntityCursor {
  pull?: PullState;
  push?: PushState;
}
interface ConnRow {
  id: string;
  user_id: string;
  provider: CrmProvider;
  status: string;
  api_base: string;
  settings: unknown;
  cursors: Record<string, EntityCursor> | null;
}
interface LinkRow {
  id: string;
  entity: CrmEntity;
  vireek_id: string;
  external_id: string;
  base: Canon;
  conflict: { fields: string[]; sig: string } | null;
}
type VRow = Record<string, unknown> & { id: string; updated_at?: string };

interface LogEntry {
  entity: CrmEntity;
  direction: "to_crm" | "from_crm" | "both" | "none";
  action: "created" | "updated" | "linked" | "conflict" | "skipped" | "error";
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
  provider: CrmProvider;
  apiBase: string;
  settings: CrmSettings;
  cursors: Record<string, EntityCursor>;
  runId: string | null;
  stats: SyncStats;
  logs: Record<string, unknown>[];
  deadline: number;
  access: string;
  refresh: string | null;
  authBase?: string;
  lastProgressAt: number;
  warned: Set<string>;
}

// ============================================================
// VIREEK-SIDE HELPERS
// ============================================================

const COLS: Record<CrmEntity, string> = {
  contact: "id, name, email, phone, address, notes, created_at, updated_at",
  lead: "id, name, email, phone, service_interested, notes, quote_amount, created_at, updated_at",
  deal: "id, title, amount, currency, status, stage, close_date, created_at, updated_at",
};

const mergeFields = (entity: CrmEntity, es: EntitySettings): MergeField[] =>
  es.mapping.map((m) => {
    const vf = vireekField(entity, m.vireek)!;
    return { key: m.vireek, type: vf.type, direction: m.direction, required: vf.required };
  });

function vireekCanon(entity: CrmEntity, es: EntitySettings, row: VRow): Canon {
  const out: Canon = {};
  for (const m of es.mapping) out[m.vireek] = coerceValue(vireekField(entity, m.vireek)!.type, row[m.vireek]);
  return out;
}

function baseFrom(entity: CrmEntity, es: EntitySettings, values: Canon): Canon {
  const out: Canon = {};
  for (const m of es.mapping) out[m.vireek] = normalizeValue(vireekField(entity, m.vireek)!.type, values[m.vireek]);
  return out;
}

const tsOf = (row: VRow): number | null => {
  const ms = Date.parse(String(row.updated_at ?? row.created_at ?? ""));
  return Number.isNaN(ms) ? null : ms;
};

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
  const { error } = await ctx.admin.from("crm_sync_log").insert(rows);
  if (error) console.error("crm-sync log insert failed", error.message);
}

async function touchRun(ctx: Ctx, force = false) {
  if (!ctx.runId) return;
  if (!force && Date.now() - ctx.lastProgressAt < 3000) return;
  ctx.lastProgressAt = Date.now();
  await ctx.admin.from("crm_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
  if (ctx.logs.length >= 40) await flushLogs(ctx);
}

const overDeadline = (ctx: Ctx) => Date.now() > ctx.deadline;

// ============================================================
// CRM HTTP (token refresh, retry, rate limits)
// ============================================================

function authHeader(provider: CrmProvider, token: string) {
  return provider === "zoho" ? `Zoho-oauthtoken ${token}` : `Bearer ${token}`;
}

async function persistTokens(ctx: Ctx, encKey: string, expiresInSec: number | null) {
  await ctx.admin
    .from("crm_connection_secrets")
    .update({
      access_token_enc: await encryptSecret(ctx.access, encKey),
      refresh_token_enc: ctx.refresh ? await encryptSecret(ctx.refresh, encKey) : null,
      expires_at: expiresInSec ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("connection_id", ctx.conn.id);
}

async function refreshAccess(ctx: Ctx) {
  const encKey = Deno.env.get("CRM_TOKEN_ENCRYPTION_KEY") ?? "";
  const envName = ctx.provider.toUpperCase();
  if (!ctx.refresh) throw new AuthError("No refresh token stored.");
  const reqInfo = buildTokenRequest(ctx.provider, "refresh", {
    clientId: Deno.env.get(`${envName}_CLIENT_ID`) ?? "",
    clientSecret: Deno.env.get(`${envName}_CLIENT_SECRET`) ?? "",
    refreshToken: ctx.refresh,
    authBase: ctx.authBase,
  });
  const res = await fetch(reqInfo.url, { method: "POST", headers: reqInfo.headers, body: reqInfo.body });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 429) throw new RateLimitError("Token endpoint rate limited.");
  if (!res.ok || !j.access_token) throw new AuthError(String(j.error_description ?? j.error ?? "Refresh failed."));
  ctx.access = String(j.access_token);
  if (typeof j.refresh_token === "string" && j.refresh_token) ctx.refresh = j.refresh_token; // Pipedrive rotates it
  const exp = Number(j.expires_in);
  await persistTokens(ctx, encKey, Number.isFinite(exp) && exp > 0 ? exp : null);
}

async function api(ctx: Ctx, req: { method: string; url: string; headers?: Record<string, string>; body?: unknown }) {
  if (!req.url.startsWith(`${ctx.apiBase}/`) || !isAllowedApiBase(ctx.provider, ctx.apiBase)) {
    throw new Error("Refusing to call an address outside the connected CRM.");
  }
  let refreshed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: {
          Authorization: authHeader(ctx.provider, ctx.access),
          Accept: "application/json",
          ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(req.headers ?? {}),
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
    if (res.status === 401) throw new AuthError("The CRM rejected our credentials.");
    if (res.status === 429) throw new RateLimitError("The CRM is rate limiting requests.");
    if (res.status >= 500 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const text = res.status === 204 || res.status === 304 ? "" : await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, json: body };
  }
  throw new Error("CRM request failed.");
}

async function fetchCrmRecord(ctx: Ctx, entity: CrmEntity, es: EntitySettings, id: string): Promise<RawRecord | null> {
  const r = await api(ctx, buildGetRequest(ctx.provider, entity, ctx.apiBase, id, es.mapping));
  if (r.status === 404) return null;
  if (r.status >= 400) throw new Error(`${PROVIDER_META[ctx.provider].label} returned ${r.status} while reading a record.`);
  return parseGetResponse(ctx.provider, r.json);
}

// ============================================================
// LINKS + VIREEK RECORDS
// ============================================================

async function getLinkByExternal(ctx: Ctx, entity: CrmEntity, externalId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin
    .from("crm_record_links")
    .select("id, entity, vireek_id, external_id, base, conflict")
    .eq("connection_id", ctx.conn.id)
    .eq("entity", entity)
    .eq("external_id", externalId)
    .maybeSingle();
  return (data as LinkRow | null) ?? null;
}

async function getLinkByVireek(ctx: Ctx, entity: CrmEntity, vireekId: string): Promise<LinkRow | null> {
  const { data } = await ctx.admin
    .from("crm_record_links")
    .select("id, entity, vireek_id, external_id, base, conflict")
    .eq("connection_id", ctx.conn.id)
    .eq("entity", entity)
    .eq("vireek_id", vireekId)
    .maybeSingle();
  return (data as LinkRow | null) ?? null;
}

async function createLink(ctx: Ctx, entity: CrmEntity, vireekId: string, externalId: string, base: Canon): Promise<LinkRow | null> {
  const { data, error } = await ctx.admin
    .from("crm_record_links")
    .insert({ user_id: ctx.ownerId, connection_id: ctx.conn.id, entity, vireek_id: vireekId, external_id: externalId, base })
    .select("id, entity, vireek_id, external_id, base, conflict")
    .single();
  if (error) return null; // unique violation = this record is already linked elsewhere
  return data as LinkRow;
}

async function getVireekRow(ctx: Ctx, entity: CrmEntity, id: string): Promise<VRow | null> {
  const { data } = await ctx.admin
    .from(ENTITY_META[entity].table)
    .select(COLS[entity])
    .eq("id", id)
    .eq("user_id", ctx.ownerId)
    .maybeSingle();
  return (data as VRow | null) ?? null;
}

async function findVireekMatch(ctx: Ctx, entity: CrmEntity, values: Canon): Promise<VRow | null> {
  if (entity === "deal") return null;
  const table = ENTITY_META[entity].table;
  const email = typeof values.email === "string" ? values.email : null;
  const phone = typeof values.phone === "string" ? values.phone : null;
  if (email) {
    const { data } = await ctx.admin.from(table).select(COLS[entity]).eq("user_id", ctx.ownerId).ilike("email", escapeLike(email)).limit(1);
    if (data?.[0]) return data[0] as VRow;
  }
  if (phone) {
    const { data } = await ctx.admin.from(table).select(COLS[entity]).eq("user_id", ctx.ownerId).eq("phone", phone).limit(1);
    if (data?.[0]) return data[0] as VRow;
  }
  return null;
}

// ============================================================
// RECONCILE ONE LINKED PAIR
// ============================================================

async function reconcile(
  ctx: Ctx,
  entity: CrmEntity,
  es: EntitySettings,
  link: LinkRow,
  vRow: VRow,
  cRaw: RawRecord,
  opts: { rule?: ConflictRule; note?: string } = {},
): Promise<"changed" | "unchanged" | "conflict" | "error"> {
  const label = PROVIDER_META[ctx.provider].label;
  const canon = toCanonical(ctx.provider, entity, cRaw, es.mapping);
  const m = threeWayMerge({
    fields: mergeFields(entity, es),
    base: link.base ?? {},
    vireek: vireekCanon(entity, es, vRow),
    crm: canon.values,
    rule: opts.rule ?? es.conflict_rule,
    vireekTs: tsOf(vRow),
    crmTs: canon.modifiedAt,
  });

  const toV = Object.keys(m.toVireek);
  const toC = Object.keys(m.toCrm);

  if (toV.length) {
    const { error } = await ctx.admin.from(ENTITY_META[entity].table).update(m.toVireek).eq("id", vRow.id).eq("user_id", ctx.ownerId);
    if (error) {
      ctx.stats.errors++;
      log(ctx, {
        entity, direction: "from_crm", action: "error", vireek_id: vRow.id, external_id: link.external_id, link_id: link.id,
        message: error.code === "23505" ? `Couldn't update Vireek: another record already uses this phone or email (${toV.join(", ")}).` : `Couldn't update Vireek: ${error.message}`,
      });
      return "error";
    }
  }

  if (toC.length) {
    const payload = buildCrmPayload(ctx.provider, entity, m.toCrm, es.mapping, { current: cRaw });
    if (Object.keys(payload).length) {
      const wr = await api(ctx, buildUpdateRequest(ctx.provider, entity, ctx.apiBase, link.external_id, payload));
      const parsed = parseWriteResponse(ctx.provider, wr.status, wr.json);
      if (!parsed.ok) {
        ctx.stats.errors++;
        log(ctx, {
          entity, direction: "to_crm", action: "error", vireek_id: vRow.id, external_id: link.external_id, link_id: link.id,
          message: `${label} rejected the update: ${parsed.error ?? "unknown error"}`,
        });
        return "error";
      }
    }
  }

  const sig = m.conflicts.map((c) => `${c.field}:${c.vireek ?? ""}|${c.crm ?? ""}`).sort().join(";");
  const conflict = m.conflicts.length ? { fields: m.conflicts.map((c) => c.field), sig, at: new Date().toISOString() } : null;
  await ctx.admin
    .from("crm_record_links")
    .update({ base: m.next, conflict, last_synced_at: new Date().toISOString() })
    .eq("id", link.id);

  if (toV.length || toC.length) {
    if (toV.length) ctx.stats.updated_vireek++;
    if (toC.length) ctx.stats.updated_crm++;
    log(ctx, {
      entity,
      direction: toV.length && toC.length ? "both" : toV.length ? "from_crm" : "to_crm",
      action: "updated",
      vireek_id: vRow.id,
      external_id: link.external_id,
      link_id: link.id,
      message: `${opts.note ?? "Updated"}: ${[...toV.map((k) => `${k} ← CRM`), ...toC.map((k) => `${k} → CRM`)].join(", ")}`,
      details: { to_vireek: m.toVireek, to_crm: m.toCrm, resolved: m.resolved },
    });
  }
  if (m.conflicts.length) {
    if (link.conflict?.sig !== sig) {
      ctx.stats.conflicts++;
      log(ctx, {
        entity, direction: "none", action: "conflict", vireek_id: vRow.id, external_id: link.external_id, link_id: link.id,
        message: `Conflict on ${m.conflicts.map((c) => c.field).join(", ")}: both sides changed. Choose which value to keep.`,
        details: { conflicts: m.conflicts },
      });
    }
    return "conflict";
  }
  if (!toV.length && !toC.length) {
    ctx.stats.skipped++;
    return "unchanged";
  }
  return "changed";
}

// ============================================================
// PULL (CRM -> Vireek)
// ============================================================

async function applyCrmRecord(ctx: Ctx, entity: CrmEntity, es: EntitySettings, raw: RawRecord) {
  const meta = recordMeta(ctx.provider, raw);
  if (!meta.id) return;

  const link = await getLinkByExternal(ctx, entity, meta.id);
  if (link) {
    const vRow = await getVireekRow(ctx, entity, link.vireek_id);
    if (!vRow) {
      await ctx.admin.from("crm_record_links").delete().eq("id", link.id);
      ctx.stats.skipped++;
      log(ctx, { entity, direction: "none", action: "skipped", vireek_id: link.vireek_id, external_id: meta.id, message: "The Vireek record was deleted, so the link was removed. Deletes are never synced." });
      return;
    }
    await reconcile(ctx, entity, es, link, vRow, raw);
    return;
  }

  const canon = toCanonical(ctx.provider, entity, raw, es.mapping);

  // Same person already in Vireek? Link instead of duplicating.
  const match = await findVireekMatch(ctx, entity, canon.values);
  if (match) {
    const created = await createLink(ctx, entity, match.id, meta.id, {});
    if (!created) {
      ctx.stats.skipped++;
      log(ctx, { entity, direction: "none", action: "skipped", vireek_id: match.id, external_id: meta.id, message: "Skipped: another CRM record with the same email or phone is already linked to this Vireek record." });
      return;
    }
    log(ctx, { entity, direction: "none", action: "linked", vireek_id: match.id, external_id: meta.id, link_id: created.id, message: "Matched an existing Vireek record by email or phone and linked it." });
    await reconcile(ctx, entity, es, created, match, raw, { note: "Merged on first link" });
    return;
  }

  // New in Vireek.
  const requiredKey = entity === "deal" ? "title" : "name";
  if (!canon.values[requiredKey]) {
    ctx.stats.skipped++;
    log(ctx, { entity, direction: "from_crm", action: "skipped", external_id: meta.id, message: `Skipped: the CRM record has no ${requiredKey}.` });
    return;
  }
  const insert: Record<string, unknown> = { user_id: ctx.ownerId };
  for (const [k, v] of Object.entries(canon.values)) if (v !== null) insert[k] = v;

  const { data, error } = await ctx.admin.from(ENTITY_META[entity].table).insert(insert).select("id").single();
  if (error || !data) {
    if (error?.code === "23505") {
      const dup = await findVireekMatch(ctx, entity, canon.values);
      if (dup) {
        const created = await createLink(ctx, entity, dup.id, meta.id, {});
        if (created) {
          log(ctx, { entity, direction: "none", action: "linked", vireek_id: dup.id, external_id: meta.id, link_id: created.id, message: "Matched an existing Vireek record and linked it." });
          await reconcile(ctx, entity, es, created, dup, raw, { note: "Merged on first link" });
          return;
        }
      }
    }
    ctx.stats.errors++;
    log(ctx, { entity, direction: "from_crm", action: "error", external_id: meta.id, message: `Couldn't create the ${ENTITY_META[entity].vireekLabel.toLowerCase()} record in Vireek: ${error?.message ?? "unknown error"}` });
    return;
  }
  const newLink = await createLink(ctx, entity, data.id as string, meta.id, baseFrom(entity, es, canon.values));
  ctx.stats.created_vireek++;
  log(ctx, { entity, direction: "from_crm", action: "created", vireek_id: data.id as string, external_id: meta.id, link_id: newLink?.id, message: `Imported from ${PROVIDER_META[ctx.provider].label}.` });
}

async function pullEntity(ctx: Ctx, entity: CrmEntity, es: EntitySettings) {
  const st = (ctx.cursors[entity] ??= {});
  const pull: PullState = st.pull ?? { since: null, resume: null, passStarted: null, progress: null };
  if (!pull.resume && !pull.passStarted) pull.passStarted = new Date().toISOString();

  let processed = 0;
  let finished = false;
  while (processed < PAGE_CAP_PER_RUN && !overDeadline(ctx)) {
    const req = buildListRequest({ provider: ctx.provider, entity, base: ctx.apiBase, mapping: es.mapping, since: pull.since, cursor: pull.resume, pageSize: 100 });
    const r = await api(ctx, req);

    // A Salesforce query cursor expires after a while: restart the pass from where we got to.
    if (ctx.provider === "salesforce" && pull.resume && (r.status === 400 || r.status === 404)) {
      pull.resume = null;
      if (pull.progress) pull.since = pull.progress;
      continue;
    }
    if (r.status === 204 || r.status === 304) {
      finished = true;
      break;
    }
    if (r.status >= 400) throw new Error(`${PROVIDER_META[ctx.provider].label} returned ${r.status} while listing ${ENTITY_META[entity].crmLabel[ctx.provider]}.`);

    const page = parseListResponse(ctx.provider, r.json, { cursor: pull.resume });
    let stop = false;
    for (const raw of page.records) {
      const meta = recordMeta(ctx.provider, raw);
      // Pipedrive incremental passes read newest-first: stop at the watermark.
      if (ctx.provider === "pipedrive" && pull.since && meta.modifiedAt !== null && meta.modifiedAt <= Date.parse(pull.since)) {
        stop = true;
        break;
      }
      await applyCrmRecord(ctx, entity, es, raw);
      processed++;
      if (meta.modifiedAt && (!pull.progress || meta.modifiedAt > Date.parse(pull.progress))) pull.progress = new Date(meta.modifiedAt).toISOString();
      await touchRun(ctx);
      if (overDeadline(ctx)) break;
    }
    if (overDeadline(ctx) && !stop && page.next !== null) break; // resume this page next run (idempotent)
    if (stop || page.next === null) {
      finished = true;
      break;
    }
    pull.resume = page.next;
  }

  if (finished) {
    pull.since = new Date(Date.parse(pull.passStarted ?? new Date().toISOString()) - PULL_OVERLAP_MS).toISOString();
    pull.resume = null;
    pull.passStarted = null;
    pull.progress = null;
  }
  st.pull = pull;
  return finished;
}

// ============================================================
// PUSH (Vireek -> CRM)
// ============================================================

function vireekChangedSinceBase(entity: CrmEntity, es: EntitySettings, link: LinkRow, row: VRow): boolean {
  const base = link.base ?? {};
  for (const m of es.mapping) {
    const type = vireekField(entity, m.vireek)!.type;
    if (!Object.prototype.hasOwnProperty.call(base, m.vireek)) return true;
    if (normalizeValue(type, row[m.vireek]) !== normalizeValue(type, base[m.vireek])) return true;
  }
  return false;
}

async function pushEntity(ctx: Ctx, entity: CrmEntity, es: EntitySettings, pullFinishedOnce: boolean) {
  const st = (ctx.cursors[entity] ??= {});
  const push: PushState = st.push ?? { ts: null, id: null };
  const table = ENTITY_META[entity].table;
  const caps = CRM_CAPS[ctx.provider][entity];
  const label = PROVIDER_META[ctx.provider].label;
  let processed = 0;

  while (processed < PAGE_CAP_PER_RUN && !overDeadline(ctx)) {
    let q = ctx.admin.from(table).select(COLS[entity]).eq("user_id", ctx.ownerId);
    if (push.ts) q = q.or(`updated_at.gt.${push.ts},and(updated_at.eq.${push.ts},id.gt.${push.id})`);
    const { data, error } = await q.order("updated_at", { ascending: true }).order("id", { ascending: true }).limit(PUSH_PAGE);
    if (error) throw new Error(`Couldn't read Vireek ${ENTITY_META[entity].vireekLabel.toLowerCase()}: ${error.message}`);
    const rows = (data ?? []) as VRow[];
    if (!rows.length) break;

    for (const row of rows) {
      if (overDeadline(ctx) || processed >= PAGE_CAP_PER_RUN) {
        st.push = push;
        return;
      }
      processed++;
      const link = await getLinkByVireek(ctx, entity, row.id);

      if (link) {
        if (!vireekChangedSinceBase(entity, es, link, row)) {
          ctx.stats.skipped++;
        } else {
          const cRaw = await fetchCrmRecord(ctx, entity, es, link.external_id);
          if (!cRaw) {
            ctx.stats.skipped++;
            log(ctx, { entity, direction: "none", action: "skipped", vireek_id: row.id, external_id: link.external_id, link_id: link.id, message: `The ${label} record no longer exists, so it was left alone. Deletes are never synced.` });
          } else {
            await reconcile(ctx, entity, es, link, row, cRaw);
          }
        }
      } else if (!pullFinishedOnce) {
        // Hold back creates until the first full pull is complete (prevents duplicates).
        // The cursor is NOT advanced past this record, so it is picked up once the pull is done.
        st.push = push;
        return;
      } else if (!caps.create) {
        ctx.stats.skipped++;
        if (!ctx.warned.has(entity)) {
          ctx.warned.add(entity);
          log(ctx, { entity, direction: "to_crm", action: "skipped", message: `${label} doesn't allow creating ${ENTITY_META[entity].crmLabel[ctx.provider]} from Vireek. Existing linked records still sync.` });
        }
      } else if (!es.mapping.some((m) => m.direction !== "from_crm")) {
        ctx.stats.skipped++;
      } else {
        await createInCrm(ctx, entity, es, row);
      }
      push.ts = String(row.updated_at);
      push.id = row.id;
      await touchRun(ctx);
    }
    if (rows.length < PUSH_PAGE) break;
  }
  st.push = push;
}

async function createInCrm(ctx: Ctx, entity: CrmEntity, es: EntitySettings, row: VRow) {
  const label = PROVIDER_META[ctx.provider].label;
  const values = vireekCanon(entity, es, row);
  const requiredKey = entity === "deal" ? "title" : "name";
  if (!values[requiredKey]) {
    ctx.stats.skipped++;
    return;
  }
  const patch: Canon = {};
  for (const [k, v] of Object.entries(values)) if (v !== null) patch[k] = v;
  const payload = buildCrmPayload(ctx.provider, entity, patch, es.mapping, { creating: true });
  const res = await api(ctx, buildCreateRequest(ctx.provider, entity, ctx.apiBase, payload));
  const parsed = parseWriteResponse(ctx.provider, res.status, res.json);

  if (parsed.duplicateOf) {
    const link = await createLink(ctx, entity, row.id, parsed.duplicateOf, {});
    const cRaw = link ? await fetchCrmRecord(ctx, entity, es, parsed.duplicateOf) : null;
    if (link && cRaw) {
      log(ctx, { entity, direction: "none", action: "linked", vireek_id: row.id, external_id: parsed.duplicateOf, link_id: link.id, message: `${label} already had this record, so it was linked instead of duplicated.` });
      await reconcile(ctx, entity, es, link, row, cRaw, { note: "Merged on first link" });
      return;
    }
  }
  if (!parsed.ok || !parsed.id) {
    ctx.stats.errors++;
    log(ctx, { entity, direction: "to_crm", action: "error", vireek_id: row.id, message: `${label} rejected the new record: ${parsed.error ?? "unknown error"}` });
    return;
  }
  const link = await createLink(ctx, entity, row.id, parsed.id, baseFrom(entity, es, values));
  ctx.stats.created_crm++;
  log(ctx, { entity, direction: "to_crm", action: "created", vireek_id: row.id, external_id: parsed.id, link_id: link?.id, message: `Created in ${label}.` });
}

// ============================================================
// RUN LIFECYCLE
// ============================================================

async function acquireLock(admin: AnyClient, connId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await admin
    .from("crm_connections")
    .update({ sync_locked_until: new Date(Date.now() + LOCK_MS).toISOString() })
    .eq("id", connId)
    .or(`sync_locked_until.is.null,sync_locked_until.lt.${now}`)
    .select("id");
  return (data?.length ?? 0) > 0;
}

async function buildCtx(admin: AnyClient, conn: ConnRow, runId: string | null, deadline: number): Promise<Ctx> {
  const encKey = Deno.env.get("CRM_TOKEN_ENCRYPTION_KEY") ?? "";
  const { data: sec } = await admin
    .from("crm_connection_secrets")
    .select("access_token_enc, refresh_token_enc, expires_at, extra")
    .eq("connection_id", conn.id)
    .maybeSingle();
  if (!sec || !encKey) throw new AuthError("No stored credentials. Please reconnect.");

  const valid = validateSettings(conn.provider, conn.settings);
  if (!valid.ok) throw new Error(`Saved settings are invalid: ${valid.error}`);

  const ctx: Ctx = {
    admin,
    conn,
    ownerId: conn.user_id,
    provider: conn.provider,
    apiBase: conn.api_base.replace(/\/+$/, ""),
    settings: valid.settings,
    cursors: { ...(conn.cursors ?? {}) },
    runId,
    stats: emptyStats(),
    logs: [],
    deadline,
    access: await decryptSecret(sec.access_token_enc as string, encKey),
    refresh: sec.refresh_token_enc ? await decryptSecret(sec.refresh_token_enc as string, encKey) : null,
    authBase: ((sec.extra ?? {}) as { auth_base?: string }).auth_base,
    lastProgressAt: 0,
    warned: new Set(),
  };
  if (!isAllowedApiBase(ctx.provider, ctx.apiBase)) throw new Error("Stored CRM address is not allowed.");
  const exp = sec.expires_at ? Date.parse(sec.expires_at as string) : null;
  if (exp !== null && exp - Date.now() < 120_000) await refreshAccess(ctx);
  return ctx;
}

async function executeRun(admin: AnyClient, conn: ConnRow, runId: string) {
  let ctx: Ctx | null = null;
  let status: "success" | "partial" | "failed" = "success";
  let error: string | null = null;
  let markError = false;
  let allFinished = true;

  try {
    await admin.from("crm_sync_log").delete().eq("connection_id", conn.id).lt("created_at", new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString());
    ctx = await buildCtx(admin, conn, runId, Date.now() + RUN_BUDGET_MS);

    for (const entity of CRM_ENTITIES) {
      const es = ctx.settings.entities[entity];
      if (!es.enabled) continue;
      if (overDeadline(ctx)) {
        allFinished = false;
        break;
      }
      const finished = await pullEntity(ctx, entity, es);
      if (!finished) allFinished = false;
      const pullDoneOnce = !!ctx.cursors[entity]?.pull?.since;
      await pushEntity(ctx, entity, es, pullDoneOnce);
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
      error = "Your CRM connection needs to be re-authorised. Disconnect and connect again.";
    } else if (err instanceof RateLimitError) {
      status = "partial";
      error = "The CRM is rate limiting requests. The sync will retry on the next run.";
    } else {
      error = err instanceof Error ? err.message.slice(0, 400) : "Unexpected sync error.";
      console.error("crm-sync-run failed", conn.id, err);
    }
  } finally {
    if (ctx) {
      await flushLogs(ctx);
      if (ctx.runId) await admin.from("crm_sync_runs").update({ stats: ctx.stats }).eq("id", ctx.runId);
    }
    await admin
      .from("crm_sync_runs")
      .update({ status, error, finished_at: new Date().toISOString(), ...(ctx ? { stats: ctx.stats } : {}) })
      .eq("id", runId);
    await admin
      .from("crm_connections")
      .update({
        sync_locked_until: null,
        ...(ctx ? { cursors: ctx.cursors } : {}),
        ...(status !== "failed" || !markError ? {} : { status: "error" }),
        ...(status === "failed" ? { last_error: error } : { last_error: status === "partial" ? error : null, last_synced_at: new Date().toISOString() }),
      })
      .eq("id", conn.id);
  }
}

async function beginRun(admin: AnyClient, conn: ConnRow, trigger: "manual" | "scheduled"): Promise<string | null> {
  if (!(await acquireLock(admin, conn.id))) return null;
  await admin
    .from("crm_sync_runs")
    .update({ status: "failed", error: "Interrupted.", finished_at: new Date().toISOString() })
    .eq("connection_id", conn.id)
    .eq("status", "running")
    .lt("started_at", new Date(Date.now() - 10 * 60_000).toISOString());
  const { data } = await admin
    .from("crm_sync_runs")
    .insert({ user_id: conn.user_id, connection_id: conn.id, trigger, status: "running" })
    .select("id")
    .single();
  if (!data) {
    await admin.from("crm_connections").update({ sync_locked_until: null }).eq("id", conn.id);
    return null;
  }
  return data.id as string;
}

const background = (p: Promise<unknown>) => {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(p);
  else void p;
};

const CONN_COLS = "id, user_id, provider, status, api_base, settings, cursors";

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

  // ---- scheduled sync ---------------------------------------------------
  if (body.action === "cron") {
    const secret = Deno.env.get("CRON_SECRET");
    if (!secret || req.headers.get("X-Cron-Secret") !== secret) return json({ error: "Forbidden" }, 403);
    const due = new Date(Date.now() - 14 * 60_000).toISOString();
    const { data: conns } = await admin
      .from("crm_connections")
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

  // ---- user actions -----------------------------------------------------
  const authHeaderValue = req.headers.get("Authorization");
  if (!authHeaderValue) return json({ error: "Missing Authorization header" }, 401);
  const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authHeaderValue } },
    auth: { persistSession: false },
  });
  const { data: userData } = await caller.auth.getUser();
  if (!userData?.user) return json({ error: "Not authenticated" }, 401);
  const { data: ownerData } = await caller.rpc("get_account_owner_id");
  if (!ownerData) return json({ error: "Could not resolve your account." }, 401);
  const ownerId = ownerData as string;
  const { data: allowed } = await caller.rpc("can_manage_crm");
  if (allowed !== true) return json({ error: "You don't have permission to manage CRM sync." }, 403);

  const loadConn = async (id: unknown): Promise<ConnRow | null> => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data } = await admin.from("crm_connections").select(CONN_COLS).eq("id", id).eq("user_id", ownerId).maybeSingle();
    return (data as ConnRow | null) ?? null;
  };

  if (body.action === "run") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    if (conn.status === "disconnected") return json({ error: "This CRM is disconnected." }, 409);
    const runId = await beginRun(admin, conn, "manual");
    if (!runId) return json({ error: "A sync is already running for this CRM." }, 409);
    background(executeRun(admin, conn, runId));
    return json({ run_id: runId }, 202);
  }

  if (body.action === "save_settings") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    const v = validateSettings(conn.provider, body.settings);
    if (!v.ok) return json({ error: v.error }, 400);

    // A changed mapping must re-read that entity so new fields get their first merge.
    const cursors = { ...(conn.cursors ?? {}) };
    const old = validateSettings(conn.provider, conn.settings);
    for (const e of CRM_ENTITIES) {
      const sig = (m: { vireek: string; crm: string; direction: string }[]) =>
        JSON.stringify([...m].sort((a, b) => a.vireek.localeCompare(b.vireek)).map((x) => [x.vireek, x.crm, x.direction]));
      const before = old.ok ? sig(old.settings.entities[e].mapping) : "";
      if (before !== sig(v.settings.entities[e].mapping)) delete cursors[e];
    }
    const update: Record<string, unknown> = { settings: v.settings, cursors };
    if (typeof body.auto_sync === "boolean") update.auto_sync = body.auto_sync;
    const { error } = await admin.from("crm_connections").update(update).eq("id", conn.id);
    if (error) return json({ error: "Could not save settings." }, 500);
    return json({ ok: true, settings: v.settings });
  }

  if (body.action === "disconnect") {
    const conn = await loadConn(body.connection_id);
    if (!conn) return json({ error: "Connection not found." }, 404);
    await admin.from("crm_connection_secrets").delete().eq("connection_id", conn.id);
    await admin.from("crm_record_links").delete().eq("connection_id", conn.id);
    await admin
      .from("crm_connections")
      .update({ status: "disconnected", cursors: {}, last_error: null, sync_locked_until: null })
      .eq("id", conn.id);
    return json({ ok: true });
  }

  if (body.action === "resolve_conflict") {
    const winner = body.winner === "vireek" || body.winner === "crm" ? body.winner : null;
    if (!winner || typeof body.link_id !== "string") return json({ error: "Invalid request." }, 400);
    const { data: link } = await admin
      .from("crm_record_links")
      .select("id, entity, vireek_id, external_id, base, conflict, connection_id")
      .eq("id", body.link_id)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (!link) return json({ error: "Conflict not found." }, 404);
    const conn = await loadConn(link.connection_id);
    if (!conn || conn.status !== "connected") return json({ error: "This CRM is not connected." }, 409);
    if (!(await acquireLock(admin, conn.id))) return json({ error: "A sync is running. Try again in a moment." }, 409);

    let ctx: Ctx | null = null;
    try {
      ctx = await buildCtx(admin, conn, null, Date.now() + 60_000);
      const entity = link.entity as CrmEntity;
      const es = ctx.settings.entities[entity];
      const vRow = await getVireekRow(ctx, entity, link.vireek_id as string);
      const cRaw = await fetchCrmRecord(ctx, entity, es, link.external_id as string);
      if (!vRow || !cRaw) return json({ error: "One of the two records no longer exists." }, 410);
      const result = await reconcile(ctx, entity, es, link as unknown as LinkRow, vRow, cRaw, {
        rule: winner === "vireek" ? "vireek_wins" : "crm_wins",
        note: `Conflict resolved (kept ${winner === "vireek" ? "Vireek" : "CRM"})`,
      });
      await flushLogs(ctx);
      return result === "error" ? json({ error: "Could not apply that choice. See the sync log." }, 502) : json({ ok: true });
    } catch (err) {
      console.error("resolve_conflict failed", err);
      return json({ error: err instanceof AuthError ? "Reconnect your CRM and try again." : "Could not resolve this conflict." }, 502);
    } finally {
      await admin.from("crm_connections").update({ sync_locked_until: null }).eq("id", conn.id);
      if (ctx) await flushLogs(ctx);
    }
  }

  return json({ error: "Unknown action." }, 400);
});
