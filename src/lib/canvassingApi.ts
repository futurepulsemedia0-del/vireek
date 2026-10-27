// src/lib/canvassingApi.ts
//
// Supabase access for door-to-door canvassing. Reads go through RLS-scoped tables (managers see everything,
// reps only their territories); every write goes through a SECURITY DEFINER RPC.
// See 20271231120000_door_to_door_canvassing.sql.

import { supabase } from '@/lib/supabase';
import {
  canvassErrorMessage,
  chunk,
  parseReport,
  type CanvassReport,
  type Door,
  type DoorInput,
  type Rep,
  type Territory,
  type Visit,
  type VisitLogResult,
} from '@/lib/canvassing';

const DOOR_COLUMNS =
  'id,user_id,territory_id,line1,line2,city,state,zip,zone,lat,lng,status,visit_count,last_visit_at,contact_name,contact_phone,contact_email,lead_id,follow_up_at,follow_up_task_id,created_at';
const VISIT_COLUMNS = 'id,door_id,rep_user_id,outcome,note,contact_name,follow_up_at,lead_id,visited_at';

/** PostgREST caps a response at 1,000 rows by default, so doors are read page by page. */
const PAGE = 1000;
const MAX_PAGES = 10;

const fail = (error: { code?: string; message?: string }, fallback: string): never => {
  throw new Error(canvassErrorMessage(error, fallback));
};

export async function listTerritories(ownerId: string): Promise<Territory[]> {
  const { data, error } = await supabase.from('canvass_territories').select('*').eq('user_id', ownerId).order('name', { ascending: true }).limit(500);
  if (error) fail(error, 'Could not load territories.');
  return (data ?? []) as unknown as Territory[];
}

export async function listDoors(ownerId: string): Promise<{ doors: Door[]; truncated: boolean }> {
  const doors: Door[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from('canvass_doors')
      .select(DOOR_COLUMNS)
      .eq('user_id', ownerId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) fail(error, 'Could not load doors.');
    const rows = (data ?? []) as unknown as Door[];
    doors.push(...rows);
    if (rows.length < PAGE) return { doors, truncated: false };
  }
  return { doors, truncated: true };
}

export async function listReps(): Promise<Rep[]> {
  const { data, error } = await supabase.rpc('canvass_reps');
  if (error) fail(error, 'Could not load your team.');
  return (Array.isArray(data) ? data : []) as Rep[];
}

export async function listDoorVisits(doorId: string): Promise<Visit[]> {
  const { data, error } = await supabase
    .from('canvass_visits')
    .select(VISIT_COLUMNS)
    .eq('door_id', doorId)
    .order('visited_at', { ascending: false })
    .limit(50);
  if (error) fail(error, 'Could not load the visit history.');
  return (data ?? []) as unknown as Visit[];
}

export interface TerritoryDraft {
  name: string;
  color: string;
  zip_codes: string[];
  assigned_user_id: string | null;
  notes: string;
}

export async function saveTerritory(id: string | null, d: TerritoryDraft): Promise<{ territory: Territory; claimed: number }> {
  const { data, error } = await supabase.rpc('canvass_territory_save', {
    p_id: id, p_name: d.name.trim(), p_color: d.color, p_zip_codes: d.zip_codes,
    p_assigned_user_id: d.assigned_user_id, p_notes: d.notes.trim() || null,
  });
  if (error) fail(error, 'Could not save the territory.');
  return data as unknown as { territory: Territory; claimed: number };
}

export async function setTerritoryArchived(id: string, archived: boolean): Promise<Territory> {
  const { data, error } = await supabase.rpc('canvass_territory_set_archived', { p_id: id, p_archived: archived });
  if (error) fail(error, archived ? 'Could not archive the territory.' : 'Could not restore the territory.');
  return data as unknown as Territory;
}

export interface AddDoorsSummary { inserted: number; duplicates: number; invalid: number; doorIds: string[] }

/** Adds doors in chunks of 500 (the RPC limit). Managers may omit the territory: it is matched by ZIP. */
export async function addDoors(doors: DoorInput[], territoryId: string | null): Promise<AddDoorsSummary> {
  const summary: AddDoorsSummary = { inserted: 0, duplicates: 0, invalid: 0, doorIds: [] };
  for (const part of chunk(doors, 500)) {
    const { data, error } = await supabase.rpc('canvass_doors_add', {
      p_doors: part.map((d) => ({
        line1: d.line1, line2: d.line2 || null, city: d.city || null, state: d.state || null, zip: d.zip || null,
        lat: d.lat ?? null, lng: d.lng ?? null,
      })),
      p_territory_id: territoryId,
    });
    if (error) fail(error, 'Could not add the doors.');
    const res = data as { inserted: number; duplicates: number; invalid: number; door_ids: string[] };
    summary.inserted += res.inserted;
    summary.duplicates += res.duplicates;
    summary.invalid += res.invalid;
    summary.doorIds.push(...res.door_ids);
  }
  return summary;
}

export async function assignDoors(doorIds: string[], territoryId: string | null): Promise<number> {
  let moved = 0;
  for (const part of chunk(doorIds, 2000)) {
    const { data, error } = await supabase.rpc('canvass_doors_assign', { p_door_ids: part, p_territory_id: territoryId });
    if (error) fail(error, 'Could not move the doors.');
    moved += Number(data) || 0;
  }
  return moved;
}

export interface VisitInput {
  doorId: string;
  outcome: string;
  note: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  service: string;
  followUpIso: string | null;
}

export async function logVisit(v: VisitInput): Promise<VisitLogResult> {
  const { data, error } = await supabase.rpc('canvass_visit_log', {
    p_door_id: v.doorId, p_outcome: v.outcome, p_note: v.note.trim() || null,
    p_contact_name: v.contactName.trim() || null, p_contact_phone: v.contactPhone.trim() || null,
    p_contact_email: v.contactEmail.trim() || null, p_follow_up_at: v.followUpIso, p_service: v.service.trim() || null,
  });
  if (error) fail(error, 'Could not save the visit. Nothing was lost — try again.');
  return data as unknown as VisitLogResult;
}

export async function completeFollowUp(doorId: string): Promise<Door> {
  const { data, error } = await supabase.rpc('canvass_followup_done', { p_door_id: doorId });
  if (error) fail(error, 'Could not mark the follow-up as done.');
  return data as unknown as Door;
}

export async function fetchReport(days: number): Promise<CanvassReport> {
  const { data, error } = await supabase.rpc('canvass_report', { p_days: days });
  if (error) fail(error, 'Could not load results.');
  return parseReport(data);
}
