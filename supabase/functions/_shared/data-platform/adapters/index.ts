// supabase/functions/_shared/data-platform/adapters/index.ts
import type { WarehouseConfig, WarehouseCredentials, BigQueryCredentials, PostgresCredentials, SnowflakeCredentials } from "../warehouse.ts";
import { createBigQueryAdapter } from "./bigquery.ts";
import { createPostgresAdapter } from "./postgres.ts";
import { createSnowflakeAdapter } from "./snowflake.ts";
import type { WarehouseAdapter } from "./types.ts";

export type { WarehouseAdapter, Check } from "./types.ts";
export { AdapterError } from "./types.ts";

export function openAdapter(config: WarehouseConfig, creds: WarehouseCredentials): Promise<WarehouseAdapter> {
  switch (config.kind) {
    case "bigquery": return createBigQueryAdapter(config, (creds as BigQueryCredentials).service_account_json);
    case "snowflake": return createSnowflakeAdapter(config, creds as SnowflakeCredentials);
    default: return createPostgresAdapter(config, (creds as PostgresCredentials).password);
  }
}
