import { supabase } from '@/lib/supabase';

export type ConversationStatus = 'open' | 'active' | 'closed';
export type MessageSender = 'visitor' | 'staff';

export interface SupportConversation {
  id: string;
  visitor_id: string;
  visitor_name: string | null;
  visitor_email: string | null;
  page_path: string | null;
  status: ConversationStatus;
  assigned_staff_id: string | null;
  last_message_at: string;
  created_at: string;
}

export interface SupportMessage {
  id: string;
  conversation_id: string;
  sender_type: MessageSender;
  sender_id: string;
  body: string;
  created_at: string;
}

/**
 * Every marketing-site visitor who opens the live chat gets a real (but
 * anonymous) Supabase Auth session — no email/password. supabase-js
 * persists it in localStorage, so a returning visitor keeps the same
 * auth.uid() (and conversation history) until they clear site data.
 */
export async function ensureVisitorSession(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (data.session?.user?.id) return data.session.user.id;

  const { data: signInData, error } = await supabase.auth.signInAnonymously();
  if (error || !signInData.user) {
    throw new Error('Could not start a chat session. Please try again.');
  }
  return signInData.user.id;
}

export function formatMessageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
