// supabase/functions/_shared/exports/biRunner.ts
//
// Delivers one BI schedule: reads each table through the Data Platform catalog (tenant-scoped, PII-aware),
// writes CSV parts + a signed manifest through an injected `put`, and advances the incremental watermark.
// No Deno APIs: the database client and the uploader are injected, so the whole run is unit-tested.

import { createPseudonymizer, DATASETS, isDatasetKey, type DatasetKey, type PiiMode } from "../data-platform/catalog.ts";
import { advanceCursor, cursorFilter, maxTimestamp, NIL_UUID, startCursor, type Cursor } from "../data-platform/warehouse.ts";
import {
  BI_PAGE_SIZE,
  BI_SNAPSHOT_MAX_ROWS,
  BI_SOFT_DELETE,
  CsvPart,
  biColumns,
  biRow,
  biSchemaHash,
  biSelectList,
  csvHeader,
  csvLine,
  datasetDir,
  latestKey,
  outputName,
  partName,
  sha256Hex,
  signManifest,
  type BiManifestBody,
  type BiManifestPart,
  type BiMode,
} from "./bi.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export interface BiScheduleRow {
  id: string;
  user_id: string;
  datasets: string[];
  mode: BiMode;
  pii_mode: PiiMode;
}

export interface BiRunDeps {
  db: Db;
  put(relKey: string, bytes: Uint8Array, contentType: string): Promise<void>;
  signingSecret: string;
  pseudonymSecret: string;
  /** Epoch ms after which no new page is started. */
  deadline: number;
  /** Result of the permission re-check for whoever authorised personal data on this schedule. */
  piiPermitted: boolean;
  now?: () => Date;
}

export interface BiRunResult {
  status: "success" | "partial" | "failed";
  stats: { datasets: Record<string, { rows: number; parts: number; bytes: number; complete: boolean }> };
  error: string | null;
}

const EPOCH = "1970-01-01T00:00:00.000Z";
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

export async function runBiDelivery(deps: BiRunDeps, schedule: BiScheduleRow, runId: string): Promise<BiRunResult> {
  const stats: BiRunResult["stats"] = { datasets: {} };
  if (schedule.pii_mode !== "omit" && !deps.piiPermitted) {
    return {
      status: "failed",
      stats,
      error: "Personal data is no longer permitted for this schedule. Ask an owner to switch it to “No personal data” or re-authorise it.",
    };
  }

  const datasets = schedule.datasets.filter(isDatasetKey) as DatasetKey[];
  if (!datasets.length) return { status: "failed", stats, error: "This schedule has no valid tables." };

  // Oldest-delivered first, so a run that hits its time budget makes progress on the next one.
  const { data: stateRows } = await deps.db.from("bi_export_state").select("dataset,watermark,rows_total,last_run_at").eq("schedule_id", schedule.id);
  const state = new Map<string, { watermark: string | null; rows_total: number; last_run_at: string | null }>(
    ((stateRows ?? []) as { dataset: string; watermark: string | null; rows_total: number; last_run_at: string | null }[]).map((r) => [r.dataset, r]),
  );
  datasets.sort((a, b) => Date.parse(state.get(a)?.last_run_at ?? EPOCH) - Date.parse(state.get(b)?.last_run_at ?? EPOCH));

  const pseudonymize = await createPseudonymizer(deps.pseudonymSecret, schedule.user_id);
  let partial = false;

  try {
    for (const dataset of datasets) {
      if (Date.now() > deps.deadline) {
        partial = true;
        break;
      }
      const res = await deliverDataset(deps, schedule, runId, dataset, state.get(dataset) ?? null, pseudonymize);
      stats.datasets[dataset] = { rows: res.rows, parts: res.parts, bytes: res.bytes, complete: res.complete };
      if (!res.complete) partial = true;
    }
    return { status: partial ? "partial" : "success", stats, error: null };
  } catch (e) {
    return { status: "failed", stats, error: msg(e) };
  }
}

