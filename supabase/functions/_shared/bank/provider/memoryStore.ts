// supabase/functions/_shared/bank/provider/memoryStore.ts
// In-memory ResilienceStore for unit tests and local development. Not used in production paths.
import { INITIAL_HEALTH, type HealthSnapshot } from "./health.ts";
import type { PullRecord } from "./metering.ts";
import type { ResilienceStore } from "./resilient.ts";
import type { MeteredOperation, ProviderId } from "./types.ts";

export class MemoryResilienceStore implements ResilienceStore {
  health = new Map<ProviderId, HealthSnapshot>();
  pulls: PullRecord[] = [];
  rates = new Map<string, number>();

  setRate(provider: ProviderId, op: MeteredOperation, microsPerUnit: number): void {
    this.rates.set(`${provider}:${op}`, microsPerUnit);
  }
  getHealth(provider: ProviderId): Promise<HealthSnapshot> {
    return Promise.resolve(this.health.get(provider) ?? INITIAL_HEALTH);
  }
  saveHealth(provider: ProviderId, snap: HealthSnapshot): Promise<void> {
    this.health.set(provider, snap);
    return Promise.resolve();
  }
  recordPull(rec: PullRecord): Promise<void> {
    this.pulls.push(rec);
    return Promise.resolve();
  }
  getRateMicros(provider: ProviderId, op: MeteredOperation): Promise<number | null> {
    return Promise.resolve(this.rates.get(`${provider}:${op}`) ?? null);
  }
}
