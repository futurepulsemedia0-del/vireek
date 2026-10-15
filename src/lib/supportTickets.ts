/**
 * In-app support tickets — pure logic (no React, no network).
 *
 * Tickets are support_conversations rows with kind = 'ticket' (see
 * supabase/migrations/20271009010000_support_tickets.sql). Status reuses the
 * existing values: open = awaiting support, active = in progress,
 * closed = resolved; "waiting on you" is the awaiting_customer flag.
 */

import type { ConversationStatus } from '@/lib/supportChat';

export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TicketCategory = 'billing' | 'technical' | 'account' | 'feature_request' | 'other';
export type TicketState = 'open' | 'in_progress' | 'waiting_on_you' | 'resolved';
export type TicketFilter = 'open' | 'resolved' | 'all';

export interface Ticket {
  id: string;
  ticket_number: number | null;
  subject: string | null;
  category: TicketCategory | null;
  priority: TicketPriority;
  status: ConversationStatus;
  awaiting_customer: boolean;
  first_response_at: string | null;
  resolved_at: string | null;
  sla_first_response_due_at: string | null;
  sla_resolution_due_at: string | null;
  created_at: string;
  last_message_at: string;
  visitor_id: string;
}

export interface TicketAttachment {
  id: string;
  conversation_id: string;
  message_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export const PRIORITIES: { value: TicketPriority; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'Question or small request' },
  { value: 'normal', label: 'Normal', hint: 'Something isn’t working as expected' },
  { value: 'high', label: 'High', hint: 'A key workflow is blocked' },
  { value: 'urgent', label: 'Urgent', hint: 'Business-critical outage' },
];

export const CATEGORIES: { value: TicketCategory; label: string }[] = [
  { value: 'technical', label: 'Technical issue' },
  { value: 'billing', label: 'Billing' },
  { value: 'account', label: 'Account & access' },
  { value: 'feature_request', label: 'Feature request' },
  { value: 'other', label: 'Other' },
];

export const STATE_LABELS: Record<TicketState, string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_on_you: 'Waiting on you',
  resolved: 'Resolved',
};

export const SUBJECT_MIN = 3;
export const SUBJECT_MAX = 120;
export const BODY_MIN = 10;
export const BODY_MAX = 5000;

export const ticketRef = (n: number | null): string => (n == null ? 'VK-…' : `VK-${n}`);

export function ticketState(t: Pick<Ticket, 'status' | 'awaiting_customer'>): TicketState {
  if (t.status === 'closed') return 'resolved';
  if (t.awaiting_customer) return 'waiting_on_you';
  return t.status === 'active' ? 'in_progress' : 'open';
}

export function filterTickets(tickets: readonly Ticket[], filter: TicketFilter): Ticket[] {
  if (filter === 'all') return [...tickets];
  return tickets.filter((t) => (filter === 'resolved') === (t.status === 'closed'));
}

/** Unresolved first, then most recently active. */
export function sortTickets(tickets: readonly Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => {
    const ar = a.status === 'closed' ? 1 : 0;
    const br = b.status === 'closed' ? 1 : 0;
    if (ar !== br) return ar - br;
    return Date.parse(b.last_message_at) - Date.parse(a.last_message_at);
  });
}

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

export type SlaPhase = 'first_response' | 'resolution' | 'paused' | 'resolved' | 'none';
export type SlaTone = 'ok' | 'warning' | 'breached' | 'neutral';

