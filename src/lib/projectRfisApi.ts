import { supabase } from '@/lib/supabase';
import {
  RFI_ATTACHMENT_BUCKET,
  buildAttachmentPath,
  inferAttachmentMime,
  parseScheduleDays,
  parseSignedDollars,
  rfiError,
  validateAttachmentFile,
  type ChangeOrder,
  type ChangeOrderFormValues,
  type ChangeOrderStatus,
  type ProjectRfi,
  type RfiAttachment,
  type RfiAttachmentKind,
  type RfiFormValues,
  type RfiStatus,
} from '@/lib/projectRfis';

// Project RFIs data layer. Every query is scoped to the account owner
// (`user_id = accountOwnerId`) on top of the RLS policies, exactly like
// installProjectsApi.ts, so a team member and the owner see the same account.

type Res<T> = { data: T | null; error: { message: string } | null };

function unwrap<T>(res: Res<T>, fallback: string): T {
  if (res.error) throw new Error(rfiError(res.error, fallback));
  return res.data as T;
}

export interface ProjectRfiData {
  rfis: ProjectRfi[];
  rfiAttachments: RfiAttachment[];
  changeOrders: ChangeOrder[];
}

export async function fetchProjectRfiData(ownerId: string, projectId: string): Promise<ProjectRfiData> {
  const scoped = (table: string) => supabase.from(table).select('*').eq('user_id', ownerId).eq('project_id', projectId);
  const [rfis, files, cos] = await Promise.all([
    scoped('install_project_rfis').order('created_at', { ascending: false }),
    scoped('install_project_rfi_attachments').order('created_at'),
    scoped('install_project_change_orders').order('created_at'),
  ]);
  return {
    rfis: unwrap(rfis as Res<ProjectRfi[]>, 'Could not load RFIs.') ?? [],
    rfiAttachments: unwrap(files as Res<RfiAttachment[]>, 'Could not load RFI files.') ?? [],
    changeOrders: unwrap(cos as Res<ChangeOrder[]>, 'Could not load change orders.') ?? [],
  };
}

// ------------------------------------------------------------------
// RFIs
// ------------------------------------------------------------------

function contentColumns(v: RfiFormValues) {
  return {
    subject: v.subject.trim(),
    question: v.question.trim(),
    direction: v.direction,
    party_name: v.partyName.trim(),
    party_role: v.partyRole,
    priority: v.priority,
    due_date: v.dueDate || null,
    phase_id: v.phaseId || null,
    impacts_cost: v.impactsCost,
    impacts_schedule: v.impactsSchedule,
  };
}

/** Creates the RFI as a draft, or already open ("sent"). Returns its id. */
export async function createRfi(ownerId: string, projectId: string, v: RfiFormValues, status: 'draft' | 'open'): Promise<string> {
  const row = unwrap(
    (await supabase
      .from('install_project_rfis')
      .insert({ user_id: ownerId, project_id: projectId, status, ...contentColumns(v) })
      .select('id')
      .single()) as Res<{ id: string }>,
    'Could not create the RFI.',
  );
  return row.id;
}

async function patch(table: string, ownerId: string, id: string, values: Record<string, unknown>, fallback: string): Promise<void> {
  unwrap((await supabase.from(table).update(values).eq('id', id).eq('user_id', ownerId)) as Res<null>, fallback);
}

export const updateRfi = (ownerId: string, id: string, v: RfiFormValues) => patch('install_project_rfis', ownerId, id, contentColumns(v), 'Could not update the RFI.');
export const setRfiStatus = (ownerId: string, id: string, status: RfiStatus) => patch('install_project_rfis', ownerId, id, { status }, 'Could not update the RFI.');
/** One atomic update: stores the answer and moves the RFI to "answered". */
export const answerRfi = (ownerId: string, id: string, answer: string) =>
  patch('install_project_rfis', ownerId, id, { answer: answer.trim(), status: 'answered' }, 'Could not record the answer.');
export const linkRfiChangeOrder = (ownerId: string, id: string, changeOrderId: string | null) =>
  patch('install_project_rfis', ownerId, id, { change_order_id: changeOrderId }, 'Could not update the change order link.');

async function removeFiles(paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 100) {
    // Best effort: the database rows are already gone, an orphaned object is invisible and harmless.
    await supabase.storage.from(RFI_ATTACHMENT_BUCKET).remove(paths.slice(i, i + 100)).catch(() => undefined);
  }
}

