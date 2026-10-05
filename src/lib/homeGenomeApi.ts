import { supabase } from '@/lib/supabase';
import type { GenomeEventResult, GenomeSystemKey, ManualEventKind, ManualGenomeEvent } from '@/lib/homeGenome';

/**
 * Persistence for hand-recorded Home Genome history.
 *
 * Deliberately separate from get_customer_site_hierarchy() and fetchPropertyTwin():
 * those stay untouched, so this feature cannot break the existing digital twin.
 * The table is created by supabase/migrations/20270401000000_home_genome.sql.
 */

const MAX_EVENTS = 500;

type Row = {
  id: string;
  system_key: GenomeSystemKey;
  equipment_id: string | null;
  event_kind: ManualEventKind;
  occurred_on: string;
  title: string;
  note: string | null;
  cost_usd: number | string | null;
};

const toEvent = (row: Row): ManualGenomeEvent => ({
  id: row.id,
  system_key: row.system_key,
  equipment_id: row.equipment_id,
  event_kind: row.event_kind,
  occurred_on: row.occurred_on,
  title: row.title,
  note: row.note,
  cost_usd: row.cost_usd === null ? null : Number(row.cost_usd),
});

/** Recorded history for a property, newest first. Throws if the table is unavailable. */
export async function fetchGenomeEvents(siteId: string): Promise<ManualGenomeEvent[]> {
  const { data, error } = await supabase
    .from('home_genome_events')
    .select('id, system_key, equipment_id, event_kind, occurred_on, title, note, cost_usd')
    .eq('site_id', siteId)
    .order('occurred_on', { ascending: false })
    .limit(MAX_EVENTS);
  if (error) throw error;
  return ((data ?? []) as Row[]).map(toEvent);
}

/** Adds one recorded event. `value` must come from validateGenomeEventInput(). */
export async function saveGenomeEvent(siteId: string, value: Extract<GenomeEventResult, { ok: true }>['value']): Promise<void> {
  const { data, error } = await supabase.from('home_genome_events').insert({ site_id: siteId, ...value }).select('id');
  if (error) throw error;
  // RLS can turn a forbidden write into "0 rows, no error" — never report that as saved.
  if (!data || data.length === 0) throw new Error('This event could not be saved.');
}

/** Removes one recorded event. Only hand-recorded history can be removed; derived events cannot. */
export async function deleteGenomeEvent(id: string): Promise<void> {
  const { data, error } = await supabase.from('home_genome_events').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('This event could not be removed.');
}
