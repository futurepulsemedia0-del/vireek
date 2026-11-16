// Supabase access for the AI incident register. Staff-only, enforced server-side by RLS
// (is_vireek_staff) — the StaffRoute gate in the UI is a convenience, not the control.
// Errors carry a `kind` the page translates; raw database messages are never shown.
import { supabase } from '@/lib/supabase';
import {
  toIncident, toInsertRow, toUpdateRow,
  type AiIncident, type AiIncidentDraft, type AiIncidentPatch,
} from '@/lib/aiIncidents';

export type AiIncidentsErrorKind = 'forbidden' | 'pii' | 'postmortemRequired' | 'invalid' | 'generic';

export class AiIncidentsApiError extends Error {
  readonly kind: AiIncidentsErrorKind;
  constructor(kind: AiIncidentsErrorKind) {
    super(kind);
    this.name = 'AiIncidentsApiError';
    this.kind = kind;
  }
}

interface DbError { message?: string; code?: string }

function fail(error: DbError): never {
  const msg = (error.message ?? '').toLowerCase();
  switch (error.code) {
    case '42501':
    case 'PGRST116': // update/select matched no visible row: RLS hid it
      throw new AiIncidentsApiError('forbidden');
    case '22023': throw new AiIncidentsApiError(msg.includes('e-mail') ? 'pii' : 'invalid');
    case '23514': throw new AiIncidentsApiError(msg.includes('postmortem') ? 'postmortemRequired' : 'invalid');
    default: throw new AiIncidentsApiError('generic');
  }
}

const COLUMNS = [
  'id', 'ref', 'incident_type', 'severity', 'status', 'title', 'summary', 'source', 'owner_role', 'call_id',
  'customer_notification', 'regulator_notification', 'postmortem_ref', 'detected_at', 'contained_at', 'resolved_at',
  'created_at', 'updated_at',
].join(', ');

/** Newest 200 incidents. RLS returns zero rows (not an error) for a non-staff caller. */
export async function listAiIncidents(): Promise<AiIncident[]> {
  const { data, error } = await supabase
    .from('ai_incidents')
    .select(COLUMNS)
    .order('detected_at', { ascending: false })
    .limit(200);
  if (error) fail(error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toIncident);
}

export async function createAiIncident(draft: AiIncidentDraft): Promise<AiIncident> {
  const { data, error } = await supabase.from('ai_incidents').insert(toInsertRow(draft)).select(COLUMNS).single();
  if (error) fail(error);
  return toIncident(data as unknown as Record<string, unknown>);
}

export async function updateAiIncident(id: string, patch: AiIncidentPatch): Promise<AiIncident> {
  const row = toUpdateRow(patch);
  if (Object.keys(row).length === 0) throw new AiIncidentsApiError('invalid');
  const { data, error } = await supabase.from('ai_incidents').update(row).eq('id', id).select(COLUMNS).single();
  if (error) fail(error);
  return toIncident(data as unknown as Record<string, unknown>);
}
