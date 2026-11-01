import { supabase } from '@/lib/supabase';
import { friendlyError } from '@/lib/installProjects';
import type { ChangeOrder, ChangeOrderPayload } from '@/lib/projectChangeOrders';

// Change Orders data layer. Every query is scoped to the account owner on top
// of RLS. Status changes, invoicing and signature linking never touch the
// table directly: they go through the SECURITY DEFINER RPCs in
// 20280105000000_install_change_orders.sql so the database stays the single authority.

type Res<T> = { data: T | null; error: { message: string } | null };

function unwrap<T>(res: Res<T>, fallback: string): T {
  if (res.error) throw new Error(friendlyError(res.error, fallback));
  return res.data as T;
}

export async function fetchChangeOrders(ownerId: string, projectId: string): Promise<ChangeOrder[]> {
  return (
    unwrap(
      (await supabase.from('install_change_orders').select('*').eq('user_id', ownerId).eq('project_id', projectId).order('seq')) as Res<ChangeOrder[]>,
      'Could not load change orders.',
    ) ?? []
  );
}

export async function createChangeOrder(ownerId: string, projectId: string, payload: ChangeOrderPayload): Promise<string> {
  const row = unwrap(
    (await supabase
      .from('install_change_orders')
      .insert({ user_id: ownerId, project_id: projectId, ...payload })
      .select('id')
      .single()) as Res<{ id: string }>,
    'Could not create the change order.',
  );
  return row.id;
}

export async function updateChangeOrder(ownerId: string, id: string, payload: ChangeOrderPayload): Promise<void> {
  unwrap(
    (await supabase.from('install_change_orders').update(payload).eq('id', id).eq('user_id', ownerId).eq('status', 'draft')) as Res<null>,
    'Could not update the change order.',
  );
}

export async function deleteChangeOrder(ownerId: string, id: string): Promise<void> {
  unwrap(
    (await supabase.from('install_change_orders').delete().eq('id', id).eq('user_id', ownerId).eq('status', 'draft')) as Res<null>,
    'Could not delete the change order.',
  );
}

async function rpc<T>(fn: string, args: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(friendlyError(error, fallback));
  return data as T;
}

/** Links a draft to the signature request that was just created for it. */
export const markChangeOrderSent = (id: string, signatureRequestId: string) =>
  rpc<string>('ico_mark_sent', { p_id: id, p_signature_request_id: signatureRequestId }, 'The request was sent, but the change order could not be linked to it. Refresh and check its status.');

export const voidChangeOrder = (id: string, reason?: string) =>
  rpc<string>('ico_void', { p_id: id, p_reason: reason?.trim() || null }, 'Could not withdraw the change order.');

export const reopenChangeOrder = (id: string) => rpc<string>('ico_reopen', { p_id: id }, 'Could not reopen the change order.');

export const invoiceChangeOrder = (id: string, dueDate: string) =>
  rpc<string>('ico_invoice', { p_id: id, p_due_date: dueDate || null }, 'Could not create the invoice.');

export interface SyncResult {
  changed: number;
  error: string | null;
}

/** Re-reads the e-signature outcome of every change order still awaiting a signature. */
export async function syncChangeOrders(projectId: string): Promise<SyncResult> {
  const r = await rpc<{ changed?: number; error?: string | null } | null>('ico_sync', { p_project_id: projectId }, 'Could not check signature status.');
  return { changed: Number(r?.changed ?? 0), error: r?.error ?? null };
}

export interface CustomerContact {
  email: string | null;
  phone: string | null;
}

export async function fetchCustomerContact(ownerId: string, customerId: string | null): Promise<CustomerContact> {
  if (!customerId) return { email: null, phone: null };
  const { data } = (await supabase.from('customers').select('email, phone').eq('user_id', ownerId).eq('id', customerId).maybeSingle()) as Res<CustomerContact>;
  return { email: data?.email ?? null, phone: data?.phone ?? null };
}
