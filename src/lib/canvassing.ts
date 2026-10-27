// src/lib/canvassing.ts
//
// Pure helpers for door-to-door canvassing: types, outcome rules, ZIP / CSV parsing, map + filter maths,
// follow-up buckets and error copy. No React, no Supabase — everything here is unit-tested.
// Server side: migration 20271231120000_door_to_door_canvassing.sql (the database re-checks every rule below).

// ------------------------------------------------------------------ types
export type DoorOutcome = 'no_answer' | 'callback' | 'not_interested' | 'interested' | 'appointment_set' | 'sold' | 'do_not_knock';
export type DoorStatus = 'new' | DoorOutcome;

export interface Territory {
  id: string;
  user_id: string;
  name: string;
  color: string;
  zip_codes: string[];
  assigned_user_id: string | null;
  assigned_at: string | null;
  status: 'active' | 'archived';
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Door {
  id: string;
  user_id: string;
  territory_id: string | null;
  line1: string;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  zone: string | null;
  lat: number | null;
  lng: number | null;
  status: DoorStatus;
  visit_count: number;
  last_visit_at: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  lead_id: string | null;
  follow_up_at: string | null;
  follow_up_task_id: string | null;
  created_at: string;
}

export interface Visit {
  id: string;
  door_id: string;
  rep_user_id: string | null;
  outcome: DoorOutcome;
  note: string | null;
  contact_name: string | null;
  follow_up_at: string | null;
  lead_id: string | null;
  visited_at: string;
}

export interface Rep {
  user_id: string;
  name: string;
  role: string;
}

export interface DoorInput {
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  lat?: number | null;
  lng?: number | null;
}

export interface VisitLogResult {
  door: Door;
  visit_id: string;
  lead_id: string | null;
  task_id: string | null;
  duplicate: boolean;
}

export interface ReportCounts {
  knocks: number;
  doors: number;
  contacts: number;
  interested: number;
  appointments: number;
  sold: number;
}
export interface ReportTotals extends ReportCounts { do_not_knock: number; leads: number }
export interface ReportRepRow extends ReportCounts { rep_user_id: string | null; name: string }
export interface ReportTerritoryRow {
  territory_id: string;
  name: string;
  color: string;
  doors_total: number;
  doors_unvisited: number;
  knocks: number;
  contacts: number;
  interested: number;
  appointments: number;
  sold: number;
}
export interface CanvassReport {
  days: number;
  totals: ReportTotals;
  by_rep: ReportRepRow[];
  by_territory: ReportTerritoryRow[];
}

// ------------------------------------------------------------------ outcomes
export type FollowUpRule = 'required' | 'optional' | 'none';

export interface OutcomeMeta {
  label: string;
  hint: string;
  /** Map pin / dot colour. Never the only signal: every use also shows the label. */
  color: string;
  needsContact: boolean;
  followUp: FollowUpRule;
}

export const OUTCOME_ORDER: DoorOutcome[] = ['no_answer', 'callback', 'interested', 'appointment_set', 'sold', 'not_interested', 'do_not_knock'];

export const OUTCOMES: Record<DoorOutcome, OutcomeMeta> = {
  no_answer: { label: 'No answer', hint: 'Nobody came to the door', color: '#f59e0b', needsContact: false, followUp: 'optional' },
  callback: { label: 'Call back', hint: 'Asked us to come back later', color: '#8b5cf6', needsContact: false, followUp: 'required' },
  interested: { label: 'Interested', hint: 'Wants to hear more — creates a lead', color: '#06b6d4', needsContact: true, followUp: 'optional' },
  appointment_set: { label: 'Appointment set', hint: 'Booked a visit — creates a lead and a task', color: '#2563eb', needsContact: true, followUp: 'required' },
  sold: { label: 'Sold', hint: 'Signed on the spot', color: '#16a34a', needsContact: true, followUp: 'none' },
  not_interested: { label: 'Not interested', hint: 'Politely declined', color: '#ef4444', needsContact: false, followUp: 'none' },
  do_not_knock: { label: 'Do not knock', hint: 'Never visit again (locked for reps)', color: '#1f2937', needsContact: false, followUp: 'none' },
};

export const NEW_DOOR_COLOR = '#94a3b8';
export const STATUS_ORDER: DoorStatus[] = ['new', ...OUTCOME_ORDER];

export function statusLabel(s: DoorStatus): string {
  return s === 'new' ? 'Not visited' : OUTCOMES[s].label;
}
export function statusColor(s: DoorStatus): string {
  return s === 'new' ? NEW_DOOR_COLOR : OUTCOMES[s].color;
}

// ------------------------------------------------------------------ small utils
export const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 100) : 0);

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function canManageCanvassing(isOwner: boolean, permissions: Record<string, boolean | undefined> | null | undefined): boolean {
  return isOwner || permissions?.can_manage_team === true;
}

