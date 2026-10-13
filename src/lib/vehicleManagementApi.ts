// Supabase data access for /dashboard/vehicles. Every function throws an
// Error with a user-presentable message; callers decide how to surface it.
// RLS scopes every row to the account owner — `ownerId` is only used to set
// user_id on inserts and as the first storage folder.
import { supabase } from '@/lib/supabase';
import {
  buildDocumentPath, resolveDocumentMime,
  type CompletePayload, type DocumentMeta, type ExpensePayload, type InspectionPayload, type MaintenanceSchedule,
  type SchedulePayload, type Technician, type Vehicle, type VehicleAssignment, type VehicleDocument,
  type VehicleExpense, type VehicleInspection, type VehiclePayload,
} from '@/lib/vehicleManagement';

const BUCKET = 'vehicle-documents';

const VEHICLE_COLS =
  'id, label, make, model, year, license_plate, vin, fuel_type, assigned_technician_id, status, odometer_miles, monthly_payment_cost, monthly_insurance_cost, purchase_date, notes, created_at';
const SCHEDULE_COLS = 'id, vehicle_id, name, interval_miles, interval_days, last_service_miles, last_service_date, active';
const DOCUMENT_COLS = 'id, vehicle_id, doc_type, title, storage_path, file_name, mime_type, size_bytes, issued_on, expires_on, created_at';

interface DbError { message?: string; code?: string }

function fail(error: DbError | null | undefined, fallback: string): never {
  if (error?.code === '23505') throw new Error('That record already exists.');
  if (error?.code === '23503') throw new Error('A linked record no longer exists. Refresh and try again.');
  if (error?.code === '42501') throw new Error("You don't have permission to do that.");
  // Messages we raise ourselves inside the RPCs are safe to show.
  if (error?.code === 'P0002' || error?.code === '22023') throw new Error(error.message || fallback);
  throw new Error(fallback);
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

function toVehicle(r: Record<string, unknown>): Vehicle {
  return {
    ...(r as unknown as Vehicle),
    odometer_miles: num(r.odometer_miles),
    monthly_payment_cost: num(r.monthly_payment_cost),
    monthly_insurance_cost: num(r.monthly_insurance_cost),
    year: numOrNull(r.year),
  };
}

const toSchedule = (r: Record<string, unknown>): MaintenanceSchedule => ({
  ...(r as unknown as MaintenanceSchedule),
  interval_miles: numOrNull(r.interval_miles),
  last_service_miles: numOrNull(r.last_service_miles),
});

// ---------------------------------------------------------------------------
// Fleet bundle (roster + alerts inputs)
// ---------------------------------------------------------------------------

export interface FleetBundle {
  vehicles: Vehicle[];
  technicians: Technician[];
  schedules: MaintenanceSchedule[];
  documents: VehicleDocument[];
}

export async function fetchFleetBundle(): Promise<FleetBundle> {
  const [v, t, s, d] = await Promise.all([
    supabase.from('vehicles').select(VEHICLE_COLS).order('label', { ascending: true }),
    supabase.rpc('vehicle_assignable_technicians'),
    supabase.from('vehicle_maintenance_schedules').select(SCHEDULE_COLS).order('created_at', { ascending: true }),
    supabase.from('vehicle_documents').select(DOCUMENT_COLS).order('created_at', { ascending: false }),
  ]);
  if (v.error) fail(v.error, 'Could not load your vehicles.');
  if (t.error) fail(t.error, 'Could not load your technicians.');
  if (s.error) fail(s.error, 'Could not load maintenance schedules.');
  if (d.error) fail(d.error, 'Could not load vehicle documents.');
  return {
    vehicles: ((v.data ?? []) as Record<string, unknown>[]).map(toVehicle),
    technicians: (t.data ?? []) as Technician[],
    schedules: ((s.data ?? []) as Record<string, unknown>[]).map(toSchedule),
    documents: ((d.data ?? []) as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as VehicleDocument), size_bytes: num(r.size_bytes) })),
  };
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export async function saveVehicle(ownerId: string, payload: VehiclePayload, id?: string): Promise<Vehicle> {
  const query = id
    ? supabase.from('vehicles').update(payload).eq('id', id)
    : supabase.from('vehicles').insert({ ...payload, user_id: ownerId });
  const { data, error } = await query.select(VEHICLE_COLS).single();
  if (error) fail(error, id ? 'Could not update the vehicle.' : 'Could not add the vehicle.');
  const saved = toVehicle(data as Record<string, unknown>);
  // A retired vehicle must not stay assigned (assign_vehicle also closes the history row).
  if (saved.status === 'retired' && saved.assigned_technician_id) {
    await assignVehicle(saved.id, null, null);
    return { ...saved, assigned_technician_id: null };
  }
  return saved;
}

