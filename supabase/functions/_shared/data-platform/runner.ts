// supabase/functions/_shared/data-platform/runner.ts
//
// Executes one run: warehouse sync, reverse ETL, or the daily metric snapshot. Used by
// data-platform-run (cron + "Sync now"). Every query is scoped to the destination's account owner.

import { DATASETS, createPseudonymizer, isDatasetKey, selectList, transformRow, DEFAULT_DATASETS, type DatasetKey, type PiiMode } from "./catalog.ts";
import {
  advanceCursor, backoffMs, classifyFailure, cursorFilter, maxTimestamp, schemaHash, startCursor, validateWarehouseConfig, BATCH_SIZE,
  type BigQueryCredentials, type WarehouseConfig, type WarehouseCredentials,
} from "./warehouse.ts";
import { openAdapter } from "./adapters/index.ts";
import { dailySnapshots, validTimeZone } from "./metrics.ts";
import { loadAudienceData, loadMetricData } from "./loader.ts";
import {
  audienceTable, buildAudience, chunk, consentedWithEmail, columnLetter, isModelKey, jobs90Table, klaviyoImportBody, mailchimpDc,
  mailchimpMemberRequest, metricsDailyTable, metricsSummaryTable, modelParam, selectAudience, sheetRange, sheetValues,
  validateReverseConfig, KLAVIYO_REVISION, MODELS, type ReverseConfig, type TableOutput,
} from "./reverseEtl.ts";
import { fetchAccessToken, parseServiceAccountJson, SCOPE_SHEETS } from "./googleAuth.ts";
import { openSecret } from "./secrets.ts";
import { aad, encryptionKey, type Admin } from "./http.ts";

export const RUN_BUDGET_MS = 110_000;
export const FULL_REFRESH_EVERY_MS = 7 * 86_400_000;

export interface Destination {
  id: string;
  user_id: string;
  role: "warehouse" | "reverse";
  kind: string;
  name: string;
  config: Record<string, unknown>;
  settings: Record<string, unknown>;
  interval_minutes: number;
  consecutive_failures: number;
}

export interface RunResult { status: "success" | "partial" | "failed"; stats: Record<string, unknown>; error: string | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as { status?: number | null; message?: string };
      if (i >= attempts || classifyFailure(err.status ?? null, err.message ?? "") !== "retryable") throw e;
      await sleep(backoffMs(i));
    }
  }
}

async function loadSecret(admin: Admin, dest: Destination): Promise<string> {
  const { data } = await admin.from("dp_secrets").select("secret_enc").eq("ref_id", dest.id).eq("user_id", dest.user_id).maybeSingle();
  if (!data?.secret_enc) throw new Error("Stored credentials are missing. Edit the destination and enter them again.");
  return await openSecret(data.secret_enc as string, encryptionKey(), aad("destination", dest.id));
}

// ============================================================
// Warehouse sync
// ============================================================

export function warehouseSettings(raw: Record<string, unknown>): { datasets: DatasetKey[]; piiMode: PiiMode } {
  const ds = Array.isArray(raw.datasets) ? raw.datasets.filter(isDatasetKey) : [];
  const piiMode: PiiMode = raw.pii_mode === "full" || raw.pii_mode === "omit" ? raw.pii_mode : "hashed";
  return { datasets: ds.length ? [...new Set(ds)] : [...DEFAULT_DATASETS], piiMode };
}

