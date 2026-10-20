// src/lib/hoursAuditTemplates.ts
//
// Saved column-mapping templates for the Hours-Leak Audit. Only the mapping and the
// owner's assumptions are stored — never job rows, names or addresses.

import { supabase } from './supabase';
import { EMPTY_MAPPING, sanitizeSettings, type AuditMapping, type AuditSettings } from './hoursAudit';

export interface AuditTemplate {
  id: string;
  name: string;
  mapping: AuditMapping;
  settings: AuditSettings;
  updated_at: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function normalize(row: { id: string; name: string; mapping: unknown; settings: unknown; updated_at: string }): AuditTemplate {
  const m = (row.mapping ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    name: row.name,
    mapping: { ...EMPTY_MAPPING, technician: str(m.technician), start: str(m.start), end: str(m.end), duration: str(m.duration), billable: str(m.billable), durationUnit: m.durationUnit === 'hours' ? 'hours' : 'minutes' },
    settings: sanitizeSettings((row.settings ?? {}) as Partial<AuditSettings>),
    updated_at: row.updated_at,
  };
}

export async function listAuditTemplates(accountOwnerId: string): Promise<AuditTemplate[]> {
  const { data, error } = await supabase
    .from('hours_audit_templates')
    .select('id,name,mapping,settings,updated_at')
    .eq('user_id', accountOwnerId)
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).map(normalize);
}

/** Creates the template, or updates the one with the same name (case-insensitive). */
export async function saveAuditTemplate(accountOwnerId: string, name: string, mapping: AuditMapping, settings: AuditSettings): Promise<void> {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new Error('Give the template a name.');
  const existing = (await listAuditTemplates(accountOwnerId)).find((t) => t.name.trim().toLowerCase() === clean.toLowerCase());
  const { error } = existing
    ? await supabase.from('hours_audit_templates').update({ mapping, settings, updated_at: new Date().toISOString() }).eq('id', existing.id).eq('user_id', accountOwnerId)
    : await supabase.from('hours_audit_templates').insert({ user_id: accountOwnerId, name: clean, mapping, settings });
  if (error) throw new Error(error.message);
}

export async function deleteAuditTemplate(accountOwnerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('hours_audit_templates').delete().eq('id', id).eq('user_id', accountOwnerId);
  if (error) throw new Error(error.message);
}
