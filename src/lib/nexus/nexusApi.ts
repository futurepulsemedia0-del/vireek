/**
 * Nexus tracker — data access (staff only).
 * Thin wrappers over the SECURITY DEFINER RPCs in supabase/migrations/20290304000000_nexus_tracker.sql.
 * Authorization (is_vireek_staff) and audit logging are enforced by the database; the page also sits behind <StaffRoute>.
 */
import { supabase } from '@/lib/supabase';
import { parseRevenueReport, type RevenueReport } from '@/lib/nexus/nexusTracker';

export async function fetchNexusRevenue(asOf?: string): Promise<RevenueReport> {
  const { data, error } = await supabase.rpc('staff_nexus_revenue', asOf ? { p_as_of: asOf } : {});
  if (error) throw error;
  return parseRevenueReport(data);
}

/** Records a CSV export in staff_audit_log. Best-effort: an audit failure is reported to the caller, who decides. */
export async function logNexusExport(rows: number): Promise<void> {
  const { error } = await supabase.rpc('staff_nexus_log_export', { p_rows: rows });
  if (error) throw error;
}
