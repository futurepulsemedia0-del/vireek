/**
 * VIREEK data-plate scanning — client API + pure helpers.
 *
 * Photo of the manufacturer's data plate -> OCR (edge function `equipment-nameplate-scan`) -> equipment
 * record -> Equipment Passport + estimated warranty. The server decides whether a read is trustworthy
 * enough to create the passport automatically; otherwise the technician reviews it first.
 * Types mirror supabase/functions/_shared/property-vision/nameplate.ts.
 */

import { supabase } from '@/lib/supabase';
import { uploadPropertyPhoto } from '@/lib/propertyVision';
import type { WarrantyState } from '@/lib/equipmentPassport';

export type NameplateKind =
  | 'water_heater' | 'furnace' | 'boiler' | 'air_conditioner' | 'heat_pump' | 'air_handler' | 'condenser_unit'
  | 'mini_split' | 'thermostat' | 'electrical_panel' | 'subpanel' | 'meter' | 'water_softener' | 'well_pump'
  | 'sump_pump' | 'expansion_tank' | 'generator' | 'other';

export type NameplateReviewReason =
  | 'no_plate' | 'missing_make' | 'missing_serial' | 'serial_partial' | 'serial_unreadable' | 'low_confidence'
  | 'missing_model' | 'date_ambiguous' | 'date_future' | 'date_invalid';

export type DatePrecision = 'day' | 'month' | 'year';

export interface NameplateFields {
  plate_found: boolean;
  kind: NameplateKind;
  make: string | null;
  model: string | null;
  serial: string | null;
  serial_legibility: 'clear' | 'partial' | 'unreadable' | 'none';
  specs: string | null;
  manufacture: { date: string | null; precision: DatePrecision | null; raw_text: string | null; problem: 'future' | 'invalid' | 'ambiguous' | null };
  confidence: number;
  photo_issues: string[];
}

export interface NameplateWarranty {
  state: WarrantyState;
  days_left: number | null;
  expires_at: string | null;
  term_years?: number | null;
  /** "estimated" whenever a date is present: derived from the plate, never read from the manufacturer. */
  basis: 'estimated' | 'none';
  note: string;
}

export interface NameplateScan {
  id: string;
  status: 'extracted' | 'created' | 'failed';
  fields: NameplateFields;
  review_reasons: NameplateReviewReason[];
  auto_create_ready: boolean;
  warranty: NameplateWarranty;
  equipment_id: string | null;
  cached: boolean;
}

export interface NameplateCreated {
  equipment_id: string;
  /** True when this customer already had the unit on file (no duplicate was created). */
  reused: boolean;
  /** `code` is withheld until the contractor proves physical access by scanning the QR label. */
  passport: { code: string | null; verified: boolean; joined_existing: boolean } | null;
  warranty: NameplateWarranty;
}

export interface NameplateResult {
  scan: NameplateScan;
  created: NameplateCreated | null;
}

/** What the technician can correct before the passport is created. All values are plain strings. */
export interface NameplateDraft {
  make: string;
  model: string;
  serial: string;
  kind: NameplateKind;
  /** YYYY-MM-DD, YYYY-MM or YYYY (blank = unknown). */
  manufactureDate: string;
  /** YYYY-MM-DD (blank = unknown). When set, the warranty is counted from it. */
  installDate: string;
}

export const NAMEPLATE_KIND_OPTIONS: { value: NameplateKind; label: string }[] = [
  { value: 'water_heater', label: 'Water heater' },
  { value: 'furnace', label: 'Furnace' },
  { value: 'boiler', label: 'Boiler' },
  { value: 'air_conditioner', label: 'Air conditioner' },
  { value: 'heat_pump', label: 'Heat pump' },
  { value: 'air_handler', label: 'Air handler' },
  { value: 'condenser_unit', label: 'Condenser unit' },
  { value: 'mini_split', label: 'Mini-split' },
  { value: 'thermostat', label: 'Thermostat' },
  { value: 'electrical_panel', label: 'Electrical panel' },
  { value: 'subpanel', label: 'Subpanel' },
  { value: 'meter', label: 'Meter' },
  { value: 'water_softener', label: 'Water softener' },
  { value: 'well_pump', label: 'Well pump' },
  { value: 'sump_pump', label: 'Sump pump' },
  { value: 'expansion_tank', label: 'Expansion tank' },
  { value: 'generator', label: 'Generator' },
  { value: 'other', label: 'Other' },
];

// ─── Pure helpers ─────────────────────────────────────────────────────────────────────────────

/** "2019-03-01" + month precision -> "2019-03", the form the review field (and the server) accepts. */
export function manufactureInput(date: string | null | undefined, precision: DatePrecision | null | undefined): string {
  if (!date) return '';
  if (precision === 'year') return date.slice(0, 4);
  if (precision === 'month') return date.slice(0, 7);
  return date.slice(0, 10);
}