export async function runWarehouseSync(admin: Admin, dest: Destination, opts: { full: boolean; deadline: number }): Promise<RunResult> {
  const stats: Record<string, unknown> = { datasets: {} as Record<string, unknown> };
  const perDataset = stats.datasets as Record<string, { rows: number; done: boolean }>;
  const cfg = validateWarehouseConfig(dest.kind as "bigquery", { ...dest.config });
  if (!cfg.ok) return { status: "failed", stats, error: "Destination settings are invalid. Edit and save them again." };
  const config: WarehouseConfig = cfg.value;
  const { datasets, piiMode } = warehouseSettings(dest.settings);
  const started = new Date();
  let adapter: Awaited<ReturnType<typeof openAdapter>> | null = null;
  let partial = false;

  try {
    const creds = JSON.parse(await loadSecret(admin, dest)) as WarehouseCredentials;
    adapter = await openAdapter(config, creds);
    const pseudonymize = await createPseudonymizer(encryptionKey(), dest.user_id);

    const { data: stateRows } = await admin.from("dp_sync_state").select("*").eq("destination_id", dest.id);
    const state = new Map<string, { watermark: string | null; schema_hash: string | null; rows_total: number; last_full_refresh_at: string | null }>(
      (stateRows ?? []).map((r: Record<string, unknown>) => [r.dataset as string, r as never]),
    );

    const needsDdl = datasets.filter((d) => opts.full || state.get(d)?.schema_hash !== schemaHash(d));
    if (needsDdl.length) await withRetry(() => adapter!.prepare(needsDdl));

    for (const dataset of datasets) {
      const prev = state.get(dataset);
      const full = opts.full || !prev?.watermark;
      let cursor = startCursor(prev?.watermark, { full });
      let watermark = prev?.watermark ?? null;
      let rows = full ? 0 : Number(prev?.rows_total ?? 0);
      let loaded = 0;
      let finished = false;

      while (true) {
        if (Date.now() > opts.deadline) { partial = true; break; }
        const def = DATASETS[dataset];
        const { data, error } = await admin.from(def.source).select(selectList(dataset)).eq("user_id", dest.user_id)
          .or(cursorFilter(cursor)).order("updated_at", { ascending: true }).order("id", { ascending: true }).limit(BATCH_SIZE);
        if (error) throw new Error(`Could not read ${dataset}: ${error.message}`);
        const page = (data ?? []) as unknown as Record<string, unknown>[];
        if (!page.length) { finished = true; break; }
        const syncedAt = new Date().toISOString();
        const out = [];
        for (const r of page) out.push(await transformRow(dataset, r, { accountId: dest.user_id, piiMode, pseudonymize, syncedAt }));
        await withRetry(() => adapter!.upsert(dataset, out));
        loaded += page.length;
        rows += page.length;
        cursor = advanceCursor(page as { updated_at?: unknown; id?: unknown }[], cursor);
        watermark = maxTimestamp(watermark, cursor.ts);
        perDataset[dataset] = { rows: loaded, done: false };
        await admin.from("dp_sync_state").upsert({ destination_id: dest.id, dataset, user_id: dest.user_id, watermark, schema_hash: schemaHash(dataset), rows_total: rows, last_synced_at: new Date().toISOString(), ...(prev ? { last_full_refresh_at: prev.last_full_refresh_at } : {}) });
        if (page.length < BATCH_SIZE) { finished = true; break; }
      }

      if (finished && opts.full) await withRetry(() => adapter!.markDeleted(dataset, dest.user_id, started.toISOString()));
      perDataset[dataset] = { rows: loaded, done: finished };
      await admin.from("dp_sync_state").upsert({
        destination_id: dest.id, dataset, user_id: dest.user_id, watermark, schema_hash: schemaHash(dataset), rows_total: rows, last_synced_at: new Date().toISOString(),
        last_full_refresh_at: finished && opts.full ? started.toISOString() : prev?.last_full_refresh_at ?? null,
      });
      if (partial) break;
    }
    return { status: partial ? "partial" : "success", stats, error: null };
  } catch (e) {
    return { status: "failed", stats, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
  } finally {
    await adapter?.close().catch(() => {});
  }
}

// ============================================================
// Reverse ETL
// ============================================================

async function accountTz(admin: Admin, ownerId: string): Promise<string> {
  const { data } = await admin.from("business_profile").select("timezone").eq("user_id", ownerId).maybeSingle();
  return validTimeZone(data?.timezone);
}

async function computeTable(admin: Admin, dest: Destination, model: ReturnType<typeof modelOf>): Promise<{ table: TableOutput; skipped?: Record<string, number> }> {
  const now = new Date();
  const tz = await accountTz(admin, dest.user_id);
  const currency = typeof dest.settings.currency === "string" ? dest.settings.currency : "USD";
  if (model.kind === "table") {
    const days = model.key === "metrics_summary" ? 62 : 92;
    const { data } = await loadMetricData(admin, dest.user_id, new Date(now.getTime() - days * 86_400_000).toISOString());
    return { table: model.key === "metrics_summary" ? metricsSummaryTable(data, now, tz, currency) : model.key === "metrics_daily" ? metricsDailyTable(data, now, tz) : jobs90Table(data, now) };
  }
  const { customers, jobs } = await loadAudienceData(admin, dest.user_id);
  const picked = selectAudience(model.key, buildAudience(customers, jobs), modelParam(model.key, dest.settings.param), now);
  return { table: audienceTable(picked) };
}

const modelOf = (dest: Destination) => {
  const key = dest.settings.model;
  if (!isModelKey(key)) throw new Error("Choose what to send before syncing.");
  return MODELS[key];
};

export async function runReverseEtl(admin: Admin, dest: Destination): Promise<RunResult> {
  const stats: Record<string, unknown> = {};
  try {
    const model = modelOf(dest);
    if (!(model.destinations as readonly string[]).includes(dest.kind)) throw new Error(`${model.label} cannot be sent to ${dest.kind}.`);
    const v = validateReverseConfig(dest.kind as "sheets", dest.config);
    if (!v.ok) throw new Error("Destination settings are invalid. Edit and save them again.");
    const cfg: ReverseConfig = v.value;
    const secret = await loadSecret(admin, dest);

    if (dest.kind === "sheets") {
      const { table } = await computeTable(admin, dest, model);
      const parsed = parseServiceAccountJson(secret);
      if (!parsed.ok) throw new Error(parsed.error);
      const token = await fetchAccessToken(parsed.key, [SCOPE_SHEETS]);
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheet_id}`;
      const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const meta = await fetch(`${base}?fields=sheets.properties.title`, { headers: h });
      if (meta.status === 403 || meta.status === 404) throw new Error(`The sheet is not shared with ${parsed.key.client_email}. Share it as Editor and try again.`);
      if (!meta.ok) throw new Error(`Google Sheets error ${meta.status}`);
      const titles = ((await meta.json()) as { sheets?: { properties: { title: string } }[] }).sheets?.map((s) => s.properties.title) ?? [];
      if (!titles.includes(cfg.tab!)) {
        const add = await fetch(`${base}:batchUpdate`, { method: "POST", headers: h, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: cfg.tab } } }] }) });
        if (!add.ok) throw new Error(`Could not create the "${cfg.tab}" tab (${add.status}).`);
      }
      const values = sheetValues(table);
      const clear = await fetch(`${base}/values/${encodeURIComponent(sheetRange(cfg.tab!, "A:ZZ"))}:clear`, { method: "POST", headers: h, body: "{}" });
      if (!clear.ok) throw new Error(`Could not clear the tab (${clear.status}).`);
      const range = sheetRange(cfg.tab!, `A1:${columnLetter(table.columns.length)}${values.length}`);
      const put = await fetch(`${base}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: "PUT", headers: h, body: JSON.stringify({ range, majorDimension: "ROWS", values }) });
      if (!put.ok) throw new Error(`Google Sheets rejected the update (${put.status}).`);
      return { status: table.truncated ? "partial" : "success", stats: { rows: table.rows.length, truncated: table.truncated }, error: null };
    }

    // Email tools: audience models only, consent enforced here.
    const now = new Date();
    const { customers, jobs } = await loadAudienceData(admin, dest.user_id);
    const picked = selectAudience(model.key, buildAudience(customers, jobs), modelParam(model.key, dest.settings.param), now);
    const { eligible, skippedNoConsent, skippedNoEmail } = consentedWithEmail(picked);
    Object.assign(stats, { selected: picked.length, skipped_no_consent: skippedNoConsent, skipped_no_email: skippedNoEmail });
    let sent = 0;
    let failed = 0;

    if (dest.kind === "mailchimp") {
      const dc = mailchimpDc(secret);
      if (!dc) throw new Error("The Mailchimp API key looks invalid (expected ...-us21).");
      const auth = `Basic ${btoa(`vireek:${secret}`)}`;
      const queue = [...eligible];
      let authFailed = false;
      const worker = async () => {
        while (queue.length && !authFailed) {
          const m = queue.shift()!;
          const req = mailchimpMemberRequest(cfg.list_id!, m, cfg.tag ?? "vireek");
          const res = await withRetry(async () => {
            const r = await fetch(`https://${dc}.api.mailchimp.com${req.path}`, { method: "PUT", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(req.body) });
            if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`Mailchimp ${r.status}`), { status: r.status });
            return r;
          }).catch(() => null);
          if (res?.ok) sent++;
          else { failed++; if (res && (res.status === 401 || res.status === 403)) authFailed = true; }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker(), worker()]);
      if (authFailed) throw new Error("Mailchimp rejected the API key.");
    } else {
      for (const part of chunk(eligible, 1000)) {
        const res = await withRetry(async () => {
          const r = await fetch("https://a.klaviyo.com/api/profile-bulk-import-jobs/", {
            method: "POST",
            headers: { Authorization: `Klaviyo-API-Key ${secret}`, revision: KLAVIYO_REVISION, "Content-Type": "application/vnd.api+json", Accept: "application/vnd.api+json" },
            body: JSON.stringify(klaviyoImportBody(cfg.list_id!, part, model.key)),
          });
          if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`Klaviyo ${r.status}`), { status: r.status });
          return r;
        });
        if (res.status === 401 || res.status === 403) throw new Error("Klaviyo rejected the API key (it needs profiles:write and lists:write).");
        if (res.ok) sent += part.length; else failed += part.length;
      }
    }
    Object.assign(stats, { sent, failed });
    return { status: failed === 0 ? "success" : sent > 0 ? "partial" : "failed", stats, error: failed ? `${failed} contact(s) were rejected by ${dest.kind}.` : null };
  } catch (e) {
    return { status: "failed", stats, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
  }
}

// ============================================================
// Daily metric snapshots
// ============================================================

export async function refreshSnapshots(admin: Admin, ownerId: string, days: number): Promise<number> {
  const tz = await accountTz(admin, ownerId);
  const now = new Date();
  const { data } = await loadMetricData(admin, ownerId, new Date(now.getTime() - (days + 2) * 86_400_000).toISOString());
  const snaps = dailySnapshots(data, { days, tz, now });
  const computed_at = now.toISOString();
  for (const part of chunk(snaps, 500)) {
    const { error } = await admin.from("metric_snapshots").upsert(
      part.map((s) => ({ user_id: ownerId, ...s, computed_at })),
      { onConflict: "user_id,metric_id,day" },
    );
    if (error) throw new Error(error.message);
  }
  return snaps.length;
}

export type { BigQueryCredentials };
