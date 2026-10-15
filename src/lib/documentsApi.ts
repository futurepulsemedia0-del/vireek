import { supabase } from '@/lib/supabase';
import {
  DOCUMENTS_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  buildStoragePath,
  resolveMimeType,
  validateDocumentFile,
  type DocumentInput,
  type DocumentRecord,
  type DocumentVersion,
} from '@/lib/documents';

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  // RFC4122 v4 fallback (very old browsers / non-secure contexts)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const DOCUMENT_SELECT = '*, customer:customers(id, name)';
const LIST_LIMIT = 500;

/** Always scoped to the ACCOUNT OWNER's id (RLS enforces it too; this keeps the intent explicit). */
export async function fetchDocuments(
  ownerId: string,
  customerId?: string,
): Promise<DocumentRecord[]> {
  let query = supabase
    .from('documents')
    .select(DOCUMENT_SELECT)
    .eq('user_id', ownerId)
    .order('expires_on', { ascending: true, nullsFirst: false })
    .limit(LIST_LIMIT);
  if (customerId) query = query.eq('customer_id', customerId);
  const { data, error } = await query;
  if (error) throw error;
  return (data as unknown as DocumentRecord[]) ?? [];
}

export async function fetchVersions(documentId: string): Promise<DocumentVersion[]> {
  const { data, error } = await supabase
    .from('document_versions')
    .select('*')
    .eq('document_id', documentId)
    .order('version_number', { ascending: false });
  if (error) throw error;
  return (data as DocumentVersion[]) ?? [];
}

function toPayload(input: DocumentInput) {
  return {
    title: input.title.trim(),
    category: input.category,
    reference_number: input.reference_number.trim() || null,
    issuer: input.issuer.trim() || null,
    issued_on: input.issued_on || null,
    expires_on: input.expires_on || null,
    alert_days: input.alert_days,
    notes: input.notes.trim() || null,
    customer_id: input.customer_id,
  };
}

export async function createDocument(
  ownerId: string,
  input: DocumentInput,
): Promise<DocumentRecord> {
  const { data, error } = await supabase
    .from('documents')
    .insert({ ...toPayload(input), user_id: ownerId })
    .select(DOCUMENT_SELECT)
    .single();
  if (error) throw error;
  return data as unknown as DocumentRecord;
}

export async function updateDocument(id: string, input: DocumentInput): Promise<void> {
  const { error } = await supabase.from('documents').update(toPayload(input)).eq('id', id);
  if (error) throw error;
}

export async function setDocumentExpiry(id: string, expiresOn: string | null): Promise<void> {
  const { error } = await supabase.from('documents').update({ expires_on: expiresOn }).eq('id', id);
  if (error) throw error;
}

/**
 * Uploads a file as the next immutable version of a document.
 * Rolls the storage object back if the version row can't be written, so a
 * failed upload never leaves an orphaned file behind.
 */
export async function uploadDocumentVersion(args: {
  ownerId: string;
  documentId: string;
  file: File;
  note?: string;
}): Promise<DocumentVersion> {
  const invalid = validateDocumentFile(args.file);
  if (invalid) throw new Error(invalid);

  const mime = resolveMimeType(args.file) as string;
  const versionId = newId();
  const path = buildStoragePath(args.ownerId, args.documentId, versionId, args.file.name);

  const { error: uploadError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(path, args.file, { contentType: mime, upsert: false, cacheControl: '3600' });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from('document_versions')
    .insert({
      id: versionId,
      document_id: args.documentId,
      storage_path: path,
      file_name: args.file.name.slice(0, 255),
      mime_type: mime,
      size_bytes: args.file.size,
      note: args.note?.trim() || null,
    })
    .select('*')
    .single();

  if (error) {
    await supabase.storage.from(DOCUMENTS_BUCKET).remove([path]);
    throw error;
  }
  return data as DocumentVersion;
}

/** Deletes the document row (versions cascade) and then its stored files. */
export async function deleteDocument(documentId: string): Promise<void> {
  const versions = await fetchVersions(documentId);
  const { error } = await supabase.from('documents').delete().eq('id', documentId);
  if (error) throw error;
  const paths = versions.map((v) => v.storage_path);
  if (paths.length > 0) {
    // Best-effort: the DB row is already gone; a failed cleanup must not surface as a failed delete.
    await supabase.storage.from(DOCUMENTS_BUCKET).remove(paths);
  }
}

/** Fires (idempotently) any due expiry notifications for the caller's account. */
export async function checkMyDocumentExpiries(): Promise<void> {
  await supabase.rpc('check_my_document_expiries');
}

/**
 * Mints a short-lived signed URL on demand (never stored or cached).
 * `download: true` forces a save dialog using the original file name.
 */
export async function getSignedUrl(
  version: Pick<DocumentVersion, 'storage_path' | 'file_name'>,
  mode: 'view' | 'download',
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(
      version.storage_path,
      SIGNED_URL_TTL_SECONDS,
      mode === 'download' ? { download: version.file_name } : undefined,
    );
  if (error || !data?.signedUrl) throw error ?? new Error('Could not create a secure link.');
  return data.signedUrl;
}

/** Opens a version without tripping popup blockers (tab is opened synchronously). */
export async function openVersion(
  version: Pick<DocumentVersion, 'storage_path' | 'file_name'>,
  mode: 'view' | 'download',
): Promise<void> {
  if (mode === 'download') {
    const url = await getSignedUrl(version, 'download');
    window.location.assign(url);
    return;
  }
  const tab = window.open('', '_blank');
  try {
    const url = await getSignedUrl(version, 'view');
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.location.assign(url);
    }
  } catch (err) {
    tab?.close();
    throw err;
  }
}
