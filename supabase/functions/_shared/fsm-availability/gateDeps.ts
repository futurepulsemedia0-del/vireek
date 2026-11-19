// Supabase-backed loader for the FSM gate (Deno edge runtime only: uses the credential vault).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { hydrateRow } from "../secrets/providerCredentials.ts";
import type { GateDeps } from "./gate.ts";
import type { ServiceTitanCapacityConfig } from "./serviceTitanCapacity.ts";

interface Row {
  provider: string;
  st_client_id: string | null;
  st_client_secret: string | null;
  st_app_key: string | null;
  st_tenant_id: string | null;
  st_business_unit_id: string | null;
  st_job_type_id: string | null;
}

/** Only tenants whose jobs are actually written to ServiceTitan (business unit + job type set) are gated. */
export function supabaseGateDeps(admin: SupabaseClient): GateDeps {
  return {
    capacity: { env: Deno.env.get("SERVICETITAN_ENV") === "integration" ? "integration" : "production" },
    async loadServiceTitanConfig(userId): Promise<ServiceTitanCapacityConfig | null> {
      const { data, error } = await admin
        .from("price_book_connections")
        .select("provider, st_client_id, st_client_secret, st_app_key, st_tenant_id, st_business_unit_id, st_job_type_id")
        .eq("user_id", userId)
        .eq("provider", "service_titan")
        .eq("status", "connected")
        .maybeSingle();
      if (error) throw new Error("fsm_connection_lookup_failed");
      if (!data) return null;
      const row = await hydrateRow(admin, userId, data as Row);
      if (!row.st_business_unit_id || !row.st_job_type_id) return null;
      return {
        st_client_id: row.st_client_id ?? "",
        st_client_secret: row.st_client_secret ?? "",
        st_app_key: row.st_app_key ?? "",
        st_tenant_id: row.st_tenant_id ?? "",
        st_business_unit_id: row.st_business_unit_id,
        st_job_type_id: row.st_job_type_id,
      };
    },
  };
}
