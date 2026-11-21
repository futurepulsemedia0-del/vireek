// supabase/functions/_shared/bank/provider/index.ts
// Single import point for edge functions.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { createPlaidProvider } from "./plaidProvider.ts";
import { createSupabaseStore } from "./supabaseStore.ts";
import { withResilience, type ResilienceContext } from "./resilient.ts";
import type { BankDataProvider } from "./types.ts";

export * from "./types.ts";
export * from "./health.ts";
export * from "./metering.ts";
export { withResilience, type ResilienceStore, type ResilienceContext } from "./resilient.ts";
export { createPlaidProvider, mapPlaidError } from "./plaidProvider.ts";
export { createSupabaseStore } from "./supabaseStore.ts";

/** Production wiring: Plaid behind the resilience decorator, state and metering in Postgres. */
export function getBankProvider(db: SupabaseClient, ctx?: ResilienceContext): BankDataProvider {
  return withResilience(createPlaidProvider(), {
    store: createSupabaseStore(db),
    ctx,
    log: (e) => console.log(JSON.stringify(e)),
  });
}
