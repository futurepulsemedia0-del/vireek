import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, FileText, Loader2, Paperclip, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyStateInline } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { deleteAttachment, fetchAttachments, signedUrls, uploadAttachment } from '@/lib/projectAttachmentsApi';
import {
  FILE_INPUT_ACCEPT,
  MAX_ATTACHMENTS_PER_PARENT,
  PURPOSE_LABEL,
  canPreviewInline,
  formatBytes,
  validateAttachmentFile,
  type AttachmentParent,
  type AttachmentPurpose,
  type ProjectAttachment,
} from '@/lib/projectAttachments';
import { Pill, selectClass, useConfirm } from './projectUi';

export interface AttachmentsPanelProps {
  ownerId: string;
  projectId: string;
  parent: AttachmentParent;
  /** Purposes the person may upload as; the first one is the default. */
  purposes: AttachmentPurpose[];
  canUpload: boolean;
  canDelete: (attachment: ProjectAttachment) => boolean;
  title?: string;
  hint?: string;
  /** Called after every (re)load so the parent can enforce rules such as "needs an After photo". */
  onLoaded?: (items: ProjectAttachment[]) => void;
}

/**
 * The ONE attachments component for Submittals and Punch Lists:
 * list, preview, upload (multi-file, camera on phones) and delete.
 * Locking rules are enforced by the database; this component only mirrors them.
 */
export function AttachmentsPanel({ ownerId, projectId, parent, purposes, canUpload, canDelete, title = 'Files', hint, onLoaded }: AttachmentsPanelProps) {
  const { toast } = useToast();
  const { ask, dialog } = useConfirm();
  const [items, setItems] = useState<ProjectAttachment[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  const [purpose, setPurpose] = useState<AttachmentPurpose>(purposes[0]);
  const [uploading, setUploading] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const parentKey = useMemo<AttachmentParent>(() => ({ kind: parent.kind, id: parent.id }) as AttachmentParent, [parent.kind, parent.id]);

  const load = useCallback(async () => {
    try {
      const rows = await fetchAttachments(ownerId, parentKey);
      setItems(rows);
      setFailed(false);
      onLoadedRef.current?.(rows);
      setUrls(await signedUrls(rows.map((a) => a.storage_path)).catch(() => ({})));
    } catch (e) {
      setFailed(true);
      toast(e instanceof Error ? e.message : 'Could not load attachments.', 'error');
    }
  }, [ownerId, parentKey, toast]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!purposes.includes(purpose)) setPurpose(purposes[0]);
  }, [purposes, purpose]);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    let count = items?.length ?? 0;
    let added = 0;
    setUploading((n) => n + list.length);
    for (const file of list) {
      const check = validateAttachmentFile(file, count);
      if (!check.ok) {
        toast(check.error, 'error');
        setUploading((n) => n - 1);
        continue;
      }
      try {
        await uploadAttachment({ ownerId, projectId, parent: parentKey, purpose, file, mime: check.mime });
        count += 1;
        added += 1;
      } catch (e) {
        toast(e instanceof Error ? e.message : `Could not upload “${file.name}”.`, 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (fileRef.current) fileRef.current.value = '';
    if (cameraRef.current) cameraRef.current.value = '';
    if (added > 0) {
      toast(added === 1 ? 'File added.' : `${added} files added.`, 'success');
      await load();
    }
  };

  const remove = (a: ProjectAttachment) =>
    ask({
      title: 'Remove this file?',
      description: `“${a.file_name}” will be removed.`,
      label: 'Remove file',
      onConfirm: async () => {
        setRemoving(a.id);
        try {
          await deleteAttachment(ownerId, a);
          toast('File removed.', 'success');
          await load();
        } catch (e) {
          toast(e instanceof Error ? e.message : 'Could not remove the file.', 'error');
        } finally {
          setRemoving(null);
        }
      },
    });

  const photoPurpose = purpose === 'before' || purpose === 'after' || purpose === 'general';
  const atLimit = (items?.length ?? 0) >= MAX_ATTACHMENTS_PER_PARENT;

  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
          <Paperclip size={14} aria-hidden="true" /> {title}
          {items && <span className="text-xs font-normal text-text-secondary">({items.length})</span>}
        </h4>
        {canUpload && (
          <div className="flex flex-wrap items-center gap-2">
            {purposes.length > 1 && (
              <select aria-label="File category" className={`${selectClass} !w-auto !py-1.5`} value={purpose} onChange={(e) => setPurpose(e.target.value as AttachmentPurpose)}>
                {purposes.map((p) => <option key={p} value={p}>{PURPOSE_LABEL[p]}</option>)}
              </select>
            )}
            <input ref={fileRef} type="file" multiple accept={FILE_INPUT_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void upload(e.target.files)} />
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void upload(e.target.files)} />
            {photoPurpose && (
              <Button type="button" size="sm" variant="secondary" disabled={uploading > 0 || atLimit} onClick={() => cameraRef.current?.click()}>
                <Camera size={14} aria-hidden="true" /> Take photo
              </Button>
            )}
            <Button type="button" size="sm" variant="secondary" disabled={uploading > 0 || atLimit} onClick={() => fileRef.current?.click()}>
              {uploading > 0 ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
              {uploading > 0 ? `Uploading ${uploading}…` : 'Add files'}
            </Button>
          </div>
        )}
      </div>

      {hint && <p className="text-xs text-text-secondary">{hint}</p>}

      {failed ? (
        <p role="alert" className="text-sm text-danger-500">
          Could not load files. <button type="button" className="focus-ring rounded underline" onClick={() => void load()}>Try again</button>
        </p>
      ) : items === null ? (
        <p className="text-sm text-text-secondary" aria-busy="true">Loading files…</p>
      ) : items.length === 0 ? (
        <EmptyStateInline text="Nothing attached here yet." />
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((a) => {
            const url = urls[a.storage_path];
            return (
              <li key={a.id} className="overflow-hidden rounded-xl border border-border bg-bg-primary">
                <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${a.file_name}`} aria-disabled={!url} className="focus-ring block aspect-[4/3] bg-bg-tertiary">
                  {url && canPreviewInline(a.mime_type) ? (
                    <img src={url} alt={a.caption || a.file_name} loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-text-secondary"><FileText size={28} aria-hidden="true" /></span>
                  )}
                </a>
                <div className="space-y-1 p-2">
                  <p className="truncate text-xs font-medium text-text-primary" title={a.file_name}>{a.file_name}</p>
                  <div className="flex items-center justify-between gap-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Pill>{PURPOSE_LABEL[a.purpose]}</Pill>
                      <span className="truncate text-xs text-text-secondary">{formatBytes(a.size_bytes)}</span>
                    </span>
                    {canDelete(a) && (
                      <button type="button" aria-label={`Remove ${a.file_name}`} disabled={removing === a.id} onClick={() => remove(a)} className="focus-ring rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500 disabled:opacity-50">
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {dialog}
    </section>
  );
}