async function deliverDataset(
  deps: BiRunDeps,
  schedule: BiScheduleRow,
  runId: string,
  dataset: DatasetKey,
  prev: { watermark: string | null; rows_total: number } | null,
  pseudonymize: Awaited<ReturnType<typeof createPseudonymizer>>,
): Promise<{ rows: number; parts: number; bytes: number; complete: boolean }> {
  const def = DATASETS[dataset];
  const mode = schedule.mode;
  const piiMode = schedule.pii_mode;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const incremental = mode === "incremental";
  const cols = biColumns(dataset, piiMode);
  const select = biSelectList(dataset, piiMode);
  const dir = datasetDir(dataset, mode, startedAt.toISOString().slice(0, 10), runId);
  const header = csvHeader(dataset, piiMode);

  let cursor: Cursor = incremental ? startCursor(prev?.watermark, { full: !prev?.watermark }) : { ts: EPOCH, id: NIL_UUID };
  let lastId = NIL_UUID;
  let watermark = prev?.watermark ?? null;
  const parts: BiManifestPart[] = [];
  let part = new CsvPart(header);
  let total = 0;
  let bytes = 0;
  let complete = false;

  const flush = async () => {
    const name = partName(parts.length + 1);
    const data = part.toBytes();
    const sha = await sha256Hex(data);
    await deps.put(`${dir}/${name}`, data, "text/csv; charset=utf-8");
    parts.push({ name, rows: part.rows, bytes: data.length, sha256: sha });
    bytes += data.length;
    part = new CsvPart(header);
  };

  while (true) {
    if (Date.now() > deps.deadline) {
      if (!incremental) throw new Error(`The ${def.label.toLowerCase()} snapshot did not finish in time. Use incremental mode or a longer interval.`);
      break;
    }
    let q = deps.db.from(def.source).select(select).eq("user_id", schedule.user_id);
    if (BI_SOFT_DELETE.has(dataset)) q = q.is("deleted_at", null);
    q = incremental
      ? q.or(cursorFilter(cursor)).order("updated_at", { ascending: true }).order("id", { ascending: true })
      : q.gt("id", lastId).order("id", { ascending: true });
    const { data, error } = await q.limit(BI_PAGE_SIZE);
    if (error) throw new Error(`Could not read ${def.label.toLowerCase()}: ${error.message}`);
    const page = (data ?? []) as Record<string, unknown>[];
    if (!page.length) {
      complete = true;
      break;
    }
    const syncedAt = startedAt.toISOString();
    for (const r of page) {
      part.add(csvLine(cols, await biRow(dataset, r, { accountId: schedule.user_id, piiMode, pseudonymize, syncedAt })));
      total++;
      if (part.full) await flush();
    }
    if (incremental) {
      cursor = advanceCursor(page as { updated_at?: unknown; id?: unknown }[], cursor);
      watermark = maxTimestamp(watermark, cursor.ts);
    } else {
      lastId = String(page[page.length - 1].id);
      if (total > BI_SNAPSHOT_MAX_ROWS) throw new Error(`${def.label} has more than ${BI_SNAPSHOT_MAX_ROWS.toLocaleString("en-US")} rows. Use incremental mode.`);
    }
    if (page.length < BI_PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (part.rows > 0 || (!incremental && parts.length === 0)) await flush();

  const body: BiManifestBody = {
    version: 1,
    format: "csv",
    run_id: runId,
    account_id: schedule.user_id,
    dataset,
    mode,
    pii_mode: piiMode,
    generated_at: startedAt.toISOString(),
    since: incremental ? prev?.watermark ?? null : null,
    watermark: incremental ? watermark : null,
    complete,
    schema_hash: biSchemaHash(dataset, piiMode),
    columns: cols.map((c) => ({ name: outputName(c, piiMode), type: c.type, ...(c.pii ? { pii: c.pii } : {}) })),
    row_count: total,
    parts,
  };
  const manifest = new TextEncoder().encode(JSON.stringify(await signManifest(body, deps.signingSecret), null, 2));
  // Manifest last: a run without a manifest is incomplete by definition and must be ignored by consumers.
  await deps.put(`${dir}/manifest.json`, manifest, "application/json");
  await deps.put(latestKey(dataset, mode), manifest, "application/json");

  await deps.db.from("bi_export_state").upsert({
    schedule_id: schedule.id,
    dataset,
    user_id: schedule.user_id,
    watermark: incremental ? watermark : null,
    rows_total: incremental ? Number(prev?.rows_total ?? 0) + total : total,
    last_run_at: now().toISOString(),
  });
  return { rows: total, parts: parts.length, bytes, complete };
}
