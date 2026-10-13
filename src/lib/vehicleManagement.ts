// Pure vehicle-management logic: types, status rules, validation and
// summaries. No React, no network — everything here is unit-tested in
// vehicleManagement.test.ts. Data access lives in vehicleManagementApi.ts.
import { maintenanceStatus, type MaintenanceSchedule } from '@/lib/telematics';

export type { MaintenanceSchedule };

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

export const VEHICLE_STATUSES = ['active', 'in_shop', 'retired'] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const FUEL_TYPES = ['gasoline', 'diesel', 'hybrid', 'electric', 'propane', 'other'] as const;
export const EXPENSE_TYPES = ['fuel', 'maintenance', 'repair', 'insurance', 'downtime', 'other'] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];
export const INSPECTION_TYPES = ['pre_trip', 'post_trip', 'safety', 'annual', 'dot'] as const;
export type InspectionType = (typeof INSPECTION_TYPES)[number];
export const INSPECTION_RESULTS = ['pass', 'needs_attention', 'fail'] as const;
export type InspectionResult = (typeof INSPECTION_RESULTS)[number];
export const DOCUMENT_TYPES = ['registration', 'insurance', 'inspection', 'title', 'warranty', 'permit', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;
const DOCUMENT_EXTENSIONS: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
};
export const DOC_EXPIRING_DAYS = 30;
/** A reading this far above the current odometer is almost certainly a typo. */
export const MAX_ODOMETER_JUMP = 50_000;

export interface Vehicle {
  id: string;
  label: string;
  make: string | null;
  model: string | null;
  year: number | null;
  license_plate: string | null;
  vin: string | null;
  fuel_type: string;
  assigned_technician_id: string | null;
  status: VehicleStatus;
  odometer_miles: number;
  monthly_payment_cost: number;
  monthly_insurance_cost: number;
  purchase_date: string | null;
  notes: string | null;
  created_at: string;
}

export interface Technician {
  id: string;
  member_name: string | null;
  member_email: string;
  invite_status: string;
}

export interface VehicleAssignment {
  id: string;
  vehicle_id: string;
  technician_id: string | null;
  technician_name: string;
  assigned_at: string;
  unassigned_at: string | null;
  notes: string | null;
}

export interface VehicleExpense {
  id: string;
  vehicle_id: string;
  expense_type: ExpenseType;
  amount: number;
  expense_date: string;
  odometer_miles: number | null;
  downtime_hours: number | null;
  notes: string | null;
}

export type ChecklistStatus = 'ok' | 'issue' | 'na';
export interface ChecklistItem { key: string; label: string; status: ChecklistStatus }

export interface VehicleInspection {
  id: string;
  vehicle_id: string;
  inspection_type: InspectionType;
  result: InspectionResult;
  inspected_at: string;
  odometer_miles: number | null;
  checklist: ChecklistItem[];
  notes: string | null;
}

