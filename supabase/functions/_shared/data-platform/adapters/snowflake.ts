// supabase/functions/_shared/data-platform/adapters/snowflake.ts
// Snowflake over the SQL REST API v2 (no driver). Auth: programmatic access token (simplest) or
// key-pair JWT (unencrypted PKCS#8 key). The host is always <account>.snowflakecomputing.com.

import type { DatasetKey } from "../catalog.ts";
import { buildDdl, buildMarkDeleted, buildSnowflakeMerge, type SnowflakeConfig, type SnowflakeCredentials } from "../warehouse.ts";
import { pemToPkcs8 } from "../googleAuth.ts";
import { b64url } from "../secrets.ts";
import { AdapterError, readJson, type Check, type WarehouseAdapter } from "./types.ts";

const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

/** Snowflake wants the SHA-256 fingerprint of the PUBLIC key, which we derive from the private JWK. */
export async function publicKeyFingerprint(privatePem: string): Promise<string> {
  const priv = await crypto.subtle.importKey("pkcs8", pemToPkcs8(privatePem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  const pub = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pub));
  return `SHA256:${b64(new Uint8Array(await crypto.subtle.digest("SHA-256", spki)))}`;
}

async function keypairJwt(config: SnowflakeConfig, pem: string): Promise<string> {
  const account = config.account.split(".")[0].toUpperCase();
  const qualified = `${account}.${config.username.toUpperCase()}`;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify({ iss: `${qualified}.${await publicKeyFingerprint(pem)}`, sub: qualified, iat: now, exp: now + 3000 })));
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

export async function createSnowflakeAdapter(config: SnowflakeConfig, creds: SnowflakeCredentials): Promise<WarehouseAdapter> {
  const base = `https://${config.account}.snowflakecomputing.com/api/v2/statements`;
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Vireek-DataPlatform/1.0" };
  if (creds.auth === "pat") {
    headers.Authorization = `Bearer ${creds.token}`;
    headers["X-Snowflake-Authorization-Token-Type"] = "PROGRAMMATIC_ACCESS_TOKEN";
  } else {
    headers.Authorization = `Bearer ${await keypairJwt(config, creds.private_key)}`;
    headers["X-Snowflake-Authorization-Token-Type"] = "KEYPAIR_JWT";
  }

  async function run(statement: string, params: string[] = []): Promise<void> {
    const bindings = Object.fromEntries(params.map((v, i) => [String(i + 1), { type: "TEXT", value: v }]));
    const res = await fetch(`${base}?requestId=${crypto.randomUUID()}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        statement, timeout: 120, warehouse: config.warehouse, database: config.database, schema: config.schema,
        ...(config.role ? { role: config.role } : {}), ...(params.length ? { bindings } : {}),
      }),
    });
    let status = res.status;
    let body = await readJson(res);
    for (let i = 0; status === 202; i++) {
      if (i > 60) throw new AdapterError("Snowflake statement is still running after 90 seconds (timeout).");
      await new Promise((r) => setTimeout(r, 1500));
      const poll = await fetch(`${base}/${body.statementHandle}`, { headers });
      status = poll.status;
      body = await readJson(poll);
    }
    if (status >= 400) throw new AdapterError(body.message ?? `Snowflake error ${status}`, status === 422 ? 400 : status);
  }

  return {
    async test(): Promise<Check[]> {
      await run("SELECT 1");
      const checks: Check[] = [{ name: "Authentication", ok: true, detail: `Signed in as ${config.username}` }];
      await run(`CREATE SCHEMA IF NOT EXISTS "${config.database.toUpperCase()}"."${config.schema.toUpperCase()}"`);
      await run(`CREATE TABLE IF NOT EXISTS "${config.database.toUpperCase()}"."${config.schema.toUpperCase()}"."_VIREEK_CONNECTION_TEST" (ID NUMBER)`);
      await run(`DROP TABLE "${config.database.toUpperCase()}"."${config.schema.toUpperCase()}"."_VIREEK_CONNECTION_TEST"`);
      checks.push({ name: "Create and drop tables", ok: true, detail: `${config.database}.${config.schema} is writable` });
      return checks;
    },
    async prepare(datasets) {
      for (const d of datasets) for (const stmt of buildDdl(config, d)) await run(stmt);
    },
    async upsert(dataset: DatasetKey, rows) {
      if (!rows.length) return;
      const st = buildSnowflakeMerge(config, dataset, JSON.stringify(rows));
      await run(st.sql, st.params);
    },
    async markDeleted(dataset, accountId, beforeIso) {
      await run(buildMarkDeleted(config, dataset, accountId, beforeIso));
    },
    async close() {},
  };
}
