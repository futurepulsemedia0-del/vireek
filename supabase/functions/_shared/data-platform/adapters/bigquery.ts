// supabase/functions/_shared/data-platform/adapters/bigquery.ts
// BigQuery over REST with the customer's service account. Rows are loaded with a (free) batch LOAD
// job into a staging table and then MERGEd into the target, so upserts are idempotent and there is
// no streaming buffer to block later UPDATEs.

import type { DatasetKey } from "../catalog.ts";
import { DATASETS } from "../catalog.ts";
import { bigQuerySchema, buildBigQueryMerge, buildMarkDeleted, type BigQueryConfig } from "../warehouse.ts";
import { fetchAccessToken, parseServiceAccountJson, SCOPE_BIGQUERY } from "../googleAuth.ts";
import { AdapterError, readJson, type Check, type WarehouseAdapter } from "./types.ts";

const API = "https://bigquery.googleapis.com/bigquery/v2";
const UPLOAD = "https://bigquery.googleapis.com/upload/bigquery/v2";

export async function createBigQueryAdapter(config: BigQueryConfig, serviceAccountJson: string): Promise<WarehouseAdapter> {
  const parsed = parseServiceAccountJson(serviceAccountJson);
  if (!parsed.ok) throw new AdapterError(parsed.error, 400);
  const token = await fetchAccessToken(parsed.key, [SCOPE_BIGQUERY]);
  const p = config.project_id;
  const staged = new Set<string>();

  const call = async (url: string, init: RequestInit = {}) => {
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    const body = await readJson(res);
    return { res, body };
  };
  const fail = (what: string, res: Response, body: Record<string, any>) =>
    new AdapterError(`${what}: ${body?.error?.message ?? res.status}`, res.status);

  async function ensureDataset() {
    const { res } = await call(`${API}/projects/${p}/datasets/${config.dataset}`);
    if (res.ok) return;
    if (res.status !== 404) throw new AdapterError(`BigQuery denied access to dataset ${config.dataset} (${res.status}).`, res.status);
    const made = await call(`${API}/projects/${p}/datasets`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasetReference: { projectId: p, datasetId: config.dataset }, location: config.location }),
    });
    if (!made.res.ok) throw fail("Could not create the dataset", made.res, made.body);
  }

  async function ensureTable(dataset: DatasetKey) {
    const fields = bigQuerySchema(dataset);
    const url = `${API}/projects/${p}/datasets/${config.dataset}/tables`;
    const got = await call(`${url}/${dataset}`);
    if (got.res.status === 404) {
      const made = await call(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tableReference: { projectId: p, datasetId: config.dataset, tableId: dataset }, description: DATASETS[dataset].description, schema: { fields } }),
      });
      if (!made.res.ok) throw fail(`Could not create table ${dataset}`, made.res, made.body);
      return;
    }
    if (!got.res.ok) throw fail(`Could not read table ${dataset}`, got.res, got.body);
    const have = new Set<string>((got.body.schema?.fields ?? []).map((f: { name: string }) => f.name));
    const missing = fields.filter((f) => !have.has(f.name)).map((f) => ({ ...f, mode: "NULLABLE" }));
    if (missing.length) {
      const patched = await call(`${url}/${dataset}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema: { fields: [...(got.body.schema?.fields ?? []), ...missing] } }),
      });
      if (!patched.res.ok) throw fail(`Could not add columns to ${dataset}`, patched.res, patched.body);
    }
  }

  async function waitJob(jobId: string) {
    for (let i = 0; i < 60; i++) {
      const { res, body } = await call(`${API}/projects/${p}/jobs/${jobId}?location=${encodeURIComponent(config.location)}`);
      if (!res.ok) throw fail("Could not read the BigQuery job", res, body);
      if (body.status?.state === "DONE") {
        if (body.status.errorResult) throw new AdapterError(`BigQuery job failed: ${body.status.errorResult.message}`, 400);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new AdapterError("BigQuery job did not finish within 60 seconds (timeout).");
  }

  async function query(sql: string) {
    const { res, body } = await call(`${API}/projects/${p}/queries`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql, useLegacySql: false, location: config.location, timeoutMs: 60_000 }),
    });
    if (!res.ok) throw fail("BigQuery query failed", res, body);
    if (body.jobComplete === false && body.jobReference?.jobId) await waitJob(body.jobReference.jobId);
  }

  return {
    async test(): Promise<Check[]> {
      const checks: Check[] = [{ name: "Service account", ok: true, detail: parsed.key.client_email }];
      await ensureDataset();
      checks.push({ name: "Dataset", ok: true, detail: `${p}.${config.dataset} (${config.location})` });
      await query("SELECT 1");
      checks.push({ name: "Run queries", ok: true, detail: "BigQuery job user permission is granted" });
      return checks;
    },
    async prepare(datasets) {
      await ensureDataset();
      for (const d of datasets) await ensureTable(d);
    },
    async upsert(dataset, rows) {
      if (!rows.length) return;
      const stagingTable = `${dataset}__stg`;
      staged.add(stagingTable);
      const ndjson = rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v !== null && typeof v === "object" ? JSON.stringify(v) : v])))).join("\n");
      const boundary = `vireek${crypto.randomUUID().replace(/-/g, "")}`;
      const jobId = `vireek_${dataset}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      const meta = {
        jobReference: { projectId: p, jobId, location: config.location },
        configuration: { load: {
          destinationTable: { projectId: p, datasetId: config.dataset, tableId: stagingTable },
          sourceFormat: "NEWLINE_DELIMITED_JSON", writeDisposition: "WRITE_TRUNCATE", createDisposition: "CREATE_IF_NEEDED",
          schema: { fields: bigQuerySchema(dataset).map(({ name, type }) => ({ name, type, mode: "NULLABLE" })) },
        } },
      };
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${ndjson}\r\n--${boundary}--`;
      const up = await call(`${UPLOAD}/projects/${p}/jobs?uploadType=multipart`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
      if (!up.res.ok) throw fail("BigQuery load failed", up.res, up.body);
      await waitJob(jobId);
      await query(buildBigQueryMerge(config, dataset, stagingTable));
    },
    async markDeleted(dataset, accountId, beforeIso) {
      await query(buildMarkDeleted(config, dataset, accountId, beforeIso));
    },
    async close() {
      for (const t of staged) await call(`${API}/projects/${p}/datasets/${config.dataset}/tables/${t}`, { method: "DELETE" }).catch(() => {});
    },
  };
}