export interface VehicleDocument {
  id: string;
  vehicle_id: string;
  doc_type: DocumentType;
  title: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number;
  issued_on: string | null;
  expires_on: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function humanize(key: string): string {
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatMiles(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? '—' : `${Math.round(n).toLocaleString()} mi`;
}

export function vehicleTitle(v: Pick<Vehicle, 'year' | 'make' | 'model'>): string {
  return [v.year, v.make, v.model].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Date helpers (date-only strings, timezone-stable)
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateOnly(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The user's LOCAL calendar date as YYYY-MM-DD. */
export function toDateOnly(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Whole days from today (local) until `dateOnly`; negative = in the past. */
export function daysUntilDate(dateOnly: string, now: Date): number | null {
  if (!isValidDateOnly(dateOnly)) return null;
  const a = Date.parse(`${dateOnly}T00:00:00Z`);
  const b = Date.parse(`${toDateOnly(now)}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Maintenance health (reuses the Telematics OS rule so both pages agree)
// ---------------------------------------------------------------------------

export type ScheduleHealth = 'overdue' | 'due_soon' | 'ok' | 'no_baseline' | 'paused';

export interface ScheduleView {
  schedule: MaintenanceSchedule;
  health: ScheduleHealth;
  milesRemaining: number | null;
  daysRemaining: number | null;
}

const HEALTH_ORDER: Record<ScheduleHealth, number> = { overdue: 0, due_soon: 1, ok: 2, no_baseline: 3, paused: 4 };

export function evaluateSchedule(s: MaintenanceSchedule, odometer: number | null, now: Date): ScheduleView {
  if (!s.active) return { schedule: s, health: 'paused', milesRemaining: null, daysRemaining: null };
  const r = maintenanceStatus(s, odometer, now.getTime());
  const hasBaseline = r.milesRemaining != null || r.daysRemaining != null;
  return { schedule: s, health: hasBaseline ? r.status : 'no_baseline', milesRemaining: r.milesRemaining, daysRemaining: r.daysRemaining };
}

export function sortScheduleViews(views: ScheduleView[]): ScheduleView[] {
  const urgency = (v: ScheduleView) => Math.min(v.daysRemaining ?? Infinity, v.milesRemaining != null ? v.milesRemaining / 50 : Infinity);
  return [...views].sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || urgency(a) - urgency(b) || a.schedule.name.localeCompare(b.schedule.name));
}

// ---------------------------------------------------------------------------
// Document health
// ---------------------------------------------------------------------------

export type DocumentHealth = 'expired' | 'expiring_soon' | 'valid' | 'no_expiry';

export function documentHealth(expiresOn: string | null, now: Date): { health: DocumentHealth; daysRemaining: number | null } {
  if (!expiresOn) return { health: 'no_expiry', daysRemaining: null };
  const days = daysUntilDate(expiresOn, now);
  if (days == null) return { health: 'no_expiry', daysRemaining: null };
  if (days < 0) return { health: 'expired', daysRemaining: days };
  return { health: days <= DOC_EXPIRING_DAYS ? 'expiring_soon' : 'valid', daysRemaining: days };
}

// ---------------------------------------------------------------------------
// Fleet alerts & summary (retired vehicles never raise alerts)
// ---------------------------------------------------------------------------

export interface VehicleAlerts { overdue: number; dueSoon: number; expired: number; expiring: number }

export function buildVehicleAlerts(
  vehicles: Vehicle[],
  schedules: MaintenanceSchedule[],
  documents: Pick<VehicleDocument, 'vehicle_id' | 'expires_on'>[],
  now: Date,
): Map<string, VehicleAlerts> {
  const map = new Map<string, VehicleAlerts>();
  for (const v of vehicles) map.set(v.id, { overdue: 0, dueSoon: 0, expired: 0, expiring: 0 });
  const live = new Map(vehicles.filter((v) => v.status !== 'retired').map((v) => [v.id, v]));
  for (const s of schedules) {
    const v = live.get(s.vehicle_id);
    if (!v) continue;
    const { health } = evaluateSchedule(s, v.odometer_miles, now);
    const a = map.get(v.id)!;
    if (health === 'overdue') a.overdue += 1;
    else if (health === 'due_soon') a.dueSoon += 1;
  }
  for (const d of documents) {
    if (!live.has(d.vehicle_id)) continue;
    const { health } = documentHealth(d.expires_on, now);
    const a = map.get(d.vehicle_id)!;
    if (health === 'expired') a.expired += 1;
    else if (health === 'expiring_soon') a.expiring += 1;
  }
  return map;
}

export interface FleetSummary {
  total: number; active: number; inShop: number; retired: number; unassigned: number;
  overdueServices: number; dueSoonServices: number; expiredDocuments: number; expiringDocuments: number;
}

export function summarizeFleet(vehicles: Vehicle[], alerts: Map<string, VehicleAlerts>): FleetSummary {
  const s: FleetSummary = { total: vehicles.length, active: 0, inShop: 0, retired: 0, unassigned: 0, overdueServices: 0, dueSoonServices: 0, expiredDocuments: 0, expiringDocuments: 0 };
  for (const v of vehicles) {
    if (v.status === 'retired') { s.retired += 1; continue; }
    if (v.status === 'active') s.active += 1; else s.inShop += 1;
    if (!v.assigned_technician_id) s.unassigned += 1;
    const a = alerts.get(v.id);
    if (a) { s.overdueServices += a.overdue; s.dueSoonServices += a.dueSoon; s.expiredDocuments += a.expired; s.expiringDocuments += a.expiring; }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Expense summary
// ---------------------------------------------------------------------------

export interface ExpenseSummary {
  total: number;
  byType: Record<ExpenseType, number>;
  milesInWindow: number | null;
  costPerMile: number | null;
}

/** Spend over the last `windowDays`, plus cost/mile when odometer readings allow it (>= 50 mi of evidence). */
export function summarizeExpenses(expenses: VehicleExpense[], now: Date, windowDays = 90): ExpenseSummary {
  const byType = Object.fromEntries(EXPENSE_TYPES.map((t) => [t, 0])) as Record<ExpenseType, number>;
  let total = 0;
  const readings: number[] = [];
  for (const e of expenses) {
    const d = daysUntilDate(e.expense_date, now);
    if (d == null || d < -windowDays || d > 0) continue;
    total += e.amount;
    byType[e.expense_type] = (byType[e.expense_type] ?? 0) + e.amount;
    if (e.odometer_miles != null) readings.push(e.odometer_miles);
  }
  const miles = readings.length >= 2 ? Math.max(...readings) - Math.min(...readings) : null;
  const ok = miles != null && miles >= 50;
  return { total, byType, milesInWindow: ok ? miles : null, costPerMile: ok && miles ? total / miles : null };
}

// ---------------------------------------------------------------------------
// Inspections
// ---------------------------------------------------------------------------

export const INSPECTION_CHECKLIST: { key: string; label: string; critical: boolean }[] = [
  { key: 'brakes', label: 'Brakes & parking brake', critical: true },
  { key: 'steering', label: 'Steering', critical: true },
  { key: 'tires', label: 'Tires & wheels', critical: true },
  { key: 'lights', label: 'Lights & signals', critical: true },
  { key: 'fluids', label: 'Fluids & leaks', critical: false },
  { key: 'engine', label: 'Engine & exhaust', critical: false },
  { key: 'windshield', label: 'Windshield & wipers', critical: false },
  { key: 'mirrors', label: 'Mirrors', critical: false },
  { key: 'horn', label: 'Horn', critical: false },
  { key: 'seatbelts', label: 'Seat belts', critical: false },
  { key: 'safety_kit', label: 'Fire extinguisher & safety kit', critical: false },
  { key: 'cargo', label: 'Cargo securement & racks', critical: false },
];

export function newChecklist(): ChecklistItem[] {
  return INSPECTION_CHECKLIST.map(({ key, label }) => ({ key, label, status: 'ok' as ChecklistStatus }));
}

/** Any critical issue -> fail; any other issue -> needs_attention; otherwise pass. */
export function suggestInspectionResult(items: ChecklistItem[]): InspectionResult {
  const critical = new Set(INSPECTION_CHECKLIST.filter((c) => c.critical).map((c) => c.key));
  const issues = items.filter((i) => i.status === 'issue');
  if (issues.some((i) => critical.has(i.key))) return 'fail';
  return issues.length > 0 ? 'needs_attention' : 'pass';
}

// ---------------------------------------------------------------------------
// Form parsing / validation (forms hold strings; parsers return clean payloads)
// ---------------------------------------------------------------------------

export type FieldErrors = Record<string, string>;
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

interface NumOpts { min?: number; max?: number; integer?: boolean }

function parseNum(raw: string, label: string, errors: FieldErrors, key: string, opts: NumOpts = {}): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) { errors[key] = `${label} must be a number.`; return null; }
  if (opts.integer && !Number.isInteger(n)) { errors[key] = `${label} must be a whole number.`; return null; }
  if (opts.min != null && n < opts.min) { errors[key] = `${label} must be at least ${opts.min.toLocaleString()}.`; return null; }
  if (opts.max != null && n > opts.max) { errors[key] = `${label} must be at most ${opts.max.toLocaleString()}.`; return null; }
  return n;
}

function parseDate(raw: string, label: string, errors: FieldErrors, key: string, now: Date, opts: { allowFuture?: boolean; required?: boolean } = {}): string | null {
  const t = raw.trim();
  if (!t) { if (opts.required) errors[key] = `${label} is required.`; return null; }
  if (!isValidDateOnly(t)) { errors[key] = `${label} is not a valid date.`; return null; }
  if (!opts.allowFuture && (daysUntilDate(t, now) ?? 0) > 0) { errors[key] = `${label} cannot be in the future.`; return null; }
  return t;
}

function checkOdometerJump(value: number | null, current: number, key: string, errors: FieldErrors) {
  if (value != null && value > current + MAX_ODOMETER_JUMP) {
    errors[key] = `That is ${Math.round(value - current).toLocaleString()} mi above the current odometer — please double-check.`;
  }
}

const done = <T>(errors: FieldErrors, value: T): ParseResult<T> => (Object.keys(errors).length ? { ok: false, errors } : { ok: true, value });
const orNull = (s: string) => (s.trim() === '' ? null : s.trim());

// ---- Vehicle ---------------------------------------------------------------

export interface VehicleFormValues {
  label: string; make: string; model: string; year: string; license_plate: string; vin: string;
  fuel_type: string; status: string; odometer_miles: string; monthly_payment_cost: string;
  monthly_insurance_cost: string; purchase_date: string; notes: string;
}

export interface VehiclePayload {
  label: string; make: string | null; model: string | null; year: number | null; license_plate: string | null;
  vin: string | null; fuel_type: string; status: VehicleStatus; odometer_miles: number;
  monthly_payment_cost: number; monthly_insurance_cost: number; purchase_date: string | null; notes: string | null;
}

export const EMPTY_VEHICLE_FORM: VehicleFormValues = {
  label: '', make: '', model: '', year: '', license_plate: '', vin: '', fuel_type: 'gasoline', status: 'active',
  odometer_miles: '', monthly_payment_cost: '', monthly_insurance_cost: '', purchase_date: '', notes: '',
};

export function vehicleToForm(v: Vehicle): VehicleFormValues {
  const s = (x: string | number | null) => (x == null ? '' : String(x));
  return {
    label: v.label, make: s(v.make), model: s(v.model), year: s(v.year), license_plate: s(v.license_plate), vin: s(v.vin),
    fuel_type: v.fuel_type, status: v.status, odometer_miles: s(v.odometer_miles), monthly_payment_cost: s(v.monthly_payment_cost),
    monthly_insurance_cost: s(v.monthly_insurance_cost), purchase_date: s(v.purchase_date), notes: s(v.notes),
  };
}

export function parseVehicleForm(f: VehicleFormValues, now: Date): ParseResult<VehiclePayload> {
  const errors: FieldErrors = {};
  const label = f.label.trim();
  if (!label) errors.label = 'Give the vehicle a name, e.g. "Truck 1".';
  else if (label.length > 80) errors.label = 'Name must be 80 characters or fewer.';

  const year = parseNum(f.year, 'Year', errors, 'year', { integer: true, min: 1980, max: now.getFullYear() + 1 });
  const odometer = parseNum(f.odometer_miles, 'Odometer', errors, 'odometer_miles', { min: 0, max: 5_000_000 });
  const payment = parseNum(f.monthly_payment_cost, 'Monthly payment', errors, 'monthly_payment_cost', { min: 0, max: 1_000_000 });
  const insurance = parseNum(f.monthly_insurance_cost, 'Monthly insurance', errors, 'monthly_insurance_cost', { min: 0, max: 1_000_000 });
  const purchase = parseDate(f.purchase_date, 'Purchase date', errors, 'purchase_date', now);

  const vin = f.vin.trim().toUpperCase();
  if (vin && !/^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin)) errors.vin = 'VIN must be 11–17 letters/digits (no I, O or Q).';
  if (f.license_plate.trim().length > 16) errors.license_plate = 'License plate is too long.';
  if (f.notes.length > 2000) errors.notes = 'Notes must be 2,000 characters or fewer.';
  if (!(FUEL_TYPES as readonly string[]).includes(f.fuel_type)) errors.fuel_type = 'Choose a fuel type.';
  if (!(VEHICLE_STATUSES as readonly string[]).includes(f.status)) errors.status = 'Choose a status.';

  return done(errors, {
    label, make: orNull(f.make), model: orNull(f.model), year, license_plate: orNull(f.license_plate.toUpperCase()),
    vin: vin || null, fuel_type: f.fuel_type, status: f.status as VehicleStatus, odometer_miles: odometer ?? 0,
    monthly_payment_cost: payment ?? 0, monthly_insurance_cost: insurance ?? 0, purchase_date: purchase, notes: orNull(f.notes),
  });
}

// ---- Maintenance schedule --------------------------------------------------

export interface ScheduleFormValues { name: string; interval_miles: string; interval_days: string; last_service_miles: string; last_service_date: string; notes: string }
export interface SchedulePayload { name: string; interval_miles: number | null; interval_days: number | null; last_service_miles: number | null; last_service_date: string | null; notes: string | null }

export const SERVICE_PRESETS: { name: string; miles: number | null; days: number | null }[] = [
  { name: 'Oil & filter change', miles: 5000, days: 180 },
  { name: 'Tire rotation', miles: 7500, days: 180 },
  { name: 'Brake inspection', miles: 12000, days: 365 },
  { name: 'Annual safety inspection', miles: null, days: 365 },
  { name: 'Coolant & fluids check', miles: 30000, days: 730 },
];

export function parseScheduleForm(f: ScheduleFormValues, vehicleOdometer: number, now: Date): ParseResult<SchedulePayload> {
  const errors: FieldErrors = {};
  const name = f.name.trim();
  if (!name) errors.name = 'Name the service, e.g. "Oil change".';
  else if (name.length > 80) errors.name = 'Name must be 80 characters or fewer.';

  const miles = parseNum(f.interval_miles, 'Mileage interval', errors, 'interval_miles', { integer: true, min: 1, max: 500_000 });
  const days = parseNum(f.interval_days, 'Day interval', errors, 'interval_days', { integer: true, min: 1, max: 3650 });
  if (miles == null && days == null && !errors.interval_miles && !errors.interval_days) {
    errors.interval_miles = 'Set a mileage interval, a day interval, or both.';
  }
  let lastMiles = parseNum(f.last_service_miles, 'Last service odometer', errors, 'last_service_miles', { min: 0 });
  let lastDate = parseDate(f.last_service_date, 'Last service date', errors, 'last_service_date', now);
  if (lastMiles != null && lastMiles > vehicleOdometer) errors.last_service_miles = `Cannot exceed the vehicle's current odometer (${Math.round(vehicleOdometer).toLocaleString()} mi).`;

  // Baseline defaults: "serviced just now" — otherwise the schedule could never become due.
  if (miles != null && lastMiles == null) lastMiles = vehicleOdometer;
  if (days != null && lastDate == null) lastDate = toDateOnly(now);
  if (f.notes.length > 500) errors.notes = 'Notes must be 500 characters or fewer.';

  return done(errors, {
    name, interval_miles: miles, interval_days: days,
    last_service_miles: miles != null ? lastMiles : null, last_service_date: days != null ? lastDate : null, notes: orNull(f.notes),
  });
}

export interface CompleteFormValues { service_date: string; odometer: string; cost: string; notes: string }
export interface CompletePayload { service_date: string; odometer: number; cost: number | null; notes: string | null }

export function parseCompleteForm(f: CompleteFormValues, vehicleOdometer: number, now: Date): ParseResult<CompletePayload> {
  const errors: FieldErrors = {};
  const date = parseDate(f.service_date || toDateOnly(now), 'Service date', errors, 'service_date', now, { required: true });
  const odo = parseNum(f.odometer, 'Odometer', errors, 'odometer', { min: 0, max: 5_000_000 });
  checkOdometerJump(odo, vehicleOdometer, 'odometer', errors);
  const cost = parseNum(f.cost, 'Cost', errors, 'cost', { min: 0, max: 1_000_000 });
  if (f.notes.length > 300) errors.notes = 'Notes must be 300 characters or fewer.';
  return done(errors, { service_date: date ?? toDateOnly(now), odometer: odo ?? vehicleOdometer, cost, notes: orNull(f.notes) });
}

// ---- Expense ---------------------------------------------------------------

export interface ExpenseFormValues { expense_type: string; amount: string; expense_date: string; odometer_miles: string; downtime_hours: string; notes: string }
export interface ExpensePayload { expense_type: ExpenseType; amount: number; expense_date: string; odometer_miles: number | null; downtime_hours: number | null; notes: string | null }

export function parseExpenseForm(f: ExpenseFormValues, vehicleOdometer: number, now: Date): ParseResult<ExpensePayload> {
  const errors: FieldErrors = {};
  if (!(EXPENSE_TYPES as readonly string[]).includes(f.expense_type)) errors.expense_type = 'Choose an expense type.';
  const amount = parseNum(f.amount, 'Amount', errors, 'amount', { min: 0.01, max: 1_000_000 });
  if (amount == null && !errors.amount) errors.amount = 'Amount is required.';
  const date = parseDate(f.expense_date || toDateOnly(now), 'Date', errors, 'expense_date', now, { required: true });
  const odo = parseNum(f.odometer_miles, 'Odometer', errors, 'odometer_miles', { min: 0, max: 5_000_000 });
  checkOdometerJump(odo, vehicleOdometer, 'odometer_miles', errors);
  const hours = f.expense_type === 'downtime' ? parseNum(f.downtime_hours, 'Downtime hours', errors, 'downtime_hours', { min: 0, max: 8760 }) : null;
  if (f.notes.length > 500) errors.notes = 'Notes must be 500 characters or fewer.';
  return done(errors, {
    expense_type: f.expense_type as ExpenseType, amount: amount ?? 0, expense_date: date ?? toDateOnly(now),
    odometer_miles: odo, downtime_hours: hours, notes: orNull(f.notes),
  });
}

// ---- Inspection ------------------------------------------------------------

export interface InspectionFormValues { inspection_type: string; result: string; odometer_miles: string; notes: string; items: ChecklistItem[] }
export interface InspectionPayload { inspection_type: InspectionType; result: InspectionResult; odometer_miles: number | null; notes: string | null; checklist: ChecklistItem[] }

export function parseInspectionForm(f: InspectionFormValues, vehicleOdometer: number): ParseResult<InspectionPayload> {
  const errors: FieldErrors = {};
  if (!(INSPECTION_TYPES as readonly string[]).includes(f.inspection_type)) errors.inspection_type = 'Choose an inspection type.';
  if (!(INSPECTION_RESULTS as readonly string[]).includes(f.result)) errors.result = 'Choose a result.';
  const odo = parseNum(f.odometer_miles, 'Odometer', errors, 'odometer_miles', { min: 0, max: 5_000_000 });
  checkOdometerJump(odo, vehicleOdometer, 'odometer_miles', errors);
  const hasIssue = f.items.some((i) => i.status === 'issue');
  if (f.result === 'pass' && hasIssue) errors.result = 'A passing inspection cannot have checklist items marked as an issue.';
  if (f.result !== 'pass' && f.result && f.notes.trim().length < 3) errors.notes = 'Describe what needs attention.';
  if (f.notes.length > 2000) errors.notes = 'Notes must be 2,000 characters or fewer.';
  return done(errors, {
    inspection_type: f.inspection_type as InspectionType, result: f.result as InspectionResult,
    odometer_miles: odo, notes: orNull(f.notes), checklist: f.items.map(({ key, label, status }) => ({ key, label, status })),
  });
}

// ---- Documents -------------------------------------------------------------

export interface DocumentFormValues { doc_type: string; title: string; issued_on: string; expires_on: string }
export interface DocumentMeta { doc_type: DocumentType; title: string; issued_on: string | null; expires_on: string | null }

/** Browsers often report '' for HEIC, so fall back to the file extension. */
export function resolveDocumentMime(file: { name: string; type: string }): string | null {
  if ((DOCUMENT_MIME_TYPES as readonly string[]).includes(file.type)) return file.type;
  if (file.type) return null;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return DOCUMENT_EXTENSIONS[ext] ?? null;
}

export function validateDocumentFile(file: { name: string; size: number; type: string }): string | null {
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > MAX_DOCUMENT_BYTES) return 'File is too large — the limit is 15 MB.';
  if (!resolveDocumentMime(file)) return 'Unsupported file type. Upload a PDF, JPG, PNG, WebP or HEIC.';
  return null;
}

export function parseDocumentForm(f: DocumentFormValues, now: Date): ParseResult<DocumentMeta> {
  const errors: FieldErrors = {};
  if (!(DOCUMENT_TYPES as readonly string[]).includes(f.doc_type)) errors.doc_type = 'Choose a document type.';
  const title = f.title.trim();
  if (!title) errors.title = 'Give the document a title.';
  else if (title.length > 120) errors.title = 'Title must be 120 characters or fewer.';
  const issued = parseDate(f.issued_on, 'Issue date', errors, 'issued_on', now);
  const expires = parseDate(f.expires_on, 'Expiry date', errors, 'expires_on', now, { allowFuture: true });
  if (issued && expires && expires < issued) errors.expires_on = 'Expiry must be on or after the issue date.';
  return done(errors, { doc_type: f.doc_type as DocumentType, title, issued_on: issued, expires_on: expires });
}

/** `<owner>/<vehicle>/<uuid>-<safe-name>` — the owner folder is what the storage policy checks. */
export function buildDocumentPath(ownerId: string, vehicleId: string, fileName: string, uniqueId: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot + 1) : '';
  const clean = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const safeBase = clean(base).slice(0, 60) || 'document';
  const safeExt = clean(ext).slice(0, 8);
  return `${ownerId}/${vehicleId}/${uniqueId}-${safeBase}${safeExt ? `.${safeExt}` : ''}`;
}
