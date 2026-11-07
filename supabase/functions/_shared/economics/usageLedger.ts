// supabase/functions/_shared/economics/usageLedger.ts
//
// Prices quantity-only usage events (SMS segments, embedding tokens) into the ledger at write time using the
// versioned provider_cost_rates table. Rule: a rate is used ONLY when exactly one provider has a rate in effect for
// that component+unit on that date. Zero or several providers -> not written to the ledger (left unpriced in
// cost_usage_events, which the margin dashboard already reports), never guessed. NEVER throws.

import { appendCostEvent, componentToResource } from "./ledgerWriter.ts";
import { costMicro, resolveVersionedRate, type RateUnit, type VersionedRate } from "./microDollars.ts";

const COMPONENT_UNIT: Record<string, RateUnit | undefined> = {
  sms_segment: "per_segment",
  embeddings: "per_1m_input_tokens",
  // recording_storage / transcription / vision: quantity unit does not map 1:1 to a rate unit -> deliberately unmetered here.
};

export function pickUniqueRate(rates: readonly VersionedRate[], component: string, unit: RateUnit, onDate: string): VersionedRate | null {
  const providers = [...new Set(rates.filter((r) => r.component === component && r.unit === unit).map((r) => r.provider))];
  const hits = providers.map((p) => resolveVersionedRate(rates, component, p, unit, onDate)).filter((r): r is VersionedRate => r !== null);
  return hits.length === 1 ? hits[0] : null;
}

interface RateClient {
  from(table: string): { select(cols: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> };
}

let cache: { at: number; rows: VersionedRate[] } | null = null;
const TTL_MS = 5 * 60_000;

async function loadRates(admin: RateClient): Promise<VersionedRate[] | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const { data, error } = await admin.from("provider_cost_rates").select("id, component, provider, unit, rate_usd, effective_from, effective_to");
  if (error || !data) return null;
  const rows = (data as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), component: String(r.component), provider: String(r.provider), unit: r.unit as RateUnit,
    rateUsd: String(r.rate_usd), effectiveFrom: String(r.effective_from), effectiveTo: r.effective_to ? String(r.effective_to) : null,
  }));
  cache = { at: Date.now(), rows };
  return rows;
}

export interface UsageForLedger {
  userId: string | null; component: string; quantity: number; source: string; ref: string | null; estimated: boolean;
  callId?: string | null; jobId?: string | null;
}

export async function appendPricedUsage(admin: unknown, e: UsageForLedger, now: Date = new Date()): Promise<void> {
  try {
    const unit = COMPONENT_UNIT[e.component];
    if (!unit || !Number.isFinite(e.quantity) || e.quantity <= 0) return;
    const rates = await loadRates(admin as RateClient);
    if (!rates) return;
    const day = now.toISOString().slice(0, 10);
    const rate = pickUniqueRate(rates, e.component, unit, day);
    if (!rate) return;
    await appendCostEvent(admin as Parameters<typeof appendCostEvent>[0], {
      accountId: e.userId, provider: rate.provider, resourceType: componentToResource(e.component), component: e.component,
      quantity: e.quantity, unit, unitPriceUsd: rate.rateUsd, rateId: rate.id, priceEffectiveFrom: rate.effectiveFrom,
      costMicro: costMicro(e.quantity, rate.rateUsd, unit), basis: e.estimated ? "estimated" : "provider_reported",
      callId: e.callId ?? null, jobId: e.jobId ?? null, source: `usage:${e.source}`, ref: e.ref,
    });
  } catch (err) {
    console.error("[cost-ledger] usage not priced:", err);
  }
}
