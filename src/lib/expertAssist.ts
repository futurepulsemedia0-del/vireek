import { supabase } from '@/lib/supabase';
import type { JobBrief } from '@/lib/technicianOS';

export type ExpertAssistStatus = 'open' | 'claimed' | 'resolved' | 'cancelled';
export type MessageKind = 'text' | 'photo' | 'audio' | 'annotation';

export interface AnnotationPoint {
  x: number; // 0..1 relative to image width
  y: number; // 0..1 relative to image height
  type: 'circle' | 'arrow' | 'label';
  label?: string;
}

export interface ExpertAssistMessage {
  id: string;
  request_id: string;
  sender_team_member_id: string;
  kind: MessageKind;
  body: string | null;
  media_path: string | null;
  annotation_data: { target_message_id: string; points: AnnotationPoint[] } | null;
  created_at: string;
}

export interface ExpertAssistRequest {
  id: string;
  job_id: string | null;
  requested_by: string;
  assigned_expert_id: string | null;
  error_code: string | null;
  context_snapshot: Record<string, unknown>;
  status: ExpertAssistStatus;
  resolution_summary: string | null;
  created_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
}

/** Builds the context snapshot from an already-fetched Job Brief — no extra query. */
export function snapshotFromBrief(brief: JobBrief) {
  return {
    equipment: brief.equipment,
    likely_diagnosis: brief.likely_diagnosis,
    parts_check: brief.parts_check,
    customer_preferences: brief.customer_preferences,
  };
}

export async function createExpertAssistRequest(
  jobId: string | null,
  errorCode: string | null,
  contextSnapshot: Record<string, unknown>,
  note?: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('create_expert_assist_request', {
    p_job_id: jobId,
    p_error_code: errorCode,
    p_context_snapshot: contextSnapshot,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function fetchOpenRequests(): Promise<ExpertAssistRequest[]> {
  const { data, error } = await supabase
    .from('expert_assist_requests')
    .select('*')
    .in('status', ['open', 'claimed'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as ExpertAssistRequest[];
}

export async function fetchRequest(requestId: string): Promise<ExpertAssistRequest> {
  const { data, error } = await supabase.from('expert_assist_requests').select('*').eq('id', requestId).single();
  if (error) throw error;
  return data as ExpertAssistRequest;
}

export async function fetchMessages(requestId: string): Promise<ExpertAssistMessage[]> {
  const { data, error } = await supabase
    .from('expert_assist_messages')
    .select('*')
    .eq('request_id', requestId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []) as ExpertAssistMessage[];
}

export function subscribeToThread(requestId: string, onChange: () => void) {
  const channel = supabase
    .channel(`expert-assist-${requestId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'expert_assist_messages', filter: `request_id=eq.${requestId}` }, onChange)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'expert_assist_requests', filter: `id=eq.${requestId}` }, onChange)
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

export async function claimRequest(requestId: string) {
  const { data, error } = await supabase.rpc('claim_expert_assist_request', { p_request_id: requestId });
  if (error) throw error;
  return data as { success: boolean; error?: string };
}

export async function resolveRequest(requestId: string, summary: string, publishToKnowledge = true) {
  const { data, error } = await supabase.rpc('resolve_expert_assist_request', {
    p_request_id: requestId, p_summary: summary, p_publish_to_knowledge: publishToKnowledge,
  });
  if (error) throw error;
  return data as { success: boolean; error?: string };
}

async function uploadMedia(userId: string, file: Blob, ext: string): Promise<string> {
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from('expert-assist-media').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export async function sendPhotoMessage(userId: string, requestId: string, file: File) {
  const ext = file.name.split('.').pop() || 'jpg';
  const path = await uploadMedia(userId, file, ext);
  const { error } = await supabase.rpc('add_expert_assist_message', {
    p_request_id: requestId, p_kind: 'photo', p_body: null, p_media_path: path, p_annotation_data: null,
  });
  if (error) throw error;
}

export async function sendAudioMessage(userId: string, requestId: string, blob: Blob) {
  const path = await uploadMedia(userId, blob, 'webm');
  const { error } = await supabase.rpc('add_expert_assist_message', {
    p_request_id: requestId, p_kind: 'audio', p_body: null, p_media_path: path, p_annotation_data: null,
  });
  if (error) throw error;
}

export async function sendTextMessage(requestId: string, body: string) {
  const { error } = await supabase.rpc('add_expert_assist_message', {
    p_request_id: requestId, p_kind: 'text', p_body: body, p_media_path: null, p_annotation_data: null,
  });
  if (error) throw error;
}

export async function sendAnnotation(requestId: string, targetMessageId: string, points: AnnotationPoint[]) {
  const { error } = await supabase.rpc('add_expert_assist_message', {
    p_request_id: requestId, p_kind: 'annotation', p_body: null, p_media_path: null,
    p_annotation_data: { target_message_id: targetMessageId, points },
  });
  if (error) throw error;
}

export function mediaUrl(path: string | null): string | null {
  if (!path) return null;
  const { data } = supabase.storage.from('expert-assist-media').createSignedUrl
    ? { data: null as any } // placeholder — real signed URL fetch is async, see getSignedMediaUrl below
    : { data: null as any };
  return null;
}

export async function getSignedMediaUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('expert-assist-media').createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}
