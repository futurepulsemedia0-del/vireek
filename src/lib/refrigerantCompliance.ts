/**
 * Refrigerant & regulated-materials compliance — client domain logic.
 *
 * HVAC/refrigeration jobs that add or recover refrigerant are logged per unit
 * (type, pounds, technician, EPA 608 certification on the date of work).
 * Leak rates are calculated from the log and compared to the repair
 * threshold for the appliance category; the whole ledger exports to CSV.
 *
 * Reuses the existing compliance system instead of duplicating it:
 *   - certification source:  technician_credentials  (Compliance Center)
 *   - credential status:     complianceGate.computeCredentialStatus / daysUntil
 *   - CSV:                   csvExport.exportToCsv
 *   - audit trail:           log_audit_event() (server trigger)
 *
 * Server counterpart: supabase/migrations/*_refrigerant_compliance.sql
 * (the certification check is ALSO enforced there — this file only gives
 * the UI an early, friendly answer).
 *
 * Regulatory figures below (leak thresholds, 15 lb coverage, 30-day repair,
 * 3-year retention) follow EPA 40 CFR 82.157 / Part 84 Subpart C as commonly
 * summarised. They are centralised as constants so they can be updated in
 * one place when the rules change; they are not legal advice.
 */

import { supabase } from '@/lib/supabase';
import { daysUntil, computeCredentialStatus } from '@/lib/complianceGate';
import type { CsvColumn } from '@/lib/csvExport';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

export type RefrigerantEventType = 'added' | 'recovered';
export type ApplianceCategory =
  'comfort_cooling' | 'commercial_refrigeration' | 'industrial_process' | 'other';
export type Disposition =
  'returned_to_cylinder' | 'sent_to_reclaimer' | 'recycled_on_site' | 'destroyed' | 'other';

export const EVENT_LABELS: Record<RefrigerantEventType, string> = {
  added: 'Added',
  recovered: 'Recovered',
};

export const DISPOSITION_LABELS: Record<Disposition, string> = {
  returned_to_cylinder: 'Returned to recovery cylinder',
  sent_to_reclaimer: 'Sent to reclaimer',
  recycled_on_site: 'Recycled on site',
  destroyed: 'Destroyed',
  other: 'Other',
};

export const CATEGORY_LABELS: Record<ApplianceCategory, string> = {
  comfort_cooling: 'Comfort cooling (A/C, heat pump)',
  commercial_refrigeration: 'Commercial refrigeration',
  industrial_process: 'Industrial process refrigeration',
  other: 'Other',
};

/** Annualised leak-rate trigger (%) above which a repair is required. */
export const LEAK_THRESHOLD_PCT: Record<ApplianceCategory, number> = {
  comfort_cooling: 10,
  commercial_refrigeration: 20,
  industrial_process: 30,
  other: 10,
};

/** Appliances holding at least this many pounds are subject to leak-rate rules. */
export const LEAK_RULE_MIN_CHARGE_LBS = 15;
/** Days allowed to repair after a leak rate exceeds the threshold. */
export const LEAK_REPAIR_DEADLINE_DAYS = 30;
/** Years records must be retained. */
export const RECORD_RETENTION_YEARS = 3;
/** Type I certification covers only small appliances up to this charge. */
export const TYPE_I_MAX_CHARGE_LBS = 5;

const LBS_PER_METRIC_TON = 2204.62;
const MS_PER_DAY = 86_400_000;
export const MAX_POUNDS = 99_999.99;

export interface RefrigerantInfo {
  label: string;
  /** 100-yr global warming potential (AR4 values used by US EPA); indicative. */
  gwp: number;
}

