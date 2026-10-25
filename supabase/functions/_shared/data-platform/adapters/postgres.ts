// supabase/functions/_shared/data-platform/adapters/postgres.ts
// Customer Postgres replica. Runs in Deno edge functions only.
//
// Safety: the hostname is resolved first and every address must be public (no DNS-rebinding into
// the private network), the connection is TLS (require, or verify-full on request), and the user
// should be a dedicated role that owns only the Vireek schema (see docs/DATA_PLATFORM.md).

import postgres from "npm:postgres@3.4.5";
import { allColumns, type DatasetKey } from "../catalog.ts";
import { buildDdl, buildMarkDeleted, buildPostgresUpsert, isPublicAddress, quoteIdent, type PostgresConfig } from "../warehouse.ts";
import { AdapterError, type Check, type WarehouseAdapter } from "./types.ts";

declare const Deno: { resolveDns(host: string, type: "A" | "AAAA"): Promise<string[]> };

const toDollar = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

async function resolvePublic(host: string): Promise<string> {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const addrs: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try { addrs.push(...(await Deno.resolveDns(host, type))); } catch { /* none of this family */ }
  }
  if (!addrs.length) throw new AdapterError(`Could not resolve ${host}.`);
  if (!addrs.every(isPublicAddress)) throw new AdapterError("That hostname resolves to a private address, which is not allowed.");
  return addrs[0];
}

export async function createPostgresAdapter(config: PostgresConfig, password: string): Promise<WarehouseAdapter> {
  const ip = await resolvePublic(config.host);
  // deno-lint-ignore no-explicit-any
  const sql: any = postgres({
    host: ip,
    port: config.port,
    database: config.database,
    username: config.username,
    password,
    ssl: config.ssl === "verify-full" ? { rejectUnauthorized: true, servername: config.host } : "require",
    max: 1,
    idle_timeout: 5,
    connect_timeout: 20,
    prepare: false,
    onnotice: () => {},
  });
  const run = async (text: string, params: string[] = []) => {
    try {
      return await sql.unsafe(toDollar(text), params);
    } catch (e) {
      const err = e as { message?: string; code?: string };
      throw new AdapterError(err.message ?? "Postgres error", err.code === "28P01" || err.code === "42501" ? 403 : null);
    }
  };
  return {
    async test(): Promise<Check[]> {
      const checks: Check[] = [];
      await run("SELECT 1");
      checks.push({ name: "Connection (TLS)", ok: true, detail: `Connected to ${config.host}:${config.port}` });
      const s = quoteIdent("postgres", config.schema);
      await run(`CREATE SCHEMA IF NOT EXISTS ${s}`);
      await run(`CREATE TABLE IF NOT EXISTS ${s}."_vireek_connection_test" (id int)`);
      await run(`DROP TABLE ${s}."_vireek_connection_test"`);
      checks.push({ name: "Create and drop tables", ok: true, detail: `Schema ${config.schema} is writable` });
      return checks;
    },
    async prepare(datasets) {
      for (const d of datasets) for (const stmt of buildDdl(config, d)) await run(stmt);
    },
    async upsert(dataset, rows) {
      if (!rows.length) return;
      const st = buildPostgresUpsert(config, dataset, JSON.stringify(rows));
      await run(st.sql, st.params);
    },
    async markDeleted(dataset, accountId, beforeIso) {
      await run(buildMarkDeleted(config, dataset, accountId, beforeIso));
    },
    async close() {
      await sql.end({ timeout: 5 }).catch(() => {});
    },
  };
}

export const _columnsFor = (d: DatasetKey) => allColumns(d).length;