export async function deleteVehicle(id: string): Promise<void> {
  // Collect file paths first: the DB cascade removes document rows but not storage objects.
  const { data: docs } = await supabase.from('vehicle_documents').select('storage_path').eq('vehicle_id', id);
  const { error } = await supabase.from('vehicles').delete().eq('id', id);
  if (error) fail(error, 'Could not delete the vehicle.');
  const paths = ((docs ?? []) as { storage_path: string }[]).map((d) => d.storage_path);
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export async function assignVehicle(vehicleId: string, technicianId: string | null, notes: string | null): Promise<void> {
  const { error } = await supabase.rpc('assign_vehicle', { p_vehicle_id: vehicleId, p_technician_id: technicianId, p_notes: notes });
  if (error) fail(error, 'Could not change the assignment.');
}

export async function fetchAssignments(vehicleId: string): Promise<VehicleAssignment[]> {
  const { data, error } = await supabase
    .from('vehicle_assignments')
    .select('id, vehicle_id, technician_id, technician_name, assigned_at, unassigned_at, notes')
    .eq('vehicle_id', vehicleId)
    .order('assigned_at', { ascending: false })
    .limit(100);
  if (error) fail(error, 'Could not load assignment history.');
  return (data ?? []) as VehicleAssignment[];
}

// ---------------------------------------------------------------------------
// Maintenance schedules (table shared with Telematics OS)
// ---------------------------------------------------------------------------

export async function createSchedule(ownerId: string, vehicleId: string, p: SchedulePayload): Promise<void> {
  const { error } = await supabase.from('vehicle_maintenance_schedules').insert({ ...p, user_id: ownerId, vehicle_id: vehicleId, active: true });
  if (error) fail(error, 'Could not save the schedule.');
}

export async function setScheduleActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('vehicle_maintenance_schedules').update({ active }).eq('id', id);
  if (error) fail(error, 'Could not update the schedule.');
}

export async function deleteSchedule(id: string): Promise<void> {
  const { error } = await supabase.from('vehicle_maintenance_schedules').delete().eq('id', id);
  if (error) fail(error, 'Could not delete the schedule.');
}

export async function completeMaintenance(scheduleId: string, p: CompletePayload): Promise<void> {
  const { error } = await supabase.rpc('complete_vehicle_maintenance', {
    p_schedule_id: scheduleId, p_service_date: p.service_date, p_odometer: p.odometer, p_cost: p.cost, p_notes: p.notes,
  });
  if (error) fail(error, 'Could not record the service.');
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export async function fetchExpenses(vehicleId: string): Promise<VehicleExpense[]> {
  const { data, error } = await supabase
    .from('vehicle_expenses')
    .select('id, vehicle_id, expense_type, amount, expense_date, odometer_miles, downtime_hours, notes')
    .eq('vehicle_id', vehicleId)
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) fail(error, 'Could not load expenses.');
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    ...(r as unknown as VehicleExpense), amount: num(r.amount), odometer_miles: numOrNull(r.odometer_miles), downtime_hours: numOrNull(r.downtime_hours),
  }));
}

export async function createExpense(ownerId: string, vehicleId: string, p: ExpensePayload): Promise<void> {
  const { error } = await supabase.from('vehicle_expenses').insert({ ...p, user_id: ownerId, vehicle_id: vehicleId });
  if (error) fail(error, 'Could not log the expense.');
}

export async function deleteExpense(id: string): Promise<void> {
  const { error } = await supabase.from('vehicle_expenses').delete().eq('id', id);
  if (error) fail(error, 'Could not delete the expense.');
}

// ---------------------------------------------------------------------------
// Inspections
// ---------------------------------------------------------------------------

export async function fetchInspections(vehicleId: string): Promise<VehicleInspection[]> {
  const { data, error } = await supabase
    .from('vehicle_inspections')
    .select('id, vehicle_id, inspection_type, result, inspected_at, odometer_miles, checklist, notes')
    .eq('vehicle_id', vehicleId)
    .order('inspected_at', { ascending: false })
    .limit(100);
  if (error) fail(error, 'Could not load inspections.');
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    ...(r as unknown as VehicleInspection), odometer_miles: numOrNull(r.odometer_miles), checklist: Array.isArray(r.checklist) ? (r.checklist as VehicleInspection['checklist']) : [],
  }));
}

/** Returns false when the inspection saved but the vehicle could not be moved to "in shop". */
export async function createInspection(ownerId: string, vehicleId: string, p: InspectionPayload, markInShop: boolean): Promise<boolean> {
  const { error } = await supabase.from('vehicle_inspections').insert({ ...p, user_id: ownerId, vehicle_id: vehicleId });
  if (error) fail(error, 'Could not save the inspection.');
  if (!markInShop) return true;
  const { error: statusError } = await supabase.from('vehicles').update({ status: 'in_shop' }).eq('id', vehicleId);
  return !statusError;
}

export async function deleteInspection(id: string): Promise<void> {
  const { error } = await supabase.from('vehicle_inspections').delete().eq('id', id);
  if (error) fail(error, 'Could not delete the inspection.');
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function uploadDocument(ownerId: string, vehicleId: string, file: File, meta: DocumentMeta): Promise<void> {
  const mime = resolveDocumentMime(file);
  if (!mime) throw new Error('Unsupported file type.');
  const path = buildDocumentPath(ownerId, vehicleId, file.name, crypto.randomUUID());
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: mime, upsert: false });
  if (uploadError) throw new Error('Upload failed. Check your connection and try again.');
  const { error } = await supabase.from('vehicle_documents').insert({
    ...meta, user_id: ownerId, vehicle_id: vehicleId, storage_path: path, file_name: file.name.slice(0, 200), mime_type: mime, size_bytes: file.size,
  });
  if (error) {
    // Don't leave an orphaned file behind if the row could not be saved.
    await supabase.storage.from(BUCKET).remove([path]).catch(() => undefined);
    fail(error, 'Could not save the document.');
  }
}

export async function getDocumentUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60);
  if (error || !data?.signedUrl) throw new Error('Could not open the document.');
  return data.signedUrl;
}

export async function deleteDocument(doc: Pick<VehicleDocument, 'id' | 'storage_path'>): Promise<void> {
  const { error } = await supabase.from('vehicle_documents').delete().eq('id', doc.id);
  if (error) fail(error, 'Could not delete the document.');
  await supabase.storage.from(BUCKET).remove([doc.storage_path]).catch(() => undefined);
}
