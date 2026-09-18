// supabase/functions/_shared/financing/registry.ts
//
// Add a second provider (Sunbit, Service Finance, ...) by writing a new
// providers/<name>.ts implementing FinancingProviderAdapter and adding
// one line here — nothing else in the financing system changes.

import type { FinancingProviderAdapter, FinancingProviderId } from "./types.ts";
import { wisetackAdapter } from "./providers/wisetack.ts";

export const FINANCING_PROVIDERS: Record<FinancingProviderId, FinancingProviderAdapter> = {
  wisetack: wisetackAdapter,
};

export function getFinancingProvider(id: FinancingProviderId): FinancingProviderAdapter {
  const adapter = FINANCING_PROVIDERS[id];
  if (!adapter) throw new Error(`Unknown financing provider "${id}".`);
  return adapter;
}
