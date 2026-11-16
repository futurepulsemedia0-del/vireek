// supabase/functions/_shared/price-book/drift.ts
//
// Pure drift detection between Vireek's imported price-book rows and what the provider returns right now.
// It only REPORTS. Nothing here (or in integration-reconcile) edits price_book_items.
//
// Note: ServiceTitan's fetcher requests active=true only, so "missing_in_provider" means "no longer active (or deleted)
// at the provider"; both are real drift from the tenant's point of view.

export interface LocalItem { external_id: string; service_name: string; price_cents: number; active: boolean }
export interface RemoteItem { external_id: string; service_name: string; price_cents: number; active: boolean }

export interface DriftReport {
  total: number;
  missing_in_vireek: string[];
  missing_in_provider: string[];
  price_mismatch: Array<{ external_id: string; vireek_cents: number; provider_cents: number }>;
  active_mismatch: Array<{ external_id: string; vireek_active: boolean; provider_active: boolean }>;
}

export function computeDrift(local: LocalItem[], remote: RemoteItem[]): DriftReport {
  const l = new Map(local.map((i) => [i.external_id, i]));
  const r = new Map(remote.map((i) => [i.external_id, i]));
  const report: DriftReport = { total: 0, missing_in_vireek: [], missing_in_provider: [], price_mismatch: [], active_mismatch: [] };

  for (const [id, item] of r) {
    const mine = l.get(id);
    if (!mine) { if (item.active) report.missing_in_vireek.push(id); continue; }
    if (mine.price_cents !== item.price_cents) report.price_mismatch.push({ external_id: id, vireek_cents: mine.price_cents, provider_cents: item.price_cents });
    if (mine.active !== item.active) report.active_mismatch.push({ external_id: id, vireek_active: mine.active, provider_active: item.active });
  }
  for (const [id, mine] of l) if (!r.has(id) && mine.active) report.missing_in_provider.push(id);

  report.total = report.missing_in_vireek.length + report.missing_in_provider.length + report.price_mismatch.length + report.active_mismatch.length;
  return report;
}

/** Keeps stored details small and free of business data beyond ids/amounts. */
export function summarizeDrift(r: DriftReport, cap = 25) {
  return {
    missing_in_vireek: r.missing_in_vireek.slice(0, cap),
    missing_in_provider: r.missing_in_provider.slice(0, cap),
    price_mismatch: r.price_mismatch.slice(0, cap),
    active_mismatch: r.active_mismatch.slice(0, cap),
  };
}
