// Customer ROI client. Inputs come from tenant_ai_roi_inputs() (OWNER-only, the caller's own rows); every number and
// its formula/source is produced by supabase/functions/_shared/economics/aiRoi.ts so the dashboard and the monthly
// email can never disagree.
import { supabase } from '@/lib/supabase';
import { computeAiRoi, parseAiRoiRaw, type AiRoi } from '../../supabase/functions/_shared/economics/aiRoi';

export async function fetchAiRoi(days: number): Promise<AiRoi> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const { data, error } = await supabase.rpc('tenant_ai_roi_inputs', { p_start: start.toISOString(), p_end: end.toISOString() });
  if (error) throw new Error(error.message);
  const raw = parseAiRoiRaw(data);
  if (!raw) throw new Error('Unexpected ROI payload');
  return computeAiRoi(raw);
}
