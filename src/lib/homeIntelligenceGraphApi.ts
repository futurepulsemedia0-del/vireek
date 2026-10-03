import { supabase } from '@/lib/supabase';
import type { EnergyReading } from '@/lib/homeIntelligenceGraph';

/**
 * Energy-reading persistence for the Home Intelligence Graph.
 *
 * Deliberately separate from get_customer_site_hierarchy() and fetchPropertyTwin():
 * those stay untouched, so this feature cannot break the existing digital twin.
 * The table is created by supabase/migrations/20270215000000_home_intelligence_graph.sql.
 */

const HISTORY_MONTHS = 36;

/** Latest readings for a property, newest first. Throws if the table is unavailable. */
export async function fetchEnergyReadings(siteId: string): Promise<EnergyReading[]> {
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - HISTORY_MONTHS);
  const { data, error } = await supabase
    .from('home_energy_readings')
    .select('period_start, energy_kwh, cost_usd')
    .eq('site_id', siteId)
    .gte('period_start', since.toISOString().slice(0, 10))
    .order('period_start', { ascending: false })
    .limit(HISTORY_MONTHS + 1);
  if (error) throw error;
  return ((data ?? []) as Array<{ period_start: string; energy_kwh: number | string; cost_usd: number | string | null }>).map((row) => ({
    period_start: row.period_start,
    energy_kwh: Number(row.energy_kwh),
    cost_usd: row.cost_usd === null ? null : Number(row.cost_usd),
  }));
}

/** Adds or replaces the reading for one month (one row per property per month). */
export async function saveEnergyReading(siteId: string, periodStart: string, energyKwh: number, costUsd: number | null): Promise<void> {
  const { data, error } = await supabase
    .from('home_energy_readings')
    .upsert({ site_id: siteId, period_start: periodStart, energy_kwh: energyKwh, cost_usd: costUsd }, { onConflict: 'site_id,period_start' })
    .select('id');
  if (error) throw error;
  // RLS can turn a forbidden write into "0 rows, no error" — never report that as saved.
  if (!data || data.length === 0) throw new Error('This reading could not be saved.');
}