export const REFRIGERANTS: Record<string, RefrigerantInfo> = {
  'R-22': { label: 'R-22 (HCFC)', gwp: 1810 },
  'R-134a': { label: 'R-134a', gwp: 1430 },
  'R-404A': { label: 'R-404A', gwp: 3922 },
  'R-407C': { label: 'R-407C', gwp: 1774 },
  'R-410A': { label: 'R-410A', gwp: 2088 },
  'R-32': { label: 'R-32', gwp: 675 },
  'R-454B': { label: 'R-454B', gwp: 466 },
  'R-452B': { label: 'R-452B', gwp: 698 },
  'R-507A': { label: 'R-507A', gwp: 3985 },
  'R-448A': { label: 'R-448A', gwp: 1387 },
  'R-449A': { label: 'R-449A', gwp: 1397 },
  'R-290': { label: 'R-290 (propane)', gwp: 3 },
  'R-600a': { label: 'R-600a (isobutane)', gwp: 3 },
  'R-717': { label: 'R-717 (ammonia)', gwp: 0 },
  'R-744': { label: 'R-744 (CO₂)', gwp: 1 },
};

export const REFRIGERANT_CODES = Object.keys(REFRIGERANTS);

/** "r410a" / "R 410A" / "r-410a" -> "R-410A" when it is a known refrigerant, else trimmed input. */
export function normalizeRefrigerant(input: string): string {
  const raw = input.trim();
  const key = raw.toUpperCase().replace(/[\s_-]/g, '');
  const hit = REFRIGERANT_CODES.find((c) => c.toUpperCase().replace(/-/g, '') === key);
  return hit ?? raw;
}

/** True for service types that can involve refrigerant. */
export function isRefrigerantJob(serviceType: string | null | undefined): boolean {
  if (!serviceType) return false;
  return /(hvac|a\/c|\bac\b|air ?con|heat ?pump|cooling|refriger|chiller|freezer|cold ?room|walk-?in|mini[- ]?split|split ?system|condens|compressor|furnace)/i.test(
    serviceType,
  );
}

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export interface RefrigerantEntry {
  id: string;
  job_id: string | null;
  equipment_id: string | null;
  technician_id: string | null;
  event_type: RefrigerantEventType;
  refrigerant_type: string;
  pounds: number;
  performed_at: string;
  cylinder_ref: string | null;
  disposition: Disposition | null;
  leak_found: boolean;
  leak_repaired: boolean | null;
  notes: string | null;
  equipment_label: string | null;
  equipment_serial: string | null;
  site_address: string | null;
  technician_name: string | null;
  cert_type: string;
  cert_number: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}

export interface NewRefrigerantEntry {
  job_id: string;
  equipment_id: string;
  technician_id: string;
  event_type: RefrigerantEventType;
  refrigerant_type: string;
  pounds: number;
  performed_at?: string;
  cylinder_ref?: string | null;
  disposition?: Disposition | null;
  leak_found?: boolean;
  leak_repaired?: boolean | null;
  notes?: string | null;
}

/** Minimal shape of a technician_credentials row. */
export interface CredentialLike {
  id: string;
  technician_id: string;
  credential_type: string;
  credential_number?: string | null;
  status: 'active' | 'revoked' | 'pending_renewal';
  expires_at: string | null;
}

/* ------------------------------------------------------------------ */
/*  Technician certification check                                      */
/* ------------------------------------------------------------------ */

export type EpaCertType = 'type_i' | 'type_ii' | 'type_iii' | 'universal' | 'unspecified';

const CERT_TYPE_BY_CREDENTIAL: Record<string, EpaCertType> = {
  epa_608: 'unspecified',
  epa_608_type_i: 'type_i',
  epa_608_type_ii: 'type_ii',
  epa_608_type_iii: 'type_iii',
  epa_608_universal: 'universal',
};

export const EPA_608_CREDENTIAL_TYPES = Object.keys(CERT_TYPE_BY_CREDENTIAL);

export const CERT_TYPE_LABELS: Record<EpaCertType, string> = {
  type_i: 'Type I',
  type_ii: 'Type II',
  type_iii: 'Type III',
  universal: 'Universal',
  unspecified: 'EPA 608 (type not recorded)',
};

export function certTypeFromCredential(credentialType: string): EpaCertType | null {
  return CERT_TYPE_BY_CREDENTIAL[credentialType] ?? null;
}

export interface CertCheck {
  /** false = the server will refuse the entry. */
  ok: boolean;
  /** Non-blocking issues the user should know about. */
  warnings: string[];
  /** Why it is blocked (when ok = false). */
  reason: string | null;
  credential: CredentialLike | null;
  certType: EpaCertType | null;
}

