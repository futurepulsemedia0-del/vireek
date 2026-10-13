import { describe, it, expect } from 'vitest';
import {
  EMPTY_VEHICLE_FORM, MAX_DOCUMENT_BYTES,
  buildDocumentPath, buildVehicleAlerts, daysUntilDate, documentHealth, evaluateSchedule, formatMiles, newChecklist,
  parseCompleteForm, parseDocumentForm, parseExpenseForm, parseInspectionForm, parseScheduleForm, parseVehicleForm,
  sortScheduleViews, suggestInspectionResult, summarizeExpenses, summarizeFleet, toDateOnly, validateDocumentFile,
  type MaintenanceSchedule, type Vehicle, type VehicleExpense, type VehicleInspection,
} from './vehicleManagement';

// Local noon avoids any timezone edge in date-only math.
const NOW = new Date(2026, 9, 8, 12, 0, 0);

const vehicle = (over: Partial<Vehicle> = {}): Vehicle => ({
  id: 'v1', label: 'Truck 1', make: 'Ford', model: 'Transit', year: 2022, license_plate: null, vin: null, fuel_type: 'gasoline',
  assigned_technician_id: 't1', status: 'active', odometer_miles: 50_000, monthly_payment_cost: 0, monthly_insurance_cost: 0,
  purchase_date: null, notes: null, created_at: '2026-01-01T00:00:00Z', ...over,
});

const schedule = (over: Partial<MaintenanceSchedule> = {}): MaintenanceSchedule => ({
  id: 's1', vehicle_id: 'v1', name: 'Oil change', interval_miles: 5000, interval_days: 180,
  last_service_miles: 48_000, last_service_date: '2026-09-01', active: true, ...over,
});

const expense = (over: Partial<VehicleExpense> = {}): VehicleExpense => ({
  id: 'e1', vehicle_id: 'v1', expense_type: 'fuel', amount: 100, expense_date: '2026-10-01', odometer_miles: null, downtime_hours: null, notes: null, ...over,
});

describe('date helpers', () => {
  it('counts whole days in local calendar terms', () => {
    expect(toDateOnly(NOW)).toBe('2026-10-08');
    expect(daysUntilDate('2026-10-08', NOW)).toBe(0);
    expect(daysUntilDate('2026-10-18', NOW)).toBe(10);
    expect(daysUntilDate('2026-10-01', NOW)).toBe(-7);
  });
  it('rejects impossible dates', () => {
    expect(daysUntilDate('2026-02-30', NOW)).toBeNull();
    expect(daysUntilDate('not-a-date', NOW)).toBeNull();
  });
});

