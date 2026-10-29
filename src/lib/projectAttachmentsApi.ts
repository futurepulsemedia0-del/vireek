import { supabase } from '@/lib/supabase';
import { friendlyItemError, unwrap, type Res } from '@/lib/projectItemsCore';
import {
  ATTACHMENT_BUCKET,
  buildStoragePath,
  type AttachmentParent,
  type AttachmentPurpose,
  type ProjectAttachment,
} from '@/lib/projectAttachments';

// Shared attachments data layer (Submittals + Punch Lists). Rows are written
// by the client only after the file is in storage; if the row insert is
// refused (locked revision, closed item, limit) the uploaded object is removed.

const parentColumn = (p: AttachmentParent) => (p.kind === 'submittal_revision' ? 'submittal_revision_id' : 'punch_item_id');

export async function fetchAttachments(ownerId: string, parent: AttachmentParent): Promise<ProjectAttachment[]> {
  const res = (await supabase
    .from('install_project_attachments')
    .select('*')
    .eq('user_id', ownerId)
    .eq(parentColumn(parent), parent.id)
    .order('created_at')
    .limit(100)) as Res<ProjectAttachment[]>;
  return unwrap(res, 'Could not load attachments.') ?? [];
}

/** Attachment counts per parent id (one query for a whole list). */
export async function fetchAttachmentCounts(ownerId: string, projectId: string, column: 'submittal_revision_id' | 'punch_item_id'): Promise<Record<string, number>> {
  const res = (await supabase
    .from('install_project_attachments')
    .select(column)
    .eq('user_id', ownerId)
    .eq('project_id', projectId)
    .not(column, 'is', null)
    .limit(5000)) as unknown as Res<Record<string, string>[]>;
  const out: Record<string, number> = {};
  for (const row of unwrap(res, 'Could not load attachments.') ?? []) out[row[column]] = (out[row[column]] ?? 0) + 1;
  return out;
}

export async function signedUrls(paths: string[], expiresInSeconds = 3600): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUrls(paths, expiresInSeconds);
  if (error) throw new Error(friendlyItemError(error, 'Could not open the files.'));
  const out: Record<string, string> = {};
  for (const row of data ?? []) if (row.path && row.signedUrl) out[row.path] = row.signedUrl;
  return out;
}

export interface UploadInput {
  ownerId: string;
  projectId: string;
  parent: AttachmentParent;
  purpose: AttachmentPurpose;
  file: File;
  mime: string;
  caption?: string;
}

export async function uploadAttachment(input: UploadInput): Promise<ProjectAttachment> {
  const { ownerId, projectId, parent, purpose, file, mime } = input;
  const path = buildStoragePath(ownerId, projectId, file.name, crypto.randomUUID());
  const up = await supabase.storage.from(ATTACHMENT_BUCKET).upload(path, file, { contentType: mime, upsert: false, cacheControl: '3600' });
  if (up.error) throw new Error(friendlyItemError(up.error, `Could not upload “${file.name}”.`));

  const res = (await supabase
    .from('install_project_attachments')
    .insert({
      user_id: ownerId,
      project_id: projectId,
      [parentColumn(parent)]: parent.id,
      purpose,
      storage_path: path,
      file_name: file.name.slice(0, 200),
      mime_type: mime,
      size_bytes: file.size,
      caption: input.caption?.trim() || null,
    })
    .select('*')
    .single()) as Res<ProjectAttachment>;

  if (res.error) {
    await supabase.storage.from(ATTACHMENT_BUCKET).remove([path]); // orphan cleanup (allowed: no row points at it)
    throw new Error(friendlyItemError(res.error, `Could not attach “${file.name}”.`));
  }
  return res.data as ProjectAttachment;
}

export async function deleteAttachment(ownerId: string, attachment: ProjectAttachment): Promise<void> {
  const res = (await supabase.from('install_project_attachments').delete().eq('id', attachment.id).eq('user_id', ownerId).select('id')) as Res<{ id: string }[]>;
  const rows = unwrap(res, 'Could not remove the file.') ?? [];
  // RLS hides rows that may not be deleted; zero rows means the file is locked.
  if (rows.length === 0) throw new Error('This file is locked and can no longer be removed.');
  await supabase.storage.from(ATTACHMENT_BUCKET).remove([attachment.storage_path]);
}