// ------------------------------------------------------------------ ZIP / zones
const US_ZIP = /^\d{5}(-\d{4})?$/;
const CA_POSTAL = /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/;

export function isValidZip(zip: string): boolean {
  const z = zip.trim();
  return US_ZIP.test(z) || CA_POSTAL.test(z);
}

/** US ZIP5 or Canadian FSA (first three characters); null when the text is neither. Mirrors canvass_zone_key(). */
export function normalizeZone(input: string): string | null {
  const t = input.trim();
  if (/^\d{5}/.test(t)) return t.slice(0, 5);
  if (/^[A-Za-z]\d[A-Za-z]/.test(t)) return t.slice(0, 3).toUpperCase();
  return null;
}

/** "78701, 78702 M5V 3L9" -> zones + the tokens that were not recognised. */
export function parseZoneList(text: string): { zones: string[]; invalid: string[] } {
  const tokens = text
    .split(/[,;\n]+/)
    .flatMap((part) => {
      const p = part.trim();
      if (!p) return [];
      return CA_POSTAL.test(p) ? [p] : p.split(/\s+/);
    })
    .filter(Boolean);
  const zones = new Set<string>();
  const invalid: string[] = [];
  for (const tok of tokens) {
    const z = normalizeZone(tok);
    if (z) zones.add(z);
    else invalid.push(tok);
  }
  return { zones: [...zones].sort(), invalid };
}

/** MUST mirror canvass_address_key() in the migration. */
export function addressKey(line1: string, line2: string | null | undefined, zip: string | null | undefined): string {
  const zone = zip ? normalizeZone(zip) : null;
  return `${`${line1} ${line2 ?? ''}`.toLowerCase().replace(/[^a-z0-9]/g, '')}|${zone ?? ''}`;
}

export function formatAddress(d: Pick<Door, 'line1' | 'line2' | 'city' | 'state' | 'zip'>): string {
  const street = [d.line1, d.line2].filter(Boolean).join(' ');
  const region = [d.state, d.zip].filter(Boolean).join(' ');
  return [street, d.city, region].filter(Boolean).join(', ');
}

// ------------------------------------------------------------------ coordinates
export function parseCoordinate(raw: string, kind: 'lat' | 'lng'): number | null {
  const t = raw.trim();
  if (!t) return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  const max = kind === 'lat' ? 90 : 180;
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
}

export function hasPoint<T extends { lat: number | null; lng: number | null }>(d: T): d is T & { lat: number; lng: number } {
  return typeof d.lat === 'number' && typeof d.lng === 'number' && Number.isFinite(d.lat) && Number.isFinite(d.lng);
}

export function computeBounds(points: { lat: number; lng: number }[]): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  return [[minLng, minLat], [maxLng, maxLat]];
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(km: number, imperial = true): string {
  if (imperial) {
    const ft = km * 3280.84;
    return ft < 1000 ? `${Math.max(10, Math.round(ft / 10) * 10)} ft` : `${(km * 0.621371).toFixed(1)} mi`;
  }
  return km < 1 ? `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m` : `${km.toFixed(1)} km`;
}

/** Doors with a pin first (nearest first), doors without coordinates keep their order at the end. */
export function sortByDistance<T extends { lat: number | null; lng: number | null }>(doors: T[], here: { lat: number; lng: number }): { door: T; km: number | null }[] {
  const withPoint: { door: T; km: number }[] = [];
  const without: { door: T; km: null }[] = [];
  for (const door of doors) {
    if (hasPoint(door)) withPoint.push({ door, km: haversineKm(here, door) });
    else without.push({ door, km: null });
  }
  withPoint.sort((a, b) => a.km - b.km);
  return [...withPoint, ...without];
}