/** YYYY-MM-DD of a Date in UTC — matches the server's (performed_at AT TIME ZONE 'UTC')::date. */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Same rule as technician_compliance_gaps(): active and not expired on the date of work. */
export function isCredentialCurrent(c: CredentialLike, onDate: Date): boolean {
  if (c.status !== 'active') return false;
  if (!c.expires_at) return true;
  return c.expires_at.slice(0, 10) >= utcDay(onDate);
}

const CERT_RANK: Record<EpaCertType, number> = {
  universal: 0,
  type_ii: 1,
  type_iii: 1,
  unspecified: 2,
  type_i: 3,
};

export function checkTechnicianCertification(
  credentials: CredentialLike[],
  technicianId: string | null | undefined,
  opts: { chargeLbs?: number | null; onDate?: Date } = {},
): CertCheck {
  const onDate = opts.onDate ?? new Date();
  if (!technicianId) {
    return {
      ok: false,
      warnings: [],
      reason: 'Choose the technician who did the work.',
      credential: null,
      certType: null,
    };
  }
  const mine = credentials.filter(
    (c) => c.technician_id === technicianId && certTypeFromCredential(c.credential_type) !== null,
  );
  const charge = opts.chargeLbs ?? null;
  const usable = mine
    .filter((c) => isCredentialCurrent(c, onDate))
    .filter(
      (c) =>
        certTypeFromCredential(c.credential_type) !== 'type_i' ||
        charge === null ||
        charge <= TYPE_I_MAX_CHARGE_LBS,
    )
    .sort(
      (a, b) =>
        CERT_RANK[certTypeFromCredential(a.credential_type)!] -
        CERT_RANK[certTypeFromCredential(b.credential_type)!],
    );

  const best = usable[0];
  if (!best) {
    let reason = 'No EPA 608 certification on file. Add one in Compliance Center first.';
    if (mine.length > 0) {
      const onlyTypeI = mine.every((c) => certTypeFromCredential(c.credential_type) === 'type_i');
      reason =
        onlyTypeI &&
        charge !== null &&
        charge > TYPE_I_MAX_CHARGE_LBS &&
        mine.some((c) => isCredentialCurrent(c, onDate))
          ? `Type I certification only covers appliances up to ${TYPE_I_MAX_CHARGE_LBS} lb; this unit holds ${charge} lb.`
          : 'EPA 608 certification is expired, revoked or pending renewal.';
    }
    return { ok: false, warnings: [], reason, credential: null, certType: null };
  }

  const certType = certTypeFromCredential(best.credential_type)!;
  const warnings: string[] = [];
  if (certType === 'unspecified')
    warnings.push(
      'Certification type (I / II / III / Universal) is not recorded on the credential.',
    );
  if (certType === 'type_i' && charge === null)
    warnings.push(
      `Type I covers only appliances up to ${TYPE_I_MAX_CHARGE_LBS} lb — the unit's charge is unknown.`,
    );
  const status = computeCredentialStatus(best.status, best.expires_at);
  if (status === 'expiring_soon') {
    const d = daysUntil(best.expires_at);
    warnings.push(
      d !== null && d >= 0
        ? `Certification expires in ${d} day${d === 1 ? '' : 's'}.`
        : 'Certification is expiring soon.',
    );
  }
  return { ok: true, warnings, reason: null, credential: best, certType };
}

/* ------------------------------------------------------------------ */
/*  Entry validation                                                    */
/* ------------------------------------------------------------------ */

