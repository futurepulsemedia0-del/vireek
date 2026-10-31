// src/lib/importSavedMappings.ts
//
// Saved column mappings per account + source + import type (table import_saved_mappings, RLS:
// readable by the account, writable only with the import permission). The mapping the user
// confirmed last time wins over auto-detection whenever its column still exists in the new file,
// so the second export from the same system maps itself.

import { supabase } from './supabase';
import type { FieldMapping, ImportPresetId, ImportType } from './importPresets';

export interface MergedMapping {
  mapping: FieldMapping;
  /** fields still filled by auto-detection (shown with the "Auto" badge); saved fields are not "auto" */
  auto: string[];
}

/** Pure: saved headers (that still exist in the file and belong to a known field) override auto-detection. */
export function mergeSavedMapping(auto: FieldMapping, saved: FieldMapping | null, headers: string[], allowedKeys: string[]): MergedMapping {
  if (!saved) return { mapping: auto, auto: Object.keys(auto) };
  const headerSet = new Set(headers);
  const allowed = new Set(allowedKeys);
  const fromSaved: FieldMapping = {};
  for (const [field, header] of Object.entries(saved)) {
    if (allowed.has(field) && typeof header === 'string' && headerSet.has(header)) fromSaved[field] = header;
  }
  const claimed = new Set(Object.values(fromSaved));
  const mapping: FieldMapping = { ...fromSaved };
  const autoKeys: string[] = [];
  for (const [field, header] of Object.entries(auto)) {
    if (field in fromSaved || claimed.has(header)) continue; // never map one column to two fields
    mapping[field] = header;
    autoKeys.push(field);
  }
  return { mapping, auto: autoKeys };
}

export async function loadSavedMapping(accountOwnerId: string, source: ImportPresetId, type: ImportType): Promise<FieldMapping | null> {
  const { data, error } = await supabase
    .from('import_saved_mappings')
    .select('mapping')
    .eq('user_id', accountOwnerId)
    .eq('source', source)
    .eq('import_type', type)
    .maybeSingle();
  if (error || !data) return null;
  const m = (data as { mapping: unknown }).mapping;
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as FieldMapping) : null;
}

export async function saveMapping(accountOwnerId: string, source: ImportPresetId, type: ImportType, mapping: FieldMapping): Promise<void> {
  const clean = Object.fromEntries(Object.entries(mapping).filter(([, v]) => Boolean(v)));
  const { error } = await supabase
    .from('import_saved_mappings')
    .upsert({ user_id: accountOwnerId, source, import_type: type, mapping: clean, updated_at: new Date().toISOString() }, { onConflict: 'user_id,source,import_type' });
  if (error) throw new Error(error.message);
}