/** Deletes a draft/void RFI (RLS refuses anything else), then its files. */
export async function deleteRfi(ownerId: string, rfi: ProjectRfi, attachments: RfiAttachment[]): Promise<void> {
  unwrap((await supabase.from('install_project_rfis').delete().eq('id', rfi.id).eq('user_id', ownerId)) as Res<null>, 'Could not delete the RFI.');
  await removeFiles(attachments.filter((a) => a.rfi_id === rfi.id).map((a) => a.storage_path));
}

/**
 * Used when a whole project is deleted: returns a cleanup to run AFTER the project
 * row is gone, so a failed delete never leaves rows pointing at removed files.
 */
export async function collectProjectRfiFiles(ownerId: string, projectId: string): Promise<() => Promise<void>> {
  const { data } = (await supabase.from('install_project_rfi_attachments').select('storage_path').eq('user_id', ownerId).eq('project_id', projectId)) as Res<{ storage_path: string }[]>;
  const paths = (data ?? []).map((r) => r.storage_path);
  return () => removeFiles(paths);
}

/** Creates any missing overdue notifications for this account. Never throws. */
export async function refreshOverdueRfis(): Promise<void> {
  try {
    await supabase.rpc('rfi_refresh_overdue');
  } catch {
    /* the hourly job covers it; the overdue badges are computed locally */
  }
}

// ------------------------------------------------------------------
// Attachments
// ------------------------------------------------------------------

export async function uploadRfiAttachment(ownerId: string, rfi: ProjectRfi, file: File, kind: RfiAttachmentKind, existingCount: number): Promise<void> {
  const problem = validateAttachmentFile(file, existingCount);
  if (problem) throw new Error(problem);
  const mime = inferAttachmentMime(file.name, file.type);
  const path = buildAttachmentPath(ownerId, rfi.project_id, rfi.id, file.name, crypto.randomUUID());
  const up = await supabase.storage.from(RFI_ATTACHMENT_BUCKET).upload(path, file, { upsert: false, contentType: mime ?? undefined });
  if (up.error) throw new Error(rfiError(up.error, `Could not upload ${file.name}.`));
  const res = (await supabase.from('install_project_rfi_attachments').insert({
    user_id: ownerId,
    project_id: rfi.project_id,
    rfi_id: rfi.id,
    kind,
    file_name: file.name.slice(0, 200),
    storage_path: path,
    mime_type: mime,
    size_bytes: file.size,
  })) as Res<null>;
  if (res.error) {
    await removeFiles([path]); // never leave a file without a row
    throw new Error(rfiError(res.error, `Could not attach ${file.name}.`));
  }
}

export async function deleteRfiAttachment(ownerId: string, attachment: RfiAttachment): Promise<void> {
  unwrap((await supabase.from('install_project_rfi_attachments').delete().eq('id', attachment.id).eq('user_id', ownerId)) as Res<null>, 'Could not remove the file.');
  await removeFiles([attachment.storage_path]);
}

/** Short-lived download link; the bucket is private. */
export async function getRfiAttachmentUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(RFI_ATTACHMENT_BUCKET).createSignedUrl(path, 120);
  if (error || !data?.signedUrl) throw new Error('Could not open that file. Please try again.');
  return data.signedUrl;
}

// ------------------------------------------------------------------
// Change orders
// ------------------------------------------------------------------

/** Returns the new change order id so an RFI can be linked to it right away. */
export async function createChangeOrder(ownerId: string, projectId: string, v: ChangeOrderFormValues, status: 'draft' | 'pending' = 'draft'): Promise<string> {
  const amount = parseSignedDollars(v.amount);
  const days = parseScheduleDays(v.scheduleDays);
  if (amount === null || days === null) throw new Error('Check the change order amount and days.');
  const row = unwrap(
    (await supabase
      .from('install_project_change_orders')
      .insert({ user_id: ownerId, project_id: projectId, title: v.title.trim(), description: v.description.trim() || null, amount_cents: amount, schedule_days: days, status })
      .select('id')
      .single()) as Res<{ id: string }>,
    'Could not create the change order.',
  );
  return row.id;
}

export const setChangeOrderStatus = (ownerId: string, id: string, status: ChangeOrderStatus) =>
  patch('install_project_change_orders', ownerId, id, { status }, 'Could not update the change order.');

export async function deleteChangeOrder(ownerId: string, id: string): Promise<void> {
  unwrap((await supabase.from('install_project_change_orders').delete().eq('id', id).eq('user_id', ownerId)) as Res<null>, 'Could not delete the change order.');
}
