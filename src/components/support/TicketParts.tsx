import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Image as ImageIcon, Loader2, Paperclip, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { getAttachmentUrl } from '@/lib/supportTicketsApi';
import {
  addAttachments, formatBytes, MAX_ATTACHMENTS, slaState, STATE_LABELS, ticketState,
  type SlaTone, type Ticket, type TicketAttachment, type TicketState,
} from '@/lib/supportTickets';

/** Re-renders every `intervalMs` so countdowns stay live without refetching. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

const TONE_CLASS: Record<SlaTone, string> = {
  ok: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/10 text-warning-500',
  breached: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-tertiary text-text-secondary',
};

/** Live SLA chip — also used by the staff inbox. */
export function SlaBadge({ ticket }: { ticket: Parameters<typeof slaState>[0] }) {
  const now = useNow();
  const sla = slaState(ticket, now);
  if (sla.phase === 'none' || !sla.label) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE_CLASS[sla.tone]}`}
      title="Service-level target for this ticket"
    >
      {sla.label}
    </span>
  );
}

const STATE_CLASS: Record<TicketState, string> = {
  open: 'bg-accent/10 text-accent',
  in_progress: 'bg-accent/10 text-accent',
  waiting_on_you: 'bg-warning-500/10 text-warning-500',
  resolved: 'bg-bg-tertiary text-text-secondary',
};

export function StateBadge({ ticket }: { ticket: Pick<Ticket, 'status' | 'awaiting_customer'> }) {
  const state = ticketState(ticket);
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATE_CLASS[state]}`}>
      {STATE_LABELS[state]}
    </span>
  );
}

/** File chooser with validation and removable chips. Controlled by the parent. */
export function AttachmentPicker({
  files, onChange, disabled,
}: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean }) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePick = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const { accepted, rejected } = addAttachments(files, Array.from(list));
    onChange(accepted);
    if (rejected.length > 0) {
      toast(`${rejected[0].name}: ${rejected[0].reason}${rejected.length > 1 ? ` (+${rejected.length - 1} more skipped)` : ''}`, 'error');
    }
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept="image/*,.pdf,.txt,.csv,.mp4,.heic"
        onChange={(e) => handlePick(e.target.files)}
        aria-label="Attach files"
      />
      <button
        type="button"
        disabled={disabled || files.length >= MAX_ATTACHMENTS}
        onClick={() => inputRef.current?.click()}
        className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
      >
        <Paperclip size={14} aria-hidden="true" /> Attach files
        <span className="text-text-secondary/60">{files.length}/{MAX_ATTACHMENTS}</span>
      </button>
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {files.map((f) => (
            <li key={`${f.name}-${f.size}`} className="flex max-w-full items-center gap-1.5 rounded-lg bg-bg-tertiary px-2.5 py-1.5 text-xs text-text-primary">
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 text-text-secondary/70">{formatBytes(f.size)}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(files.filter((x) => x !== f))}
                aria-label={`Remove ${f.name}`}
                className="focus-ring shrink-0 rounded p-0.5 text-text-secondary hover:text-text-primary"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Attachments of one message; opens through a short-lived signed URL. Also used by the staff inbox. */
export function MessageAttachments({ items, onDark }: { items: TicketAttachment[]; onDark?: boolean }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (items.length === 0) return null;

  const open = async (a: TicketAttachment) => {
    setBusy(a.id);
    try {
      const url = await getAttachmentUrl(a.storage_path, a.file_name);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      toast('Could not open that file. Please try again.', 'error');
    }
    setBusy(null);
  };

  return (
    <ul className="mt-2 space-y-1.5">
      {items.map((a) => {
        const Icon = a.mime_type.startsWith('image/') ? ImageIcon : FileText;
        return (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => void open(a)}
              disabled={busy === a.id}
              className={`focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ${
                onDark ? 'bg-white/15 text-white hover:bg-white/25' : 'bg-bg-secondary text-text-primary hover:bg-bg-primary'
              }`}
            >
              {busy === a.id ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate">{a.file_name}</span>
              <span className="shrink-0 opacity-70">{formatBytes(a.size_bytes)}</span>
              <Download size={13} className="shrink-0 opacity-70" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
