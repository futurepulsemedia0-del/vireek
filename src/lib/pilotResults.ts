/**
 * Pilot Results — client library. All numbers come from the pilot_results() RPC (database only);
 * this file only fetches, writes manual hours / fee %, and downloads the CSV.
 */
import { supabase } from '@/lib/supabase';
import { parsePilotResults, resultsToCsv, type PilotResults } from '../../supabase/functions/_shared/pilot-results/engine';

export * from '../../supabase/functions/_shared/pilot-results/engine';
export { formatMoney } from '../../supabase/functions/_shared/money-recovered/engine';

export interface HoursEntry { id: string; entry_on: string; minutes: number; note: string | null }

export async function fetchPilotResults(): Promise<PilotResults | null> {
  const { data, error } = await supabase.rpc('pilot_results');
  if (error) throw new Error(error.message);
  return parsePilotResults(data);
}

export async function startPilot(): Promise<PilotResults | null> {
  const { data, error } = await supabase.rpc('pilot_start');
  if (error) throw new Error(error.message);
  return parsePilotResults(data);
}

export async function setFeePct(pct: number | null): Promise<void> {
  const { error } = await supabase.rpc('pilot_set_fee_pct', { p_pct: pct });
  if (error) throw new Error(error.message);
}

/** "12.5" -> 12.5; "" -> null (clear); invalid -> undefined. */
export function parseFeeInput(v: string): number | null | undefined {
  const s = v.trim().replace('%', '');
  if (s === '') return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 0 && n <= 100 ? n : undefined;
}

/** "1.5" hours or "90" minutes ("90m") -> minutes (1..1440); invalid -> null. */
export function parseHoursInput(v: string): number | null {
  const s = v.trim().toLowerCase();
  const m = /^(\d+)\s*m$/.exec(s);
  const minutes = m ? Number(m[1]) : /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 60) : NaN;
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : null;
}

export async function listHours(): Promise<HoursEntry[]> {
  const { data, error } = await supabase.from('pilot_hours').select('id,entry_on,minutes,note').order('entry_on', { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as HoursEntry[];
}

export async function addHours(tenantId: string, minutes: number, note: string): Promise<void> {
  const { error } = await supabase.from('pilot_hours').insert({ tenant_id: tenantId, minutes, note: note.trim() || null });
  if (error) throw new Error(error.message);
}

export async function deleteHours(id: string): Promise<void> {
  const { error } = await supabase.from('pilot_hours').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export function downloadResultsCsv(p: PilotResults): void {
  const blob = new Blob([resultsToCsv(p)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pilot-results-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
