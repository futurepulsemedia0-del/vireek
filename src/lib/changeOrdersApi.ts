import { supabase } from '@/lib/supabase';
import {
  UUID_RE,
  changeOrderError,
  parsePublicChangeOrder,
  type ApprovalMethod,
  type ChangeOrder,
  type ChangeOrderEvent,
  type PublicChangeOrder,
} from '@/lib/changeOrders';

// Change Orders data layer. Reads are scoped to the account owner (`user_id = ownerId`) on top of RLS.
// ALL writes go through SECURITY DEFINER RPCs (the table has no client write policies).

type Res<T> = { data: T | null; error: { message: string } | null };

function unwrap<T>(res: Res<T>, fallback: string): T {
  if (res.error) throw new Error(changeOrderError(res.error, fallback));
  return res.data as T;
}

const PAGE = 1000;
const MAX_ROWS = 10_000;

export async function fetchChangeOrders(ownerId: string): Promise<ChangeOrder[]> {
  const out: ChangeOrder[] = [];
  for (let from = 0; out.length < MAX_ROWS; from += PAGE) {
    const rows = unwrap(
      (await supabase
        .from('change_orders')
        .select('*')
        .eq('user_id', ownerId)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1)) as Res<ChangeOrder[]>,
      'Could not load change orders.',
    );
    out.push(...(rows ?? []));
    if (!rows || rows.length < PAGE) break;
  }
  return out;
}

export async function fetchChangeOrder(ownerId: string, id: string): Promise<ChangeOrder | null> {
  const row = unwrap(
    (await supabase.from('change_orders').select('*').eq('user_id', ownerId).eq('id', id).maybeSingle()) as Res<ChangeOrder | null>,
    'Could not load this change order.',
  );
  return row ?? null;
}

export async function fetchEvents(ownerId: string, id: string): Promise<ChangeOrderEvent[]> {
  const rows = unwrap(
    (await supabase
      .from('change_order_events')
      .select('id, change_order_id, event_type, actor_type, actor_name, detail, created_at')
      .eq('user_id', ownerId)
      .eq('change_order_id', id)
      .order('created_at', { ascending: true })) as Res<ChangeOrderEvent[]>,
    'Could not load the activity history.',
  );
  return rows ?? [];
}

// ------------------------------------------------------------------
// Parents (jobs / install projects)
// ------------------------------------------------------------------

export interface ParentOption {
  kind: 'job' | 'project';
  id: string;
  label: string;
  sublabel: string;
  customerName: string;
}

export interface ParentInfo {
  label: string;
  /** Contract / job value before change orders; null when unknown. */
  originalCents: number | null;
  href: string;
}

export async function fetchParentOptions(ownerId: string, search: string): Promise<ParentOption[]> {
  const q = search.trim().replace(/[%,()]/g, ' ').slice(0, 60);
  let jobsQ = supabase
    .from('jobs')
    .select('id, customer_name, service_type, address, scheduled_datetime')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(25);
  let projQ = supabase
    .from('install_projects')
    .select('id, project_number, name, customer_name, status')
    .eq('user_id', ownerId)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(25);
  if (q) {
    jobsQ = jobsQ.or(`customer_name.ilike.%${q}%,service_type.ilike.%${q}%,address.ilike.%${q}%`);
    projQ = projQ.or(`name.ilike.%${q}%,customer_name.ilike.%${q}%,project_number.ilike.%${q}%`);
  }
  const [jobs, projects] = await Promise.all([jobsQ, projQ]);
  const jobRows = unwrap(jobs as Res<Record<string, string | null>[]>, 'Could not load jobs.') ?? [];
  const projRows = unwrap(projects as Res<Record<string, string | null>[]>, 'Could not load projects.') ?? [];
  return [
    ...projRows.map((p): ParentOption => ({
      kind: 'project',
      id: String(p.id),
      label: `${p.project_number ? `${p.project_number} · ` : ''}${p.name ?? 'Project'}`,
      sublabel: `Install project · ${p.customer_name ?? ''}`,
      customerName: p.customer_name ?? '',
    })),
    ...jobRows.map((j): ParentOption => ({
      kind: 'job',
      id: String(j.id),
      label: `${j.customer_name ?? 'Job'}${j.service_type ? ` · ${j.service_type}` : ''}`,
      sublabel: `Job${j.address ? ` · ${j.address}` : ''}`,
      customerName: j.customer_name ?? '',
    })),
  ];
}

