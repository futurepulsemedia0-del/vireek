// supabase/functions/_shared/bank/provider/resilient.ts
//
// Decorator that gives ANY BankDataProvider: circuit breaker, health tracking and per-pull metering.
// Bookkeeping is best-effort: a failure of the health/metering store must never break the data path
// (fail-open), and a metering write must never change what the caller sees.
//
// Webhook helpers (verify/parse) are deliberately NOT gated by the circuit: refusing inbound webhooks
// during an outage would drop events the provider will not necessarily redeliver.

import { admit, DEFAULT_HEALTH_POLICY, INITIAL_HEALTH, onFailure, onSuccess, type HealthPolicy, type HealthSnapshot } from "./health.ts";
import { costForStatus, type PullRecord } from "./metering.ts";
import {
  BankProviderError,
  type BankDataProvider,
  type LinkTokenInput,
  type MeteredOperation,
  type ProviderId,
} from "./types.ts";

export interface ResilienceStore {
  getHealth(provider: ProviderId): Promise<HealthSnapshot>;
  saveHealth(provider: ProviderId, snap: HealthSnapshot): Promise<void>;
  recordPull(rec: PullRecord): Promise<void>;
  getRateMicros(provider: ProviderId, op: MeteredOperation): Promise<number | null>;
}

export interface ResilienceContext {
  userId: string | null;
  connectionId: string | null;
}

export interface ResilientOptions {
  store: ResilienceStore;
  ctx?: ResilienceContext;
  now?: () => Date;
  policy?: HealthPolicy;
  /** Called for observability; must not throw. */
  log?: (event: Record<string, unknown>) => void;
}

const noCtx: ResilienceContext = { userId: null, connectionId: null };

export function withResilience(inner: BankDataProvider, opts: ResilientOptions): BankDataProvider {
  const now = opts.now ?? (() => new Date());
  const policy = opts.policy ?? DEFAULT_HEALTH_POLICY;
  const ctx = opts.ctx ?? noCtx;
  const log = opts.log ?? (() => {});

  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (e) {
      log({ event: "bank_resilience_store_error", label, error: e instanceof Error ? e.message : String(e) });
      return fallback;
    }
  };

  const meter = async (op: MeteredOperation, units: number, status: PullRecord["status"], errorKind: string | null, durationMs: number) => {
    const rate = status === "blocked" ? null : await safe("rate", () => opts.store.getRateMicros(inner.id, op), null);
    await safe("record", () => opts.store.recordPull({
      userId: ctx.userId, connectionId: ctx.connectionId, provider: inner.id, operation: op, units,
      status, errorKind, durationMs, costMicros: costForStatus(status, units, rate),
    }), undefined);
  };

  async function guard<T>(op: MeteredOperation, fn: () => Promise<T>, units = 1): Promise<T> {
    const health = await safe("get_health", () => opts.store.getHealth(inner.id), INITIAL_HEALTH);
    const decision = admit(health, now(), policy);
    if (!decision.allowed) {
      await meter(op, units, "blocked", "circuit_open", 0);
      throw new BankProviderError("provider_unavailable", "CIRCUIT_OPEN", "Bank data provider is temporarily unavailable.", inner.id, 0, decision.retryAfterMs);
    }
    if (decision.probe) await safe("save_lease", () => opts.store.saveHealth(inner.id, decision.lease), undefined);

    const started = now().getTime();
    try {
      const out = await fn();
      await safe("save_health", () => opts.store.saveHealth(inner.id, onSuccess(health, now())), undefined);
      await meter(op, units, "ok", null, now().getTime() - started);
      return out;
    } catch (e) {
      const err = e instanceof BankProviderError ? e : new BankProviderError("unknown", "UNCLASSIFIED", e instanceof Error ? e.message : String(e), inner.id);
      const next = onFailure(health, err.kind, now(), policy);
      if (next !== health) await safe("save_health", () => opts.store.saveHealth(inner.id, next), undefined);
      if (next.state !== health.state) log({ event: "bank_provider_state_change", provider: inner.id, from: health.state, to: next.state, kind: err.kind });
      await meter(op, units, "error", err.kind, now().getTime() - started);
      throw err;
    }
  }

  return {
    id: inner.id,
    isConfigured: () => inner.isConfigured(),
    createLinkToken: (i: LinkTokenInput) => guard("link_token", () => inner.createLinkToken(i)),
    exchangePublicToken: (t: string) => guard("exchange", () => inner.exchangePublicToken(t)),
    getAccounts: (t: string) => guard("accounts", () => inner.getAccounts(t)),
    syncTransactions: (t: string, c: string | null) => guard("transactions_page", () => inner.syncTransactions(t, c)),
    removeItem: (t: string) => guard("remove_item", () => inner.removeItem(t)),
    verifyWebhook: (raw: string, sig: string | null) => inner.verifyWebhook(raw, sig),
    parseWebhook: (raw: string) => inner.parseWebhook(raw),
  };
}
