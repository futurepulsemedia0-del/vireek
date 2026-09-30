import { supabase } from '@/lib/supabase';
import { isValidYearBuilt } from '@/lib/lifetimeServicePlan';

/**
 * Year-built persistence for the Lifetime Service Plan.
 *
 * Deliberately separate from get_customer_site_hierarchy(): that RPC (and the
 * PropertyTwin built from it) stays untouched, so this feature cannot break the
 * existing digital twin. The column is added by
 * supabase/migrations/20270110000000_lifetime_service_plan.sql.
 */

export async function fetchSiteYearBuilt(siteId: string): Promise<number | null> {
  const { data, error } = await supabase.from('customer_sites').select('year_built').eq('id', siteId).maybeSingle();
  if (error) throw error;
  const value = (data as { year_built: number | null } | null)?.year_built;
  return typeof value === 'number' ? value : null;
}

/** Saves (or clears, with null) the year built. Resolves with the value the database now holds. */
export async function saveSiteYearBuilt(siteId: string, yearBuilt: number | null): Promise<number | null> {
  if (yearBuilt !== null && !isValidYearBuilt(yearBuilt)) {
    throw new Error('Enter a valid four-digit year (1700 to next year).');
  }
  const { data, error } = await supabase
    .from('customer_sites')
    .update({ year_built: yearBuilt, updated_at: new Date().toISOString() })
    .eq('id', siteId)
    .select('year_built');
  if (error) throw error;
  // RLS can turn a forbidden update into "0 rows, no error" — never report that as saved.
  if (!data || data.length === 0) throw new Error('This property could not be updated.');
  const value = (data[0] as { year_built: number | null }).year_built;
  return typeof value === 'number' ? value : null;
}
