// FSM availability gate: "may Vireek offer / confirm this start time?"
//
// - No FSM write-back configured for the tenant  => no gating (gate.provider === null).
// - ServiceTitan job write-back configured       => start must fall inside a window ServiceTitan reports as open.
// - Any read failure                             => FsmAvailabilityError (caller MUST fail closed).
// Results are cached per tenant+UTC-day-aligned range for 60 s and concurrent identical reads share one request.
import {
  FsmAvailabilityError,
  fetchServiceTitanCapacity,
  slotAllowedByWindows,
  type CapacityDeps,
  type FsmWindow,
  type ServiceTitanCapacityConfig,
} from "./serviceTitanCapacity.ts";

export type FsmGate =
  | { provider: null; allows: (startMs: number) => boolean }
  | { provider: "service_titan"; fetchedAt: number; windows: readonly FsmWindow[]; allows: (startMs: number) => boolean };

export interface GateDeps {
  /** Returns the tenant's ServiceTitan config ONLY when job write-back is configured (BU + job type), else null. */
  loadServiceTitanConfig: (userId: string) => Promise<ServiceTitanCapacityConfig | null>;
  capacity?: CapacityDeps;
  now?: () => number;
  /** Test seam; defaults to fetchServiceTitanCapacity. */
  fetchCapacity?: typeof fetchServiceTitanCapacity;
}

export const GATE_TTL_MS = 60_000;
const MAX_ENTRIES = 500;
const DAY_MS = 86_400_000;

type Entry = { at: number; windows: readonly FsmWindow[] };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<readonly FsmWindow[]>>();

export function clearFsmGateCache(): void {
  cache.clear();
  inflight.clear();
}

const NO_GATE: FsmGate = { provider: null, allows: () => true };

export async function resolveFsmGate(
  deps: GateDeps,
  userId: string,
  range: { fromMs: number; toMs: number },
): Promise<FsmGate> {
  const now = (deps.now ?? Date.now)();
  const config = await deps.loadServiceTitanConfig(userId);
  if (!config) return NO_GATE;

  const from = Math.floor(range.fromMs / DAY_MS) * DAY_MS;
  const to = Math.ceil(range.toMs / DAY_MS) * DAY_MS;
  const key = `${userId}:${config.st_tenant_id}:${from}:${to}`;

  let windows: readonly FsmWindow[];
  const hit = cache.get(key);
  if (hit && now - hit.at < GATE_TTL_MS) {
    windows = hit.windows;
  } else {
    let p = inflight.get(key);
    if (!p) {
      p = (deps.fetchCapacity ?? fetchServiceTitanCapacity)(config, { fromMs: from, toMs: to }, { ...deps.capacity, now: deps.now })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    windows = await p; // rejects with FsmAvailabilityError => caller fails closed; failures are never cached
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: now, windows });
  }
  return { provider: "service_titan", fetchedAt: hit?.at ?? now, windows, allows: (startMs) => slotAllowedByWindows(windows, startMs) };
}

export { FsmAvailabilityError };
