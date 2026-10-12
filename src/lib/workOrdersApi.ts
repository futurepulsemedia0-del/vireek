import { supabase } from '@/lib/supabase';
import {
  describeSaveError,
  type WorkOrder,
  type WorkOrderVisit,
} from '@/lib/workOrders';

/**
 * Data access for commercial work orders.
 *
 * Every call is explicitly scoped to the ACCOUNT owner id (never the signed-in
 * user's own id, which differs for team members). Row Level Security enforces
 * the same boundary plus the billing permission, so these filters are defense
 * in depth, not the only wall.
 */

export class WorkOrderApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'WorkOrderApiError';
    this.code = code;
  }
}

function fail(error: { code?: string; message?: string }): never {
  throw new WorkOrderApiError(describeSaveError(error), error.code);
}

type WorkOrderPatch = Partial<
  Omit<WorkOrder, 'id' | 'user_id' | 'created_at' | 'updated_at' | 'approved_at'>
>;
export type VisitPatch = Partial<
  Pick<
    WorkOrderVisit,
    | 'scheduled_start'
    | 'scheduled_end'
    | 'assigned_technician_id'
    | 'status'
    | 'notes'
    | 'billing_status'
    | 'billable_amount_cents'
    | 'invoice_reference'
  >
>;

export interface CustomerOption {
  id: string;
  name: string;
  address: string | null;
}

export interface TechnicianOption {
  id: string;
  name: string;
}

const WORK_ORDER_LIMIT = 500;
const VISIT_LIMIT = 5000;

export async function fetchWorkOrders(ownerId: string): Promise<WorkOrder[]> {
  const { data, error } = await supabase
    .from('work_orders')
    .select('*')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(WORK_ORDER_LIMIT);
  if (error) fail(error);
  return (data ?? []) as WorkOrder[];
}

export async function fetchVisits(ownerId: string): Promise<WorkOrderVisit[]> {
  const { data, error } = await supabase
    .from('work_order_visits')
    .select('*')
    .eq('user_id', ownerId)
    .order('visit_number', { ascending: true })
    .limit(VISIT_LIMIT);
  if (error) fail(error);
  return (data ?? []) as WorkOrderVisit[];
}

export async function fetchCommercialCustomers(ownerId: string): Promise<CustomerOption[]> {
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, address')
    .eq('user_id', ownerId)
    .eq('customer_type', 'commercial')
    .order('name', { ascending: true });
  if (error) fail(error);
  return (data ?? []) as CustomerOption[];
}

export async function fetchTechnicians(ownerId: string): Promise<TechnicianOption[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, member_name, member_email')
    .eq('account_owner_id', ownerId)
    .eq('invite_status', 'active')
    .order('member_name', { ascending: true });
  if (error) fail(error);
  return ((data ?? []) as { id: string; member_name: string | null; member_email: string }[]).map((m) => ({
    id: m.id,
    name: m.member_name?.trim() || m.member_email,
  }));
}

export async function createWorkOrder(ownerId: string, payload: WorkOrderPatch): Promise<WorkOrder> {
  const { data, error } = await supabase
    .from('work_orders')
    .insert({ ...payload, user_id: ownerId })
    .select('*')
    .single();
  if (error) fail(error);
  return data as WorkOrder;
}

export async function updateWorkOrder(ownerId: string, id: string, patch: WorkOrderPatch): Promise<WorkOrder> {
  const { data, error } = await supabase
    .from('work_orders')
    .update(patch)
    .eq('id', id)
    .eq('user_id', ownerId)
    .select('*')
    .single();
  if (error) fail(error);
  return data as WorkOrder;
}

export async function deleteWorkOrder(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('work_orders').delete().eq('id', id).eq('user_id', ownerId);
  if (error) fail(error);
}

export async function createVisit(
  ownerId: string,
  workOrderId: string,
  payload: VisitPatch,
): Promise<WorkOrderVisit> {
  const { data, error } = await supabase
    .from('work_order_visits')
    .insert({ ...payload, work_order_id: workOrderId, user_id: ownerId })
    .select('*')
    .single();
  if (error) fail(error);
  return data as WorkOrderVisit;
}

export async function updateVisit(ownerId: string, id: string, patch: VisitPatch): Promise<WorkOrderVisit> {
  const { data, error } = await supabase
    .from('work_order_visits')
    .update(patch)
    .eq('id', id)
    .eq('user_id', ownerId)
    .select('*')
    .single();
  if (error) fail(error);
  return data as WorkOrderVisit;
}

export async function deleteVisit(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('work_order_visits').delete().eq('id', id).eq('user_id', ownerId);
  if (error) fail(error);
}
