import { supabase } from '@/lib/supabase';
import {
  allocateByWeight,
  friendlyPayAppError,
  type LineEntry,
  type PayApp,
  type PayAppLine,
  type SovLine,
} from '@/lib/payApps';
import type { ProjectPhase } from '@/lib/installProjects';

// Pay-application data layer. Every query is scoped to the account owner on top
// of RLS. SOV lines are written directly (trigger-guarded); pay applications
// are READ-ONLY here — all writes go through the SECURITY DEFINER RPCs so the
// totals are always computed by the database.

type Res<T> = { data: T | null; error: { message: string } | null };

function unwrap<T>(res: Res<T>, fallback: string): T {
  if (res.error) throw new Error(friendlyPayAppError(res.error, fallback));
  return res.data as T;
}

const PAGE = 1000;
const MAX_ROWS = 20_000;

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<Res<T[]>>, fallback: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; out.length < MAX_ROWS; from += PAGE) {
    const rows = unwrap(await build(from, from + PAGE - 1), fallback) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export interface PayAppsData {
  sov: SovLine[];
  apps: PayApp[];
  /** Lines of every application of the project, keyed by pay_app_id. */
  linesByApp: Record<string, PayAppLine[]>;
}

export async function fetchPayAppsData(ownerId: string, projectId: string): Promise<PayAppsData> {
  const [sov, apps, lines] = await Promise.all([
    fetchAll<SovLine>(
      (a, b) =>
        supabase.from('install_sov_lines').select('*').eq('user_id', ownerId).eq('project_id', projectId).order('sort_order').order('created_at').order('id').range(a, b) as unknown as PromiseLike<Res<SovLine[]>>,
      'Could not load the schedule of values.',
    ),
    fetchAll<PayApp>(
      (a, b) =>
        supabase.from('install_pay_apps').select('*').eq('user_id', ownerId).eq('project_id', projectId).order('application_no', { ascending: false }).range(a, b) as unknown as PromiseLike<Res<PayApp[]>>,
      'Could not load pay applications.',
    ),
    fetchAll<PayAppLine>(
      (a, b) =>
        supabase.from('install_pay_app_lines').select('*').eq('user_id', ownerId).eq('project_id', projectId).order('pay_app_id').order('sort_order').order('id').range(a, b) as unknown as PromiseLike<Res<PayAppLine[]>>,
      'Could not load pay application lines.',
    ),
  ]);
  const linesByApp: Record<string, PayAppLine[]> = {};
  for (const l of lines) (linesByApp[l.pay_app_id] ??= []).push(l);
  return { sov, apps, linesByApp };
}

/** Company name for the PDF header (null if the profile has none). */
export async function fetchContractorName(ownerId: string): Promise<string | null> {
  const { data } = await supabase.from('profiles').select('company_name').eq('id', ownerId).maybeSingle();
  const name = (data as { company_name: string | null } | null)?.company_name?.trim();
  return name || null;
}

// ------------------------------------------------------------------
// Schedule of values
// ------------------------------------------------------------------

export interface SovInput {
  itemNo: string;
  description: string;
  scheduledCents: number;
  changeOrderRef: string;
  sortOrder: number;
}

export async function addSovLine(ownerId: string, projectId: string, v: SovInput): Promise<void> {
  unwrap(
    (await supabase.from('install_sov_lines').insert({
      user_id: ownerId,
      project_id: projectId,
      item_no: v.itemNo.trim(),
      description: v.description.trim(),
      scheduled_value_cents: v.scheduledCents,
      change_order_ref: v.changeOrderRef.trim() || null,
      sort_order: v.sortOrder,
    })) as Res<null>,
    'Could not add the line.',
  );
}

export async function updateSovLine(
  ownerId: string,
  id: string,
  values: { description?: string; scheduled_value_cents?: number },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (values.description !== undefined) patch.description = values.description.trim();
  if (values.scheduled_value_cents !== undefined) patch.scheduled_value_cents = values.scheduled_value_cents;
  unwrap((await supabase.from('install_sov_lines').update(patch).eq('id', id).eq('user_id', ownerId)) as Res<null>, 'Could not update the line.');
}

export async function deleteSovLine(ownerId: string, id: string): Promise<void> {
  unwrap((await supabase.from('install_sov_lines').delete().eq('id', id).eq('user_id', ownerId)) as Res<null>, 'Could not delete the line.');
}

/**
 * One SOV line per phase, contract value split by phase weight to the exact
 * cent. Only meant for an empty schedule of values.
 */
export async function seedSovFromPhases(ownerId: string, projectId: string, phases: ProjectPhase[], contractCents: number): Promise<void> {
  const ordered = [...phases].sort((a, b) => a.sort_order - b.sort_order);
  if (ordered.length === 0 || contractCents <= 0) return;
  const shares = allocateByWeight(contractCents, ordered.map((p) => p.weight));
  const rows = ordered.map((p, i) => ({
    user_id: ownerId,
    project_id: projectId,
    item_no: String(i + 1),
    description: p.name.slice(0, 200),
    scheduled_value_cents: shares[i],
    sort_order: i,
  }));
  unwrap((await supabase.from('install_sov_lines').insert(rows)) as Res<null>, 'Could not generate the schedule of values.');
}

// ------------------------------------------------------------------
// Pay applications (RPC only)
// ------------------------------------------------------------------

export interface SavePayAppInput {
  projectId: string;
  periodTo: string;
  applicationDate: string;
  notes: string;
  retainageReleaseCents: number;
  entries: Record<string, LineEntry>;
}

export async function savePayApp(v: SavePayAppInput): Promise<string> {
  const { data, error } = await supabase.rpc('save_install_pay_app', {
    p_project_id: v.projectId,
    p_period_to: v.periodTo,
    p_application_date: v.applicationDate,
    p_notes: v.notes,
    p_retainage_release_cents: v.retainageReleaseCents,
    p_lines: Object.entries(v.entries).map(([sov_line_id, e]) => ({
      sov_line_id,
      this_period_cents: e.thisPeriodCents,
      stored_cents: e.storedCents,
    })),
  });
  if (error) throw new Error(friendlyPayAppError(error, 'Could not save the pay application.'));
  return data as string;
}

export type PayAppAction = 'issue' | 'paid' | 'unpaid' | 'void' | 'discard';

export async function transitionPayApp(payAppId: string, action: PayAppAction): Promise<void> {
  const { error } = await supabase.rpc('transition_install_pay_app', { p_pay_app_id: payAppId, p_action: action });
  if (error) throw new Error(friendlyPayAppError(error, 'Could not update the pay application.'));
}

export async function createPayAppInvoice(payAppId: string, dueDate: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_install_pay_app_invoice', { p_pay_app_id: payAppId, p_due_date: dueDate || null });
  if (error) throw new Error(friendlyPayAppError(error, 'Could not create the invoice.'));
  return data as string;
}