describe('evaluateSchedule', () => {
  it('is ok when well within both intervals', () => {
    expect(evaluateSchedule(schedule(), 50_000, NOW).health).toBe('ok');
  });
  it('is overdue when mileage is passed', () => {
    expect(evaluateSchedule(schedule({ last_service_miles: 40_000 }), 50_000, NOW).health).toBe('overdue');
  });
  it('is overdue when the day interval is passed', () => {
    expect(evaluateSchedule(schedule({ last_service_date: '2026-01-01' }), 50_000, NOW).health).toBe('overdue');
  });
  it('is due soon when close to the mileage limit', () => {
    expect(evaluateSchedule(schedule({ last_service_miles: 45_400 }), 50_000, NOW).health).toBe('due_soon');
  });
  it('reports no_baseline instead of a false "ok"', () => {
    expect(evaluateSchedule(schedule({ last_service_miles: null, last_service_date: null }), 50_000, NOW).health).toBe('no_baseline');
  });
  it('reports paused for inactive schedules', () => {
    expect(evaluateSchedule(schedule({ active: false, last_service_miles: 1 }), 50_000, NOW).health).toBe('paused');
  });
  it('sorts most urgent first and paused last', () => {
    const views = [
      evaluateSchedule(schedule({ id: 'a', name: 'A', active: false }), 50_000, NOW),
      evaluateSchedule(schedule({ id: 'b', name: 'B' }), 50_000, NOW),
      evaluateSchedule(schedule({ id: 'c', name: 'C', last_service_miles: 40_000 }), 50_000, NOW),
    ];
    expect(sortScheduleViews(views).map((v) => v.schedule.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('documentHealth', () => {
  it('classifies expiry windows', () => {
    expect(documentHealth(null, NOW).health).toBe('no_expiry');
    expect(documentHealth('2026-10-07', NOW).health).toBe('expired');
    expect(documentHealth('2026-10-08', NOW).health).toBe('expiring_soon');
    expect(documentHealth('2026-11-07', NOW).health).toBe('expiring_soon');
    expect(documentHealth('2026-11-08', NOW).health).toBe('valid');
  });
});

describe('fleet alerts and summary', () => {
  it('counts alerts for live vehicles and ignores retired ones', () => {
    const vehicles = [vehicle(), vehicle({ id: 'v2', status: 'retired', assigned_technician_id: null })];
    const schedules = [schedule({ last_service_miles: 40_000 }), schedule({ id: 's2', vehicle_id: 'v2', last_service_miles: 1 })];
    const docs = [{ vehicle_id: 'v1', expires_on: '2026-10-01' }, { vehicle_id: 'v1', expires_on: '2026-10-20' }, { vehicle_id: 'v2', expires_on: '2020-01-01' }];
    const alerts = buildVehicleAlerts(vehicles, schedules, docs, NOW);
    expect(alerts.get('v1')).toEqual({ overdue: 1, dueSoon: 0, expired: 1, expiring: 1 });
    expect(alerts.get('v2')).toEqual({ overdue: 0, dueSoon: 0, expired: 0, expiring: 0 });
    const summary = summarizeFleet(vehicles, alerts);
    expect(summary).toMatchObject({ total: 2, active: 1, retired: 1, unassigned: 0, overdueServices: 1, expiredDocuments: 1, expiringDocuments: 1 });
  });
  it('counts unassigned only among non-retired vehicles', () => {
    const vehicles = [vehicle({ assigned_technician_id: null }), vehicle({ id: 'v2', status: 'in_shop', assigned_technician_id: null }), vehicle({ id: 'v3', status: 'retired', assigned_technician_id: null })];
    const s = summarizeFleet(vehicles, buildVehicleAlerts(vehicles, [], [], NOW));
    expect(s).toMatchObject({ unassigned: 2, inShop: 1, retired: 1 });
  });
});

describe('summarizeExpenses', () => {
  it('totals only the window and computes cost per mile from odometer readings', () => {
    const list = [
      expense({ amount: 100, expense_date: '2026-10-01', odometer_miles: 50_000 }),
      expense({ id: 'e2', amount: 100, expense_date: '2026-09-01', odometer_miles: 49_000, expense_type: 'repair' }),
      expense({ id: 'e3', amount: 999, expense_date: '2025-01-01', odometer_miles: 10_000 }),
    ];
    const s = summarizeExpenses(list, NOW, 90);
    expect(s.total).toBe(200);
    expect(s.byType.repair).toBe(100);
    expect(s.milesInWindow).toBe(1000);
    expect(s.costPerMile).toBeCloseTo(0.2);
  });
  it('returns null cost/mile without enough evidence', () => {
    const s = summarizeExpenses([expense({ odometer_miles: 50_000 })], NOW);
    expect(s.costPerMile).toBeNull();
    expect(s.total).toBe(100);
  });
  it('ignores future-dated rows', () => {
    expect(summarizeExpenses([expense({ expense_date: '2026-12-01' })], NOW).total).toBe(0);
  });
});

describe('parseVehicleForm', () => {
  it('requires a name and normalises optional fields', () => {
    const bad = parseVehicleForm(EMPTY_VEHICLE_FORM, NOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.label).toBeTruthy();

    const good = parseVehicleForm({ ...EMPTY_VEHICLE_FORM, label: ' Truck 2 ', license_plate: 'abc-123', vin: '1fa6p8cf5l5123456', year: '2021', odometer_miles: '12000' }, NOW);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value).toMatchObject({ label: 'Truck 2', license_plate: 'ABC-123', vin: '1FA6P8CF5L5123456', year: 2021, odometer_miles: 12_000, make: null });
  });
  it('rejects bad VIN, year, negative money and future purchase date', () => {
    const r = parseVehicleForm({ ...EMPTY_VEHICLE_FORM, label: 'x', vin: 'OOOOOOOOOOO', year: '1900', monthly_payment_cost: '-5', purchase_date: '2099-01-01' }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['monthly_payment_cost', 'purchase_date', 'vin', 'year']);
  });
});

describe('parseScheduleForm', () => {
  const base = { name: 'Oil', interval_miles: '', interval_days: '', last_service_miles: '', last_service_date: '', notes: '' };
  it('needs at least one interval', () => {
    const r = parseScheduleForm(base, 50_000, NOW);
    expect(r.ok).toBe(false);
  });
  it('defaults the baseline to "serviced now"', () => {
    const r = parseScheduleForm({ ...base, interval_miles: '5000', interval_days: '180' }, 50_000, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ last_service_miles: 50_000, last_service_date: '2026-10-08' });
  });
  it('drops the baseline of an interval that is not used', () => {
    const r = parseScheduleForm({ ...base, interval_days: '365', last_service_miles: '40000' }, 50_000, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ interval_miles: null, last_service_miles: null, last_service_date: '2026-10-08' });
  });
  it('rejects a last-service odometer above the current one', () => {
    const r = parseScheduleForm({ ...base, interval_miles: '5000', last_service_miles: '60000' }, 50_000, NOW);
    expect(r.ok).toBe(false);
  });
});

describe('parseCompleteForm / parseExpenseForm', () => {
  it('defaults to today and the vehicle odometer', () => {
    const r = parseCompleteForm({ service_date: '', odometer: '', cost: '', notes: '' }, 50_000, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ service_date: '2026-10-08', odometer: 50_000, cost: null, notes: null });
  });
  it('flags an odometer typo', () => {
    const r = parseCompleteForm({ service_date: '', odometer: '900000', cost: '', notes: '' }, 50_000, NOW);
    expect(r.ok).toBe(false);
  });
  it('requires a positive expense amount', () => {
    const f = { expense_type: 'fuel', amount: '0', expense_date: '', odometer_miles: '', downtime_hours: '', notes: '' };
    expect(parseExpenseForm(f, 50_000, NOW).ok).toBe(false);
    expect(parseExpenseForm({ ...f, amount: '45.5' }, 50_000, NOW).ok).toBe(true);
  });
  it('keeps downtime hours only for downtime expenses', () => {
    const f = { expense_type: 'fuel', amount: '10', expense_date: '', odometer_miles: '', downtime_hours: '5', notes: '' };
    const fuel = parseExpenseForm(f, 0, NOW);
    const down = parseExpenseForm({ ...f, expense_type: 'downtime' }, 0, NOW);
    if (fuel.ok && down.ok) { expect(fuel.value.downtime_hours).toBeNull(); expect(down.value.downtime_hours).toBe(5); } else throw new Error('expected ok');
  });
});

describe('inspections', () => {
  it('suggests fail for a critical issue and needs_attention for others', () => {
    const items = newChecklist();
    expect(suggestInspectionResult(items)).toBe('pass');
    items.find((i) => i.key === 'horn')!.status = 'issue';
    expect(suggestInspectionResult(items)).toBe('needs_attention');
    items.find((i) => i.key === 'brakes')!.status = 'issue';
    expect(suggestInspectionResult(items)).toBe('fail');
  });
  it('rejects a pass that contains an issue, and requires notes for non-pass results', () => {
    const items = newChecklist();
    items[0].status = 'issue';
    const base = { inspection_type: 'pre_trip', odometer_miles: '', notes: '', items };
    expect(parseInspectionForm({ ...base, result: 'pass' }, 0).ok).toBe(false);
    expect(parseInspectionForm({ ...base, result: 'fail' }, 0).ok).toBe(false);
    expect(parseInspectionForm({ ...base, result: 'fail', notes: 'Brake pedal soft' }, 0).ok).toBe(true);
  });
  it('accepts a clean pass without notes', () => {
    const r = parseInspectionForm({ inspection_type: 'annual', result: 'pass', odometer_miles: '', notes: '', items: newChecklist() }, 0);
    expect(r.ok).toBe(true);
  });
});

describe('documents', () => {
  it('validates size and type (with extension fallback for empty MIME)', () => {
    expect(validateDocumentFile({ name: 'a.pdf', size: 10, type: 'application/pdf' })).toBeNull();
    expect(validateDocumentFile({ name: 'a.heic', size: 10, type: '' })).toBeNull();
    expect(validateDocumentFile({ name: 'a.exe', size: 10, type: 'application/x-msdownload' })).toMatch(/Unsupported/);
    expect(validateDocumentFile({ name: 'a.pdf', size: MAX_DOCUMENT_BYTES + 1, type: 'application/pdf' })).toMatch(/too large/);
    expect(validateDocumentFile({ name: 'a.pdf', size: 0, type: 'application/pdf' })).toMatch(/empty/);
  });
  it('requires a title and ordered dates', () => {
    const f = { doc_type: 'insurance', title: '', issued_on: '', expires_on: '' };
    expect(parseDocumentForm(f, NOW).ok).toBe(false);
    expect(parseDocumentForm({ ...f, title: 'Policy', issued_on: '2026-05-01', expires_on: '2026-04-01' }, NOW).ok).toBe(false);
    expect(parseDocumentForm({ ...f, title: 'Policy', expires_on: '2027-04-01' }, NOW).ok).toBe(true);
  });
  it('builds a safe storage path under the owner folder', () => {
    expect(buildDocumentPath('own', 'veh', '../Évil Name (1).PDF', 'uid')).toBe('own/veh/uid-evil-name-1.pdf');
    expect(buildDocumentPath('own', 'veh', '日本語', 'uid')).toBe('own/veh/uid-document');
  });
});

describe('formatMiles', () => {
  it('formats and handles missing values', () => {
    expect(formatMiles(null)).toBe('—');
    expect(formatMiles(1234.6)).toMatch(/1,235 mi|1.235 mi/);
  });
});

// Type-only guard: keeps VehicleInspection exported shape in sync with the checklist.
const _typecheck: Pick<VehicleInspection, 'checklist'> = { checklist: newChecklist() };
void _typecheck;