/** "2019-03-01" + month precision -> "03/2019" (what people see on the plate). */
export function manufactureLabel(date: string | null | undefined, precision: DatePrecision | null | undefined): string | null {
  if (!date) return null;
  const [y, m, d] = date.split('-');
  if (precision === 'year') return y;
  if (precision === 'month') return `${m}/${y}`;
  return `${m}/${d}/${y}`;
}

export function draftFromScan(scan: Pick<NameplateScan, 'fields'>): NameplateDraft {
  const f = scan.fields;
  return {
    make: f.make ?? '',
    model: f.model ?? '',
    serial: f.serial ?? '',
    kind: f.kind,
    manufactureDate: manufactureInput(f.manufacture?.date, f.manufacture?.precision),
    installDate: '',
  };
}

const REASON_COPY: Record<NameplateReviewReason, string> = {
  no_plate: 'No data plate was found in the photo. Retake it with the plate filling the frame.',
  missing_make: 'The brand could not be read. Enter it from the plate.',
  missing_serial: 'No serial number was found. Enter it from the plate if there is one.',
  serial_partial: 'The serial number may be misread. Check it against the plate.',
  serial_unreadable: 'The serial number is present but not readable. Enter it by hand or retake the photo.',
  low_confidence: 'The photo was hard to read. Please check every field.',
  missing_model: 'The model number was not found.',
  date_ambiguous: 'The manufacture date could be read two ways (day/month). Enter it to be sure.',
  date_future: 'The manufacture date looks like it is in the future. Check it.',
  date_invalid: 'The manufacture date could not be understood. Enter it by hand.',
};

export function reviewReasonMessage(reason: NameplateReviewReason): string {
  return REASON_COPY[reason] ?? 'Please check this read against the plate.';
}

export type BadgeTone = 'success' | 'warning' | 'danger' | 'neutral';

export function warrantyBadge(w: Pick<NameplateWarranty, 'state' | 'days_left' | 'expires_at'>): { label: string; tone: BadgeTone } {
  switch (w.state) {
    case 'active': return { label: `Likely under warranty${w.expires_at ? ` until ${w.expires_at}` : ''}`, tone: 'success' };
    case 'expiring': return { label: `Warranty likely ends in ${Math.max(0, w.days_left ?? 0)} day${w.days_left === 1 ? '' : 's'}`, tone: 'warning' };
    case 'expired': return { label: `Warranty likely expired${w.expires_at ? ` ${w.expires_at}` : ''}`, tone: 'danger' };
    default: return { label: 'Warranty status unknown', tone: 'neutral' };
  }
}

// ─── Errors ───────────────────────────────────────────────────────────────────────────────────

async function friendlyInvokeError(error: unknown): Promise<Error> {
  try {
    const ctx = (error as { context?: Response }).context;
    if (ctx) {
      const j = await ctx.json();
      if (j?.error) return new Error(String(j.error));
    }
  } catch { /* fall through to the generic message */ }
  return new Error('Could not read the data plate. Please try again.');
}

async function invoke(body: Record<string, unknown>): Promise<NameplateResult> {
  const { data, error } = await supabase.functions.invoke('equipment-nameplate-scan', { body });
  if (error) throw await friendlyInvokeError(error);
  if (data?.error) throw new Error(String(data.error));
  return data as NameplateResult;
}

// ─── API ──────────────────────────────────────────────────────────────────────────────────────

export interface ScanNameplateInput {
  file: File;
  jobId?: string | null;
  customerId?: string | null;
  /** Create the passport right away when the read is confident (default). Otherwise return it for review. */
  autoCreate?: boolean;
}

/** Uploads the photo privately (same bucket + compression as Property Vision), reads it and, if confident, creates the passport. */
export async function scanNameplate({ file, jobId = null, customerId = null, autoCreate = true }: ScanNameplateInput): Promise<NameplateResult> {
  const photo = await uploadPropertyPhoto(file, null);
  return invoke({
    jobId,
    customerId,
    autoCreate,
    capture: { path: photo.path, sha256: photo.sha256, mime: photo.mime, bytes: photo.bytes },
  });
}

/** Creates the equipment + passport from a reviewed read. Blank strings clear a field; omitted keys keep the OCR value. */
export function createFromNameplate(scanId: string, draft: NameplateDraft): Promise<NameplateResult> {
  return invoke({
    action: 'create',
    scanId,
    fields: {
      make: draft.make,
      model: draft.model,
      serial: draft.serial,
      kind: draft.kind,
      manufactureDate: draft.manufactureDate,
      installDate: draft.installDate,
    },
  });
}
