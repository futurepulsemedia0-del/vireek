import { supabase } from '@/lib/supabase';
import type { BusinessHours, VoiceCallRow, VoiceInvoiceRow, VoiceJobRow, VoiceReportInput } from '@/lib/voiceMetrics';

const PAGE = 1000;
const CHUNK = 150;

async function pageAll<T>(run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

export async function fetchVoiceReportInput(start: Date, end: Date): Promise<VoiceReportInput> {
  const calls = await pageAll<VoiceCallRow>((f, t) =>
    supabase.from('calls')
      .select('id, call_datetime, status, is_voicemail, is_emergency, duration_seconds, human_transfer_requested, escalated_to, vapi_call_id')
      .gte('call_datetime', start.toISOString()).lt('call_datetime', end.toISOString())
      .order('call_datetime', { ascending: true }).range(f, t) as unknown as PromiseLike<{ data: VoiceCallRow[] | null; error: { message: string } | null }>);

  const ids = calls.map((c) => c.id);
  const jobs: VoiceJobRow[] = [];
  const invoices: VoiceInvoiceRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase.from('jobs').select('id, call_id').in('call_id', ids.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    jobs.push(...((data ?? []) as VoiceJobRow[]));
  }
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const { data, error } = await supabase.from('invoices').select('job_id, status, line_items').in('job_id', jobs.slice(i, i + CHUNK).map((j) => j.id));
    if (error) throw new Error(error.message);
    invoices.push(...((data ?? []) as VoiceInvoiceRow[]));
  }

  const { data: bp } = await supabase.from('business_profile').select('business_hours, holidays, timezone').maybeSingle();
  const hol = Array.isArray(bp?.holidays) ? (bp!.holidays as Array<{ date?: string }>).map((h) => h?.date).filter((d): d is string => typeof d === 'string') : [];
  return {
    calls, jobs, invoices,
    businessHours: (bp?.business_hours as BusinessHours | null) ?? null,
    holidays: hol,
    timezone: typeof bp?.timezone === 'string' && bp.timezone ? bp.timezone : null,
  };
}
