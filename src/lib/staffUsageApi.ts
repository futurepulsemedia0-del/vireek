import { supabase } from '@/lib/supabase';
import { parseReport, type UsageReport } from '@/lib/staffUsage';

export class StaffUsageError extends Error {
  constructor(message: string, readonly forbidden: boolean) {
    super(message);
  }
}

/** Staff-only. The RPC itself re-checks profiles.is_staff, so this is safe even if the route guard is bypassed. */
export async function fetchUsageReport(start: Date, end: Date): Promise<UsageReport> {
  const { data, error } = await supabase.rpc('staff_usage_report', {
    p_start: start.toISOString(),
    p_end: end.toISOString(),
  });
  if (error) throw new StaffUsageError(error.message, error.code === '42501');
  const report = parseReport(data);
  if (!report) throw new StaffUsageError('Unexpected response from the usage report.', false);
  return report;
}