// ------------------------------------------------------------------ filtering + summaries
export interface DoorFilters {
  /** 'all' | 'none' (unassigned doors) | a territory id */
  territory: string;
  statuses: DoorStatus[];
  query: string;
}

export const DEFAULT_FILTERS: DoorFilters = { territory: 'all', statuses: [], query: '' };

export function filterDoors(doors: Door[], f: DoorFilters): Door[] {
  const q = f.query.trim().toLowerCase();
  return doors.filter((d) => {
    if (f.territory === 'none' ? d.territory_id !== null : f.territory !== 'all' && d.territory_id !== f.territory) return false;
    if (f.statuses.length > 0 && !f.statuses.includes(d.status)) return false;
    if (q) {
      const hay = `${formatAddress(d)} ${d.contact_name ?? ''} ${d.contact_phone ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function countByStatus(doors: Door[]): Record<DoorStatus, number> {
  const out = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<DoorStatus, number>;
  for (const d of doors) out[d.status] += 1;
  return out;
}

export interface Coverage { total: number; knocked: number; pct: number }
export function coverage(doors: Door[]): Coverage {
  const knocked = doors.filter((d) => d.status !== 'new').length;
  return { total: doors.length, knocked, pct: pct(knocked, doors.length) };
}

export interface DoorFeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: { id: string; status: DoorStatus };
  }[];
}
export function doorsToGeoJSON(doors: Door[]): DoorFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: doors.filter(hasPoint).map((d) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [d.lng, d.lat] as [number, number] },
      properties: { id: d.id, status: d.status },
    })),
  };
}

// ------------------------------------------------------------------ follow-ups
export type FollowUpBucket = 'overdue' | 'today' | 'upcoming';

export function followUpBucket(iso: string, now: Date): FollowUpBucket {
  const due = new Date(iso);
  if (due.getTime() < now.getTime()) return 'overdue';
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  return due.getTime() <= endOfToday.getTime() ? 'today' : 'upcoming';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO -> value for <input type="datetime-local"> in the viewer's time zone. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value -> ISO (null when empty / invalid). */
export function localInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type QuickFollowUp = 'tomorrow' | 'in3days' | 'nextWeek';
export const QUICK_FOLLOW_UPS: { id: QuickFollowUp; label: string; days: number }[] = [
  { id: 'tomorrow', label: 'Tomorrow', days: 1 },
  { id: 'in3days', label: 'In 3 days', days: 3 },
  { id: 'nextWeek', label: 'Next week', days: 7 },
];

/** Same wall-clock time of day (default 10:00) N days ahead, as a datetime-local value. */
export function quickFollowUp(id: QuickFollowUp, now: Date): string {
  const days = QUICK_FOLLOW_UPS.find((q) => q.id === id)?.days ?? 1;
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(10, 0, 0, 0);
  return isoToLocalInput(d.toISOString());
}

export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  const diff = now.getTime() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  const label = min < 1 ? 'just now' : min < 60 ? `${min} min` : min < 60 * 24 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
  if (label === 'just now') return label;
  return diff >= 0 ? `${label} ago` : `in ${label}`;
}

// ------------------------------------------------------------------ visit validation (mirrors canvass_visit_log)
export interface VisitDraft {
  outcome: DoorOutcome | null;
  note: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  service: string;
  /** datetime-local value or '' */
  followUp: string;
}

export const EMPTY_VISIT: VisitDraft = { outcome: null, note: '', contactName: '', contactPhone: '', contactEmail: '', service: '', followUp: '' };

export type VisitErrors = Partial<Record<'outcome' | 'contactName' | 'contactPhone' | 'contactEmail' | 'followUp' | 'note' | 'service', string>>;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateVisit(
  draft: VisitDraft,
  known: { name: string | null; phone: string | null; email: string | null },
  now: Date,
): VisitErrors {
  const errors: VisitErrors = {};
  if (!draft.outcome) {
    errors.outcome = 'Pick what happened at the door.';
    return errors;
  }
  const meta = OUTCOMES[draft.outcome];
  const name = draft.contactName.trim() || known.name || '';
  const phone = draft.contactPhone.trim() || known.phone || '';
  const email = draft.contactEmail.trim() || known.email || '';

  if (draft.note.length > 1000) errors.note = 'Keep the note under 1,000 characters.';
  if (draft.service.trim().length > 120) errors.service = 'Keep this under 120 characters.';
  if (name.length > 120) errors.contactName = 'Name is too long.';
  if (phone) {
    const digits = phone.replace(/\D/g, '').length;
    if (digits < 7 || digits > 15 || phone.length > 32) errors.contactPhone = 'Enter a valid phone number.';
  }
  if (email && (email.length > 254 || !EMAIL.test(email))) errors.contactEmail = 'Enter a valid email address.';

  if (meta.needsContact) {
    if (!name) errors.contactName = 'A contact name is needed to create the lead.';
    else if (!phone && !email) errors.contactPhone = 'Add a phone number or an email so the office can reach them.';
  }

  const closes = meta.followUp === 'none';
  if (!closes) {
    const iso = draft.followUp ? localInputToIso(draft.followUp) : null;
    if (draft.followUp && !iso) errors.followUp = 'Pick a valid date and time.';
    else if (!iso && meta.followUp === 'required') errors.followUp = 'Pick when to follow up.';
    else if (iso) {
      const t = new Date(iso).getTime();
      if (t < now.getTime() - 5 * 60_000) errors.followUp = 'Pick a time in the future.';
      else if (t > now.getTime() + 400 * 86_400_000) errors.followUp = 'That is too far ahead — pick a date within 13 months.';
    }
  }
  return errors;
}

export const hasErrors = (e: object): boolean => Object.keys(e).length > 0;

// ------------------------------------------------------------------ door draft + CSV
export interface DoorDraft { line1: string; line2: string; city: string; state: string; zip: string }
export type DoorDraftErrors = Partial<Record<keyof DoorDraft, string>>;

export function validateDoorDraft(d: DoorDraft): DoorDraftErrors {
  const e: DoorDraftErrors = {};
  if (!d.line1.trim()) e.line1 = 'Enter the street address.';
  else if (d.line1.trim().length > 160) e.line1 = 'Address is too long.';
  if (d.line2.trim().length > 80) e.line2 = 'Keep this under 80 characters.';
  if (d.city.trim().length > 80) e.city = 'City is too long.';
  if (d.state.trim().length > 40) e.state = 'State is too long.';
  if (d.zip.trim() && !isValidZip(d.zip)) e.zip = 'Use a 5-digit ZIP or a Canadian postal code.';
  return e;
}

export function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export const MAX_IMPORT_ROWS = 5000;

const HEADER_ALIASES: Record<keyof DoorInput, string[]> = {
  line1: ['address', 'address1', 'line1', 'street', 'streetaddress'],
  line2: ['address2', 'line2', 'unit', 'apt', 'suite'],
  city: ['city', 'town'],
  state: ['state', 'province', 'region'],
  zip: ['zip', 'zipcode', 'postal', 'postalcode', 'postcode'],
  lat: ['lat', 'latitude'],
  lng: ['lng', 'lon', 'long', 'longitude'],
};

export interface DoorImportResult { doors: DoorInput[]; skipped: number; error: string | null }

/** Pasted CSV / TSV with a header row. Rows without a usable address or with a bad ZIP / coordinate are skipped and counted. */
export function parseDoorsCsv(text: string): DoorImportResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { doors: [], skipped: 0, error: 'Paste a header row followed by at least one address.' };
  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const header = splitCsvLine(lines[0], delimiter).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const col = {} as Record<keyof DoorInput, number>;
  (Object.keys(HEADER_ALIASES) as (keyof DoorInput)[]).forEach((k) => {
    col[k] = header.findIndex((h) => HEADER_ALIASES[k].includes(h));
  });
  if (col.line1 < 0) return { doors: [], skipped: 0, error: 'Add an "address" column to the header row.' };
  if (lines.length - 1 > MAX_IMPORT_ROWS) return { doors: [], skipped: 0, error: `Import up to ${MAX_IMPORT_ROWS.toLocaleString()} rows at a time.` };

  const doors: DoorInput[] = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delimiter);
    const get = (k: keyof DoorInput) => (col[k] >= 0 ? (cells[col[k]] ?? '').trim() : '');
    const line1 = get('line1');
    const zip = get('zip');
    const latRaw = get('lat');
    const lngRaw = get('lng');
    const lat = parseCoordinate(latRaw, 'lat');
    const lng = parseCoordinate(lngRaw, 'lng');
    const badPoint = (latRaw || lngRaw) && (lat === null || lng === null);
    if (!line1 || line1.length > 160 || (zip && !isValidZip(zip)) || badPoint) { skipped++; continue; }
    doors.push({ line1, line2: get('line2'), city: get('city'), state: get('state'), zip, lat, lng });
  }
  return { doors, skipped, error: doors.length === 0 ? 'No valid addresses found in the pasted rows.' : null };
}

// ------------------------------------------------------------------ report parsing (defensive: RPC returns jsonb)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

export function parseReport(raw: unknown): CanvassReport {
  const r = (raw ?? {}) as Record<string, unknown>;
  const t = (r.totals ?? {}) as Record<string, unknown>;
  const counts = (x: Record<string, unknown>): ReportCounts => ({
    knocks: num(x.knocks), doors: num(x.doors), contacts: num(x.contacts),
    interested: num(x.interested), appointments: num(x.appointments), sold: num(x.sold),
  });
  return {
    days: num(r.days) || 30,
    totals: { ...counts(t), do_not_knock: num(t.do_not_knock), leads: num(t.leads) },
    by_rep: (Array.isArray(r.by_rep) ? r.by_rep : []).map((x) => {
      const o = x as Record<string, unknown>;
      return { ...counts(o), rep_user_id: typeof o.rep_user_id === 'string' ? o.rep_user_id : null, name: String(o.name ?? 'Team member') };
    }),
    by_territory: (Array.isArray(r.by_territory) ? r.by_territory : []).map((x) => {
      const o = x as Record<string, unknown>;
      return {
        territory_id: String(o.territory_id ?? ''), name: String(o.name ?? ''), color: typeof o.color === 'string' ? o.color : '#2563EB',
        doors_total: num(o.doors_total), doors_unvisited: num(o.doors_unvisited), knocks: num(o.knocks), contacts: num(o.contacts),
        interested: num(o.interested), appointments: num(o.appointments), sold: num(o.sold),
      };
    }),
  };
}

// ------------------------------------------------------------------ error copy
const ERROR_COPY: Record<string, string> = {
  not_authorized: 'You do not have access to this territory or action.',
  door_not_found: 'That door no longer exists. Refresh and try again.',
  door_do_not_knock: 'This address is marked Do Not Knock. Only a manager can change it.',
  outcome_invalid: 'Pick what happened at the door.',
  contact_required: 'A contact name is needed to create the lead.',
  contact_method_required: 'Add a phone number or an email so the office can reach them.',
  contact_name_invalid: 'The contact name is too long.',
  phone_invalid: 'Enter a valid phone number.',
  email_invalid: 'Enter a valid email address.',
  follow_up_required: 'Pick when to follow up.',
  follow_up_invalid: 'Pick a follow-up time between now and 13 months ahead.',
  note_too_long: 'Keep the note under 1,000 characters.',
  service_too_long: 'Keep the service under 120 characters.',
  territory_not_found: 'That territory no longer exists or is archived.',
  territory_archived: 'Restore this territory before editing it.',
  territory_name_taken: 'Another active territory already uses that name.',
  territory_required: 'Pick one of your territories for this door.',
  name_invalid: 'Give the territory a name (up to 80 characters).',
  color_invalid: 'Pick a valid colour.',
  zip_invalid: 'One or more ZIP / postal codes are not valid.',
  too_many_zips: 'A territory can hold up to 200 ZIP codes.',
  rep_not_found: 'That person is not on your team.',
  notes_too_long: 'Keep the notes under 1,000 characters.',
  no_doors: 'There are no doors to add.',
  too_many_doors: 'Add up to 500 doors at a time.',
};

export function canvassErrorMessage(err: { code?: string; message?: string } | string | null | undefined, fallback: string): string {
  const raw = typeof err === 'string' ? err : `${err?.message ?? ''}`;
  for (const key of Object.keys(ERROR_COPY)) if (raw.includes(key)) return ERROR_COPY[key];
  if (typeof err === 'object' && err?.code === '42501') return ERROR_COPY.not_authorized;
  return fallback;
}

export const TERRITORY_COLORS = ['#2563EB', '#16A34A', '#DC2626', '#D97706', '#7C3AED', '#0891B2', '#DB2777', '#4B5563'];