export function validateEntry(
  input: Partial<NewRefrigerantEntry>,
  now: Date = new Date(),
): string[] {
  const errors: string[] = [];
  if (!input.job_id) errors.push('Job is required.');
  if (!input.equipment_id)
    errors.push('Choose the unit (equipment) the refrigerant went into or came out of.');
  if (!input.technician_id) errors.push('Choose the technician.');
  if (input.event_type !== 'added' && input.event_type !== 'recovered')
    errors.push('Choose whether refrigerant was added or recovered.');
  if (!input.refrigerant_type || !input.refrigerant_type.trim())
    errors.push('Refrigerant type is required.');
  else if (input.refrigerant_type.trim().length > 40) errors.push('Refrigerant type is too long.');
  const lbs = input.pounds;
  if (typeof lbs !== 'number' || !Number.isFinite(lbs) || lbs <= 0)
    errors.push('Pounds must be greater than 0.');
  else if (lbs > MAX_POUNDS)
    errors.push(`Pounds cannot exceed ${MAX_POUNDS.toLocaleString('en-US')}.`);
  else if (Math.abs(lbs * 100 - Math.round(lbs * 100)) > 1e-6)
    errors.push('Pounds can have at most 2 decimal places.');
  if (input.event_type === 'recovered' && !input.disposition)
    errors.push('Say where the recovered refrigerant went.');
  if (input.performed_at) {
    const t = new Date(input.performed_at).getTime();
    if (Number.isNaN(t)) errors.push('Date and time of work is invalid.');
    else if (t > now.getTime() + 5 * 60_000)
      errors.push('Date and time of work cannot be in the future.');
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/*  Leak-rate calculation                                               */
/* ------------------------------------------------------------------ */

export interface LeakRateInput {
  entries: Pick<RefrigerantEntry, 'id' | 'event_type' | 'pounds' | 'performed_at' | 'voided_at'>[];
  /** Full charge of the unit, in pounds. */
  fullChargeLbs: number | null | undefined;
  category?: ApplianceCategory | null;
  /** Baseline for the first addition when no earlier addition exists (e.g. install date). */
  baselineDate?: string | null;
  asOf?: Date;
}

export interface LeakRateResult {
  fullChargeLbs: number | null;
  threshold: number;
  /** (lbs added in the last 365 days / full charge) × 100. null if charge unknown. */
  rollingPct: number | null;
  /** Annualised rate at the most recent addition: lbs/charge × 365/days-since-last-addition × 100. */
  annualizedPct: number | null;
  daysSincePreviousAddition: number | null;
  lastAdditionAt: string | null;
  /** Highest of the two methods is used for the verdict (conservative). */
  ratePct: number | null;
  exceeds: boolean;
  /** Date by which the leak must be repaired, when exceeding. */
  repairDeadline: string | null;
  /** 'ok' | 'exceeds' | 'unknown' (charge missing / not enough history). */
  state: 'ok' | 'exceeds' | 'unknown';
  covered: boolean;
  poundsAdded365: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function computeLeakRate(input: LeakRateInput): LeakRateResult {
  const asOf = input.asOf ?? new Date();
  const charge =
    typeof input.fullChargeLbs === 'number' && input.fullChargeLbs > 0 ? input.fullChargeLbs : null;
  const threshold = LEAK_THRESHOLD_PCT[input.category ?? 'other'];
  const adds = input.entries
    .filter(
      (e) =>
        e.event_type === 'added' &&
        !e.voided_at &&
        new Date(e.performed_at).getTime() <= asOf.getTime(),
    )
    .sort((a, b) => new Date(a.performed_at).getTime() - new Date(b.performed_at).getTime());

  const windowStart = asOf.getTime() - 365 * MS_PER_DAY;
  const poundsAdded365 = adds
    .filter((e) => new Date(e.performed_at).getTime() > windowStart)
    .reduce((s, e) => s + e.pounds, 0);

  const last = adds[adds.length - 1] ?? null;
  const prevDate =
    adds.length > 1 ? adds[adds.length - 2].performed_at : (input.baselineDate ?? null);
  let days: number | null = null;
  if (last && prevDate) {
    days = Math.max(
      1,
      Math.round(
        (new Date(last.performed_at).getTime() - new Date(prevDate).getTime()) / MS_PER_DAY,
      ),
    );
  }

  const rolling = charge !== null ? (poundsAdded365 / charge) * 100 : null;
  const annualized =
    charge !== null && last && days !== null ? (last.pounds / charge) * (365 / days) * 100 : null;
  const candidates = [rolling, annualized].filter((v): v is number => v !== null);
  const rate = candidates.length ? Math.max(...candidates) : null;
  const exceeds = rate !== null && rate > threshold;

  let repairDeadline: string | null = null;
  if (exceeds && last) {
    repairDeadline = new Date(
      new Date(last.performed_at).getTime() + LEAK_REPAIR_DEADLINE_DAYS * MS_PER_DAY,
    ).toISOString();
  }

  return {
    fullChargeLbs: charge,
    threshold,
    rollingPct: rolling === null ? null : round1(rolling),
    annualizedPct: annualized === null ? null : round1(annualized),
    daysSincePreviousAddition: days,
    lastAdditionAt: last?.performed_at ?? null,
    ratePct: rate === null ? null : round1(rate),
    exceeds,
    repairDeadline,
    state: rate === null ? 'unknown' : exceeds ? 'exceeds' : 'ok',
    covered: charge !== null && charge >= LEAK_RULE_MIN_CHARGE_LBS,
    poundsAdded365: Math.round(poundsAdded365 * 100) / 100,
  };
}

/** CO₂-equivalent in metric tons for a quantity of refrigerant; null for unknown refrigerants. */
export function co2eMetricTons(refrigerant: string, pounds: number): number | null {
  const info = REFRIGERANTS[normalizeRefrigerant(refrigerant)];
  if (!info) return null;
  return Math.round(((pounds * info.gwp) / LBS_PER_METRIC_TON) * 1000) / 1000;
}

/** Earliest date a record may be deleted under the retention rule. */
export function retentionUntil(performedAt: string): string {
  const d = new Date(performedAt);
  d.setUTCFullYear(d.getUTCFullYear() + RECORD_RETENTION_YEARS);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/*  Totals + CSV export                                                 */
/* ------------------------------------------------------------------ */

export interface LogTotals {
  added: number;
  recovered: number;
  net: number;
  entries: number;
}

export function totalsFor(
  entries: Pick<RefrigerantEntry, 'event_type' | 'pounds' | 'voided_at'>[],
): LogTotals {
  let added = 0;
  let recovered = 0;
  let n = 0;
  for (const e of entries) {
    if (e.voided_at) continue;
    n++;
    if (e.event_type === 'added') added += e.pounds;
    else recovered += e.pounds;
  }
  added = Math.round(added * 100) / 100;
  recovered = Math.round(recovered * 100) / 100;
  return { added, recovered, net: Math.round((added - recovered) * 100) / 100, entries: n };
}

/** Compliance export: one row per entry, voided rows included and flagged (the ledger is complete). */
export const EXPORT_COLUMNS: CsvColumn<RefrigerantEntry>[] = [
  { header: 'Date (UTC)', accessor: (e) => new Date(e.performed_at).toISOString() },
  { header: 'Event', accessor: (e) => EVENT_LABELS[e.event_type] },
  { header: 'Refrigerant', accessor: (e) => e.refrigerant_type },
  { header: 'Pounds', accessor: (e) => e.pounds.toFixed(2) },
  {
    header: 'CO2e (metric tons)',
    accessor: (e) => co2eMetricTons(e.refrigerant_type, e.pounds) ?? '',
  },
  { header: 'Unit', accessor: (e) => e.equipment_label ?? '' },
  { header: 'Unit serial', accessor: (e) => e.equipment_serial ?? '' },
  { header: 'Site address', accessor: (e) => e.site_address ?? '' },
  { header: 'Technician', accessor: (e) => e.technician_name ?? '' },
  {
    header: 'EPA 608 type',
    accessor: (e) => CERT_TYPE_LABELS[certTypeFromCredential(e.cert_type) ?? 'unspecified'],
  },
  { header: 'EPA 608 certificate #', accessor: (e) => e.cert_number ?? '' },
  { header: 'Cylinder', accessor: (e) => e.cylinder_ref ?? '' },
  {
    header: 'Disposition',
    accessor: (e) => (e.disposition ? DISPOSITION_LABELS[e.disposition] : ''),
  },
  { header: 'Leak found', accessor: (e) => (e.leak_found ? 'Yes' : 'No') },
  {
    header: 'Leak repaired',
    accessor: (e) => (e.leak_repaired === null ? '' : e.leak_repaired ? 'Yes' : 'No'),
  },
  { header: 'Notes', accessor: (e) => e.notes ?? '' },
  { header: 'Retain until', accessor: (e) => retentionUntil(e.performed_at) },
  { header: 'Status', accessor: (e) => (e.voided_at ? 'VOIDED' : 'Active') },
  { header: 'Void reason', accessor: (e) => e.void_reason ?? '' },
  { header: 'Entry ID', accessor: (e) => e.id },
];

export function exportFilename(from: string, to: string): string {
  return `refrigerant-log_${from || 'start'}_${to || 'today'}.csv`;
}

/* ------------------------------------------------------------------ */
/*  API                                                                 */
/* ------------------------------------------------------------------ */

const LOG_COLUMNS =
  'id, job_id, equipment_id, technician_id, event_type, refrigerant_type, pounds, performed_at, cylinder_ref, disposition, leak_found, leak_repaired, notes, equipment_label, equipment_serial, site_address, technician_name, cert_type, cert_number, voided_at, void_reason, created_at';

function num(row: RefrigerantEntry): RefrigerantEntry {
  return { ...row, pounds: Number(row.pounds) };
}

export async function fetchJobLog(jobId: string): Promise<RefrigerantEntry[]> {
  const { data, error } = await supabase
    .from('refrigerant_log')
    .select(LOG_COLUMNS)
    .eq('job_id', jobId)
    .order('performed_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as RefrigerantEntry[]).map(num);
}

export async function fetchEquipmentLog(equipmentIds: string[]): Promise<RefrigerantEntry[]> {
  if (equipmentIds.length === 0) return [];
  const { data, error } = await supabase
    .from('refrigerant_log')
    .select(LOG_COLUMNS)
    .in('equipment_id', equipmentIds)
    .order('performed_at', { ascending: false })
    .limit(5000);
  if (error) throw new Error(error.message);
  return ((data ?? []) as RefrigerantEntry[]).map(num);
}

/** Ledger for a date range (YYYY-MM-DD, UTC, inclusive). Paged so large ledgers are not truncated. */
export async function fetchLogRange(from: string, to: string): Promise<RefrigerantEntry[]> {
  const PAGE = 1000;
  const MAX = 20000;
  const out: RefrigerantEntry[] = [];
  for (let offset = 0; offset < MAX; offset += PAGE) {
    let q = supabase
      .from('refrigerant_log')
      .select(LOG_COLUMNS)
      .order('performed_at', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (from) q = q.gte('performed_at', `${from}T00:00:00.000Z`);
    if (to) q = q.lte('performed_at', `${to}T23:59:59.999Z`);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as RefrigerantEntry[];
    out.push(...rows.map(num));
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Turns the server's guard errors into something a technician can act on. */
export function friendlyError(message: string): string {
  if (message.includes('refrigerant_cert_required')) {
    return message.replace(/^.*refrigerant_cert_required:\s*/, '');
  }
  if (message.includes('immutable'))
    return 'Refrigerant entries cannot be edited. Void the entry and log a new one.';
  return message;
}

export async function addEntry(entry: NewRefrigerantEntry): Promise<void> {
  const errors = validateEntry(entry);
  if (errors.length) throw new Error(errors[0]);
  const { error } = await supabase.from('refrigerant_log').insert({
    job_id: entry.job_id,
    equipment_id: entry.equipment_id,
    technician_id: entry.technician_id,
    event_type: entry.event_type,
    refrigerant_type: normalizeRefrigerant(entry.refrigerant_type),
    pounds: entry.pounds,
    performed_at: entry.performed_at ?? new Date().toISOString(),
    cylinder_ref: entry.cylinder_ref?.trim() || null,
    disposition: entry.event_type === 'recovered' ? entry.disposition : null,
    leak_found: entry.leak_found ?? false,
    leak_repaired: entry.leak_found ? (entry.leak_repaired ?? null) : null,
    notes: entry.notes?.trim() || null,
  });
  if (error) throw new Error(friendlyError(error.message));
}

export async function voidEntry(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_refrigerant_entry', { p_id: id, p_reason: reason });
  if (error) throw new Error(friendlyError(error.message));
}
