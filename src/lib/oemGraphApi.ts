import { supabase } from '@/lib/supabase';
import {
  normalizeFleet,
  normalizeOemGraph,
  type OemFleetRow,
  type OemGraph,
  type OemNetworkStats,
} from '@/lib/oemGraph';

/**
 * Data access for the OEM Intelligence Graph.
 *
 * Deliberately separate from the existing OEM Intelligence / Equipment Passport code: those stay
 * untouched, so this feature cannot break them. Everything here is read-only; the database
 * (supabase/migrations/20270401000000_oem_intelligence_graph.sql) does the matching and scoping,
 * and every payload is normalised so a missing field can never crash the UI.
 */

/** Compact row for every active unit in the account (max 1000, newest first). */
export async function fetchOemGraphFleet(): Promise<OemFleetRow[]> {
  const { data, error } = await supabase.rpc('get_oem_graph_fleet');
  if (error) throw error;
  return normalizeFleet(data);
}

/** The full eight-step chain for one unit. `found: false` when the unit is not in this account. */
export async function fetchOemGraph(equipmentId: string): Promise<OemGraph> {
  const { data, error } = await supabase.rpc('get_oem_graph_for_equipment', { p_equipment_id: equipmentId });
  if (error) throw error;
  return normalizeOemGraph(data);
}

/** Headline stats of the network benchmark; null before the first refresh has run. */
export async function fetchOemNetworkStats(): Promise<OemNetworkStats | null> {
  const { data, error } = await supabase
    .from('oem_graph_stats')
    .select('contributing_businesses, units_observed, models_published, window_months, computed_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    contributing_businesses: n(row.contributing_businesses),
    units_observed: n(row.units_observed),
    models_published: n(row.models_published),
    window_months: n(row.window_months) || 36,
    computed_at: typeof row.computed_at === 'string' ? row.computed_at : null,
  };
}
