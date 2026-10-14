import { supabase } from '@/lib/supabase';
import { fetchPatternExposure } from '@/lib/failureGenome';
import type { ExposureRow } from '@/lib/failureGenome';
import { gatherMarketInput } from '@/lib/partsMarket';
import type { MarketInput, MarketPart } from '@/lib/partsMarket';
import { normalizeDetail, normalizeOverview } from '@/lib/partsIntelligence';
import type { InstallOutcomeRow, PartFailureEvent, PiDetail, PiOverviewRow } from '@/lib/partsIntelligence';

/**
 * Data access for Parts Intelligence.
 *
 * Owns no tables. Reads the two read-only RPCs from
 * supabase/migrations/20270601000000_parts_intelligence.sql and re-uses the existing
 * Parts Market / Failure Genome / Supply Chain modules for everything else.
 */

export async function fetchPartsOverview(): Promise<PiOverviewRow[]> {
  const { data, error } = await supabase.rpc('get_parts_intelligence_overview');
  if (error) throw error;
  return normalizeOverview(data);
}

export async function fetchPartDetail(partId: string): Promise<PiDetail> {
  const { data, error } = await supabase.rpc('get_parts_intelligence_detail', { p_part_id: partId });
  if (error) throw error;
  return normalizeDetail(data);
}

interface FailureEventQueryRow {
  id: string;
  equipment_id: string;
  occurred_on: string;
  age_months: number | null;
  failure_component: string;
  failure_mode: string | null;
  repair_action: string | null;
  parts_replaced: string[] | null;
  outcome: string;
  repair_cost: number | null;
  equipment: { make: string | null; model: string | null } | { make: string | null; model: string | null }[] | null;
}

/**
 * Recent failure events that name at least one replaced part. Fetched ONCE for the whole page and
 * matched to parts client-side (technicians type free text like "run capacitor", so exact SQL
 * equality would miss most of them — see partMatchesTag in partsIntelligence.ts).
 */
export async function fetchRecentPartFailureEvents(limit = 600): Promise<PartFailureEvent[]> {
  const { data, error } = await supabase
    .from('equipment_failure_events')
    .select(
      'id, equipment_id, occurred_on, age_months, failure_component, failure_mode, repair_action, parts_replaced, outcome, repair_cost, equipment:equipment_id (make, model)',
    )
    .order('occurred_on', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as FailureEventQueryRow[])
    .filter((r) => Array.isArray(r.parts_replaced) && r.parts_replaced.length > 0)
    .map((r) => {
      const eq = Array.isArray(r.equipment) ? r.equipment[0] : r.equipment;
      return {
        id: r.id,
        equipment_id: r.equipment_id,
        occurred_on: r.occurred_on,
        age_months: r.age_months,
        failure_component: r.failure_component,
        failure_mode: r.failure_mode,
        repair_action: r.repair_action,
        parts_replaced: r.parts_replaced ?? [],
        outcome: r.outcome,
        repair_cost: r.repair_cost,
        make: eq?.make ?? null,
        model: eq?.model ?? null,
      };
    });
}

/** Real installs of this part with the job outcome each one produced (existing Supply Chain read model). */
export async function fetchInstallOutcomes(partId: string): Promise<InstallOutcomeRow[]> {
  const { data, error } = await supabase
    .from('supply_chain_install_outcomes')
    .select('install_id, quantity, installed_at, supplier_name, outcome_class, defect_attributed')
    .eq('part_id', partId)
    .order('installed_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as InstallOutcomeRow[];
}

/** Network failure patterns that touch MY units. Empty when the business has opted out of the genome. */
export async function fetchPopulationPatterns(): Promise<ExposureRow[]> {
  try {
    return await fetchPatternExposure(true);
  } catch {
    return [];
  }
}

/**
 * Everything the EXISTING Parts Market engine needs for this part (offers, price history, stock,
 * substitutes). The page runs evaluateMarket() on it, so changing the quantity re-ranks instantly
 * without another round-trip and there is no second pricing/sourcing model.
 */
export async function fetchSourcingInput(part: MarketPart, allParts: MarketPart[]): Promise<MarketInput> {
  return gatherMarketInput(part, allParts);
}