/** Labels + original values for the parents referenced by `cos` (keys: `job:<id>` / `project:<id>`). */
export async function fetchParentInfo(ownerId: string, cos: ChangeOrder[]): Promise<Record<string, ParentInfo>> {
  const jobIds = [...new Set(cos.map((c) => c.job_id).filter((x): x is string => !!x))];
  const projectIds = [...new Set(cos.map((c) => c.project_id).filter((x): x is string => !!x))];
  const out: Record<string, ParentInfo> = {};
  for (let i = 0; i < projectIds.length; i += 200) {
    const rows = unwrap(
      (await supabase
        .from('install_projects')
        .select('id, project_number, name, contract_value_cents')
        .eq('user_id', ownerId)
        .in('id', projectIds.slice(i, i + 200))) as Res<{ id: string; project_number: string | null; name: string; contract_value_cents: number | null }[]>,
      'Could not load projects.',
    );
    for (const p of rows ?? []) {
      out[`project:${p.id}`] = {
        label: `${p.project_number ? `${p.project_number} · ` : ''}${p.name}`,
        originalCents: p.contract_value_cents && p.contract_value_cents > 0 ? p.contract_value_cents : null,
        href: `/dashboard/projects/${p.id}`,
      };
    }
  }
  for (let i = 0; i < jobIds.length; i += 200) {
    const rows = unwrap(
      (await supabase
        .from('jobs')
        .select('id, customer_name, service_type, invoice_amount')
        .eq('user_id', ownerId)
        .in('id', jobIds.slice(i, i + 200))) as Res<{ id: string; customer_name: string; service_type: string | null; invoice_amount: number | null }[]>,
      'Could not load jobs.',
    );
    for (const j of rows ?? []) {
      out[`job:${j.id}`] = {
        label: `${j.customer_name}${j.service_type ? ` · ${j.service_type}` : ''}`,
        originalCents: j.invoice_amount && j.invoice_amount > 0 ? Math.round(Number(j.invoice_amount) * 100) : null,
        href: `/dashboard/jobs`,
      };
    }
  }
  return out;
}

export interface InvoiceLite {
  id: string;
  invoice_number: string | null;
  status: string;
  due_date: string | null;
}

export async function fetchInvoice(ownerId: string, id: string): Promise<InvoiceLite | null> {
  const row = unwrap(
    (await supabase.from('invoices').select('id, invoice_number, status, due_date').eq('user_id', ownerId).eq('id', id).maybeSingle()) as Res<InvoiceLite | null>,
    'Could not load the invoice.',
  );
  return row ?? null;
}

// ------------------------------------------------------------------
// Mutations (RPC)
// ------------------------------------------------------------------

async function rpc<T>(fn: string, args: Record<string, unknown>, fallback: string): Promise<T> {
  const res = (await supabase.rpc(fn, args)) as Res<T>;
  if (res.error) throw new Error(changeOrderError(res.error, fallback));
  return res.data as T;
}

export function createChangeOrder(parent: { jobId?: string; projectId?: string }, payload: Record<string, unknown>): Promise<string> {
  return rpc<string>(
    'save_change_order',
    { p_id: null, p_payload: { ...payload, job_id: parent.jobId ?? null, project_id: parent.projectId ?? null } },
    'Could not create the change order.',
  );
}

export function updateChangeOrder(id: string, payload: Record<string, unknown>): Promise<string> {
  return rpc<string>('save_change_order', { p_id: id, p_payload: payload }, 'Could not save the change order.');
}

export function sendChangeOrder(id: string, expiresInDays: number): Promise<string> {
  return rpc<string>('send_change_order', { p_id: id, p_expires_in_days: expiresInDays }, 'Could not send the change order.');
}

export async function cancelChangeOrder(id: string, reason: string): Promise<void> {
  await rpc<null>('cancel_change_order', { p_id: id, p_reason: reason || null }, 'Could not cancel the change order.');
}

export async function recordDecision(
  id: string,
  decision: 'approved' | 'declined',
  approverName: string,
  method: Exclude<ApprovalMethod, 'online'>,
  note: string,
): Promise<void> {
  await rpc<null>(
    'record_change_order_decision',
    { p_id: id, p_decision: decision, p_approver_name: approverName || null, p_method: method, p_note: note || null },
    'Could not record the decision.',
  );
}

export function invoiceChangeOrder(id: string, dueDate: string | null): Promise<string> {
  return rpc<string>('invoice_change_order', { p_id: id, p_due_date: dueDate || null }, 'Could not create the invoice.');
}

// ------------------------------------------------------------------
// Public (customer) — token gated, no sign-in
// ------------------------------------------------------------------

export async function fetchPublicChangeOrder(token: string): Promise<PublicChangeOrder | null> {
  if (!UUID_RE.test(token)) return null;
  try {
    const { data, error } = await supabase.rpc('get_change_order_for_token', { p_token: token });
    if (error) return null;
    return parsePublicChangeOrder(data);
  } catch {
    return null;
  }
}

export async function recordPublicView(token: string): Promise<void> {
  if (!UUID_RE.test(token)) return;
  try {
    await supabase.rpc('record_change_order_view', { p_token: token });
  } catch {
    /* a failed view ping must never block the customer */
  }
}

export async function respondPublic(token: string, decision: 'approved' | 'declined', name: string, note: string): Promise<void> {
  await rpc<unknown>(
    'respond_to_change_order_by_token',
    { p_token: token, p_decision: decision, p_name: name, p_note: note || null },
    'We couldn’t record your response. Please try again.',
  );
}
