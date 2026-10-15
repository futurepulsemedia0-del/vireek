import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Loader2, RotateCcw, Send } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { Textarea } from '@/components/ui/Input';
import { useRealtimeSubscription } from '@/lib/realtime';
import { formatMessageTime, type SupportMessage } from '@/lib/supportChat';
import {
  fetchAttachments, fetchMessages, sendMessage, setTicketClosed,
} from '@/lib/supportTicketsApi';
import { AttachmentPicker, MessageAttachments, SlaBadge, StateBadge } from '@/components/support/TicketParts';
import { BODY_MAX, ticketRef, type Ticket, type TicketAttachment } from '@/lib/supportTickets';
import { AlertCircle } from 'lucide-react';

export function TicketThread({
  ticket, ownerId, userId, onBack, onChanged,
}: { ticket: Ticket; ownerId: string; userId: string; onBack: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [attachments, setAttachments] = useState<TicketAttachment[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [toggling, setToggling] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const closed = ticket.status === 'closed';

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const [m, a] = await Promise.all([fetchMessages(ticket.id), fetchAttachments(ticket.id)]);
      setMessages(m);
      setAttachments(a);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [ticket.id]);

  useEffect(() => {
    setDraft('');
    setFiles([]);
    void load();
  }, [load]);

  const refreshAttachments = useCallback(() => {
    fetchAttachments(ticket.id).then(setAttachments).catch(() => undefined);
  }, [ticket.id]);

  useRealtimeSubscription<SupportMessage>({
    channelName: `ticket-messages-${ticket.id}`,
    table: 'support_messages',
    event: 'INSERT',
    filter: `conversation_id=eq.${ticket.id}`,
    onChange: (payload) => {
      const row = payload.new as SupportMessage;
      setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
      // Attachment rows are written just after their message.
      window.setTimeout(refreshAttachments, 1500);
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, status]);

  const byMessage = useMemo(() => {
    const map = new Map<string, TicketAttachment[]>();
    for (const a of attachments) map.set(a.message_id, [...(map.get(a.message_id) ?? []), a]);
    return map;
  }, [attachments]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const { message, failedUploads } = await sendMessage(ownerId, userId, ticket.id, text, files);
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      setDraft('');
      setFiles([]);
      refreshAttachments();
      if (failedUploads.length > 0) toast(`Sent, but ${failedUploads.join(', ')} didn’t upload.`, 'error');
      onChanged();
    } catch {
      toast('Could not send your message. Please try again.', 'error');
    }
    setSending(false);
  };

  const toggleClosed = async () => {
    setToggling(true);
    try {
      await setTicketClosed(ticket.id, !closed);
      toast(closed ? 'Ticket reopened.' : 'Ticket marked as resolved.', 'success');
      onChanged();
    } catch {
      toast('Could not update the ticket. Please try again.', 'error');
    }
    setToggling(false);
  };

  return (
    <section aria-label={`Ticket ${ticketRef(ticket.ticket_number)}`} className="flex min-h-[28rem] flex-col rounded-2xl border border-border bg-bg-secondary">
      <header className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="focus-ring mb-2 inline-flex items-center gap-1 rounded text-xs font-medium text-text-secondary hover:text-text-primary lg:hidden"
          >
            <ArrowLeft size={14} aria-hidden="true" /> All tickets
          </button>
          <p className="text-xs font-medium text-text-secondary">{ticketRef(ticket.ticket_number)}</p>
          <h2 className="mt-0.5 break-words text-base font-semibold text-text-primary">{ticket.subject}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StateBadge ticket={ticket} />
            <SlaBadge ticket={ticket} />
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void toggleClosed()} disabled={toggling} className="shrink-0">
          {toggling ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : closed ? <RotateCcw size={14} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}
          {closed ? 'Reopen' : 'Mark resolved'}
        </Button>
      </header>

      <div ref={scrollRef} className="max-h-[28rem] flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {status === 'loading' && (
          <div aria-busy="true" className="space-y-3">
            <Skeleton className="h-16 w-3/4 rounded-2xl" />
            <Skeleton className="ml-auto h-12 w-2/3 rounded-2xl" />
          </div>
        )}
        {status === 'error' && (
          <EmptyState icon={AlertCircle} title="Couldn’t load this conversation"
            description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void load() }} />
        )}
        {status === 'ready' && messages.length === 0 && (
          <EmptyState icon={Send} title="No messages yet" description="Your message will appear here." />
        )}
        {status === 'ready' && messages.map((m) => {
          const staff = m.sender_type === 'staff';
          const mine = m.sender_id === userId;
          const who = staff ? 'Vireek Support' : mine ? 'You' : 'Teammate';
          return (
            <div key={m.id} className={`flex flex-col ${staff ? 'items-start' : 'items-end'}`}>
              <p className="mb-1 px-1 text-[11px] text-text-secondary">{who} · {formatMessageTime(m.created_at)}</p>
              <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                staff ? 'rounded-bl-sm border border-border/70 bg-bg-tertiary text-text-primary' : 'rounded-br-sm bg-accent text-white'
              }`}>
                {m.body}
                <MessageAttachments items={byMessage.get(m.id) ?? []} onDark={!staff} />
              </div>
            </div>
          );
        })}
      </div>

      <form onSubmit={(e) => void send(e)} className="space-y-3 border-t border-border p-4">
        {closed && (
          <p className="rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
            This ticket is resolved. Sending a reply will reopen it.
          </p>
        )}
        <Textarea
          aria-label="Reply" rows={3} maxLength={BODY_MAX} value={draft} disabled={sending}
          onChange={(e) => setDraft(e.target.value)} placeholder="Write a reply…"
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <AttachmentPicker files={files} onChange={setFiles} disabled={sending} />
          <Button type="submit" size="sm" disabled={!draft.trim() || sending} className="sm:shrink-0">
            {sending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
            Send
          </Button>
        </div>
      </form>
    </section>
  );
}
