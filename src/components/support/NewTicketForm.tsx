import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { AttachmentPicker } from '@/components/support/TicketParts';
import { createTicket, type CreateTicketContext } from '@/lib/supportTicketsApi';
import {
  BODY_MAX, CATEGORIES, PRIORITIES, SUBJECT_MAX, validateTicketInput,
  type Ticket, type TicketCategory, type TicketPriority,
} from '@/lib/supportTickets';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent';

export function NewTicketForm({
  ctx, onCreated, onCancel,
}: { ctx: CreateTicketContext; onCreated: (ticket: Ticket) => void; onCancel: () => void }) {
  const { toast } = useToast();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<TicketCategory>('technical');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Partial<Record<'subject' | 'body', string>>>({});
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const found = validateTicketInput({ subject, body });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    try {
      const { ticket, failedUploads } = await createTicket(ctx, { subject, body, category, priority }, files);
      if (failedUploads.length > 0) {
        toast(`Ticket created, but ${failedUploads.length} file(s) didn’t upload: ${failedUploads.join(', ')}. Reply to add them again.`, 'error');
      } else {
        toast('Ticket created — our team will be in touch.', 'success');
      }
      onCreated(ticket);
    } catch {
      toast('Could not create your ticket. Please try again.', 'error');
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5" noValidate>
      <h2 className="text-base font-semibold text-text-primary">New support ticket</h2>
      <Input
        label="Subject" required maxLength={SUBJECT_MAX} value={subject} error={errors.subject}
        onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Invoices aren’t syncing to QuickBooks" disabled={submitting}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="ticket-category" className="mb-1.5 block text-sm font-medium text-text-primary">Category</label>
          <select id="ticket-category" className={selectClass} value={category} disabled={submitting}
            onChange={(e) => setCategory(e.target.value as TicketCategory)}>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="ticket-priority" className="mb-1.5 block text-sm font-medium text-text-primary">Priority</label>
          <select id="ticket-priority" className={selectClass} value={priority} disabled={submitting}
            onChange={(e) => setPriority(e.target.value as TicketPriority)}>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label} — {p.hint}</option>)}
          </select>
        </div>
      </div>
      <Textarea
        label="What’s happening?" required rows={6} maxLength={BODY_MAX} value={body} error={errors.body}
        helperText="Include steps to reproduce and what you expected." onChange={(e) => setBody(e.target.value)} disabled={submitting}
      />
      <AttachmentPicker files={files} onChange={setFiles} disabled={submitting} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
          Submit ticket
        </Button>
      </div>
    </form>
  );
}
