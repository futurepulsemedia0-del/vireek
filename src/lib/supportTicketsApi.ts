import { supabase } from '@/lib/supabase';
import type { SupportMessage } from '@/lib/supportChat';
import {
  buildStoragePath, resolveMime,
  type Ticket, type TicketAttachment, type TicketInput,
} from '@/lib/supportTickets';

const TICKET_COLUMNS =
  'id,ticket_number,subject,category,priority,status,awaiting_customer,first_response_at,resolved_at,' +
  'sla_first_response_due_at,sla_resolution_due_at,created_at,last_message_at,visitor_id';

/** Every query is scoped to the ACCOUNT OWNER, so team members see the owner's tickets. */
export async function fetchTickets(ownerId: string): Promise<Ticket[]> {
  const { data, error } = await supabase
    .from('support_conversations')
    .select(TICKET_COLUMNS)
    .eq('kind', 'ticket')
    .eq('account_owner_id', ownerId)
    .order('last_message_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as unknown as Ticket[];
}

export async function fetchMessages(conversationId: string): Promise<SupportMessage[]> {
  const { data, error } = await supabase
    .from('support_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as SupportMessage[];
}

export async function fetchAttachments(conversationId: string): Promise<TicketAttachment[]> {
  const { data, error } = await supabase
    .from('support_attachments')
    .select('id,conversation_id,message_id,storage_path,file_name,mime_type,size_bytes,created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as TicketAttachment[];
}

/** Short-lived signed link; the bucket is private. */
export async function getAttachmentUrl(path: string, download?: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from('support-attachments')
    .createSignedUrl(path, 60, download ? { download } : undefined);
  if (error || !data?.signedUrl) throw error ?? new Error('Could not open the file.');
  return data.signedUrl;
}

/** Uploads files and links them to a message. Returns the names that failed. */
async function attachFiles(
  ownerId: string, conversationId: string, messageId: string, files: File[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const file of files) {
    const path = buildStoragePath(ownerId, conversationId, file.name, crypto.randomUUID());
    const mime = resolveMime(file);
    const { error: uploadError } = await supabase.storage
      .from('support-attachments')
      .upload(path, file, { contentType: mime, upsert: false });
    if (uploadError) {
      failed.push(file.name);
      continue;
    }
    const { error: rowError } = await supabase.from('support_attachments').insert({
      conversation_id: conversationId,
      message_id: messageId,
      storage_path: path,
      file_name: file.name.slice(0, 180),
      mime_type: mime,
      size_bytes: file.size,
    });
    if (rowError) {
      await supabase.storage.from('support-attachments').remove([path]);
      failed.push(file.name);
    }
  }
  return failed;
}

export async function sendMessage(
  ownerId: string, userId: string, conversationId: string, body: string, files: File[],
): Promise<{ message: SupportMessage; failedUploads: string[] }> {
  const { data, error } = await supabase
    .from('support_messages')
    .insert({ conversation_id: conversationId, sender_type: 'visitor', sender_id: userId, body: body.trim() })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('Could not send your message.');
  const message = data as SupportMessage;
  const failedUploads = files.length ? await attachFiles(ownerId, conversationId, message.id, files) : [];
  return { message, failedUploads };
}

export interface CreateTicketContext {
  ownerId: string;
  userId: string;
  name: string | null;
  email: string | null;
}

export async function createTicket(
  ctx: CreateTicketContext, input: TicketInput, files: File[],
): Promise<{ ticket: Ticket; failedUploads: string[] }> {
  const { data, error } = await supabase
    .from('support_conversations')
    .insert({
      visitor_id: ctx.userId,
      visitor_name: ctx.name,
      visitor_email: ctx.email,
      page_path: '/dashboard/support',
      kind: 'ticket',
      subject: input.subject.trim(),
      category: input.category,
      priority: input.priority,
    })
    .select(TICKET_COLUMNS)
    .single();
  if (error || !data) throw error ?? new Error('Could not create the ticket.');
  const ticket = data as unknown as Ticket;
  const { failedUploads } = await sendMessage(ctx.ownerId, ctx.userId, ticket.id, input.body, files);
  return { ticket, failedUploads };
}

export async function setTicketClosed(ticketId: string, closed: boolean): Promise<void> {
  const { error } = await supabase
    .from('support_conversations')
    .update({ status: closed ? 'closed' : 'open' })
    .eq('id', ticketId)
    .eq('kind', 'ticket');
  if (error) throw error;
}
