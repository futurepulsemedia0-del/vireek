// supabase/functions/_shared/bank/provider/supabaseStore.ts
// ResilienceStore backed by the RPCs in 20290306000000_bank_provider_resilience.sql (service role only).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { INITIAL_HEALTH, type HealthSnapshot, type HealthState } from "./health.ts";
import type { PullRecord } from "./metering.ts";
import type { ResilienceStore } from "./resilient.ts";
import type { MeteredOperation, ProviderErrorKind, ProviderId } from "./types.ts";

const RATE_TTL_MS = 5 * 60_000;
const STATES: ReadonlySet<string> = new Set(["healthy", "degraded", "down"]);

export function createSupabaseStore(db: SupabaseClient): ResilienceStore {
  const rateCache = new Map<string, { v: number | null; at: number }>();
  return {
    async getHealth(provider: ProviderId): Promise<HealthSnapshot> {
      const { data, error } = await db.from("bank_provider_health").select("*").eq("provider", provider).maybeSingle();
      if (error) throw error;
      if (!data) return INITIAL_HEALTH;
      return {
        state: (STATES.has(data.state) ? data.state : "healthy") as HealthState,
        consecutiveFailures: Number(data.consecutive_failures ?? 0),
        lastSuccessAt: data.last_success_at ?? null,
        lastFailureAt: data.last_failure_at ?? null,
        lastErrorKind: (data.last_error_kind ?? null) as ProviderErrorKind | null,
        circuitOpenUntil: data.circuit_open_until ?? null,
      };
    },
    async saveHealth(provider, s) {
      const { error } = await db.rpc("bank_provider_save_health", {
        p_provider: provider, p_state: s.state, p_consecutive_failures: s.consecutiveFailures,
        p_last_success_at: s.lastSuccessAt, p_last_failure_at: s.lastFailureAt,
        p_last_error_kind: s.lastErrorKind, p_circuit_open_until: s.circuitOpenUntil,
      });
      if (error) throw error;
    },
    async recordPull(r: PullRecord) {
      const { error } = await db.rpc("bank_record_pull", {
        p_user_id: r.userId, p_connection_id: r.connectionId, p_provider: r.provider, p_operation: r.operation,
        p_units: r.units, p_status: r.status, p_error_kind: r.errorKind, p_duration_ms: r.durationMs, p_cost_micros: r.costMicros,
      });
      if (error) throw error;
    },
    async getRateMicros(provider: ProviderId, op: MeteredOperation) {
      const key = `${provider}:${op}`;
      const hit = rateCache.get(key);
      if (hit && Date.now() - hit.at < RATE_TTL_MS) return hit.v;
      const { data, error } = await db.from("bank_provider_rates").select("micros_per_unit")
        .eq("provider", provider).eq("operation", op).lte("effective_from", new Date().toISOString())
        .order("effective_from", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      const v = data ? Number(data.micros_per_unit) : null;
      rateCache.set(key, { v, at: Date.now() });
      return v;
    },
  };
}