export interface SlaState {
  phase: SlaPhase;
  tone: SlaTone;
  label: string;
  /** Ms until the active deadline; negative once overdue. null when no clock is running. */
  remainingMs: number | null;
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  if (totalMinutes < 1) return '<1m';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

const ts = (iso: string | null) => {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? null : n;
};

/** Warn when less than a quarter of the SLA window is left. */
const WARNING_RATIO = 0.25;

function clock(prefix: string, dueIso: string | null, createdIso: string, now: number): SlaState {
  const due = ts(dueIso);
  if (due === null) return { phase: 'none', tone: 'neutral', label: '', remainingMs: null };
  const remaining = due - now;
  const window = due - (ts(createdIso) ?? now);
  const phase: SlaPhase = prefix === 'First response' ? 'first_response' : 'resolution';
  if (remaining < 0) {
    return { phase, tone: 'breached', label: `${prefix} overdue by ${formatDuration(-remaining)}`, remainingMs: remaining };
  }
  const tone: SlaTone = window > 0 && remaining / window <= WARNING_RATIO ? 'warning' : 'ok';
  return { phase, tone, label: `${prefix} due in ${formatDuration(remaining)}`, remainingMs: remaining };
}

export function slaState(
  t: Pick<
    Ticket,
    'status' | 'awaiting_customer' | 'first_response_at' | 'resolved_at' |
    'sla_first_response_due_at' | 'sla_resolution_due_at' | 'created_at'
  >,
  now: number = Date.now(),
): SlaState {
  if (t.status === 'closed') {
    const resolved = ts(t.resolved_at);
    const due = ts(t.sla_resolution_due_at);
    if (resolved !== null && due !== null) {
      const late = resolved > due;
      return {
        phase: 'resolved',
        tone: late ? 'breached' : 'ok',
        label: late ? 'Resolved after SLA' : 'Resolved within SLA',
        remainingMs: null,
      };
    }
    return { phase: 'resolved', tone: 'neutral', label: 'Resolved', remainingMs: null };
  }
  if (!t.first_response_at) return clock('First response', t.sla_first_response_due_at, t.created_at, now);
  if (t.awaiting_customer) return { phase: 'paused', tone: 'neutral', label: 'Waiting on you', remainingMs: null };
  return clock('Resolution', t.sla_resolution_due_at, t.created_at, now);
}

// ---------------------------------------------------------------------------
// Input + attachment validation
// ---------------------------------------------------------------------------

export interface TicketInput {
  subject: string;
  body: string;
  category: TicketCategory;
  priority: TicketPriority;
}

export function validateTicketInput(input: Pick<TicketInput, 'subject' | 'body'>): Partial<Record<'subject' | 'body', string>> {
  const errors: Partial<Record<'subject' | 'body', string>> = {};
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (subject.length < SUBJECT_MIN) errors.subject = `Add a short subject (at least ${SUBJECT_MIN} characters).`;
  else if (subject.length > SUBJECT_MAX) errors.subject = `Keep the subject under ${SUBJECT_MAX} characters.`;
  if (body.length < BODY_MIN) errors.body = `Describe the problem (at least ${BODY_MIN} characters).`;
  else if (body.length > BODY_MAX) errors.body = `Keep the message under ${BODY_MAX.toLocaleString('en-US')} characters.`;
  return errors;
}

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Mirrors allowed_mime_types on the support-attachments bucket. */
export const ALLOWED_MIME: ReadonlySet<string> = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
  'application/pdf', 'text/plain', 'text/csv', 'video/mp4',
]);

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', mp4: 'video/mp4',
};

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

/** Browsers sometimes report an empty type (e.g. HEIC); fall back to the extension. */
export function resolveMime(file: FileLike): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? '';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AttachmentCheck<T extends FileLike> {
  accepted: T[];
  rejected: { name: string; reason: string }[];
}

/** Adds `incoming` to `current`, enforcing count, size, type and duplicates. */
export function addAttachments<T extends FileLike>(current: readonly T[], incoming: readonly T[]): AttachmentCheck<T> {
  const accepted: T[] = [...current];
  const rejected: { name: string; reason: string }[] = [];
  for (const file of incoming) {
    if (file.size <= 0) rejected.push({ name: file.name, reason: 'The file is empty.' });
    else if (file.size > MAX_ATTACHMENT_BYTES) rejected.push({ name: file.name, reason: `Larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.` });
    else if (!ALLOWED_MIME.has(resolveMime(file))) rejected.push({ name: file.name, reason: 'This file type isn’t supported.' });
    else if (accepted.some((f) => f.name === file.name && f.size === file.size)) rejected.push({ name: file.name, reason: 'Already added.' });
    else if (accepted.length >= MAX_ATTACHMENTS) rejected.push({ name: file.name, reason: `Limit is ${MAX_ATTACHMENTS} files.` });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** Safe object name: no path segments, no odd characters, extension preserved. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() : '';
  const cleanStem = stem.replace(/[^\w.-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80) || 'file';
  return ext ? `${cleanStem}.${ext}` : cleanStem;
}

/** <account_owner_id>/<conversation_id>/<uuid>-<name> — the layout the storage policies require. */
export function buildStoragePath(ownerId: string, conversationId: string, fileName: string, uniqueId: string): string {
  return `${ownerId}/${conversationId}/${uniqueId}-${safeFileName(fileName)}`;
}
