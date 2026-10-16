/**
 * Voicemail Drops - data access.
 *
 * Every call is explicitly scoped by account_owner_id AND protected by RLS /
 * storage policies (see 20270410000000_voicemail_drops.sql), so a mistake here
 * can never leak another account's rows or files.
 */

import { supabase } from '@/lib/supabase';
import {
  audioContentType,
  buildStoragePath,
  type ComplianceFlags,
  type DropCampaignType,
  type VoicemailDrop,
  type VoicemailDropStats,
  type VoicemailDropStatus,
} from '@/lib/voicemailDrops';

const BUCKET = 'voicemail-drops';
const COLUMNS =
  'id, account_owner_id, name, description, storage_path, file_name, mime_type, size_bytes, duration_seconds, transcript, campaign_types, uses_ai_voice, discloses_business_name, includes_callback_number, includes_opt_out, consent_confirmed, compliance_ready, status, created_at, updated_at, archived_at';

interface PgError {
  code?: string;
  message: string;
}

function toError(error: PgError, fallback: string): Error {
  if (error.code === '23505') return new Error('A drop with that name already exists. Choose a different name.');
  if (error.code === '42501') return new Error("You don't have permission to change voicemail drops.");
  return new Error(fallback);
}

export async function fetchVoicemailDrops(accountOwnerId: string): Promise<VoicemailDrop[]> {
  const { data, error } = await supabase
    .from('voicemail_drops')
    .select(COLUMNS)
    .eq('account_owner_id', accountOwnerId)
    .order('created_at', { ascending: false });
  if (error) throw toError(error, 'Could not load voicemail drops.');
  return (data as unknown as VoicemailDrop[]) ?? [];
}

export async function fetchVoicemailDropStats(
  accountOwnerId: string,
): Promise<Record<string, VoicemailDropStats>> {
  const { data, error } = await supabase
    .from('voicemail_drop_stats')
    .select('drop_id, total_uses, uses_30d, delivered, failed, last_used_at')
    .eq('account_owner_id', accountOwnerId);
  if (error) throw toError(error, 'Could not load usage stats.');
  const map: Record<string, VoicemailDropStats> = {};
  for (const row of (data as unknown as VoicemailDropStats[]) ?? []) map[row.drop_id] = row;
  return map;
}

/** Reads duration from file metadata in the browser; null when it cannot be read. */
export function readAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), 5000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () =>
      finish(Number.isFinite(audio.duration) ? Math.max(1, Math.round(audio.duration)) : null);
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}

export interface CreateVoicemailDropInput extends ComplianceFlags {
  accountOwnerId: string;
  file: File;
  name: string;
  description: string | null;
  transcript: string | null;
  campaignTypes: DropCampaignType[];
  usesAiVoice: boolean;
  durationSeconds: number | null;
}

export async function createVoicemailDrop(input: CreateVoicemailDropInput): Promise<VoicemailDrop> {
  const path = buildStoragePath(input.accountOwnerId, input.file.name, crypto.randomUUID());

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, input.file, {
    contentType: audioContentType(input.file.name),
    cacheControl: '3600',
    upsert: false,
  });
  if (uploadError) throw new Error('Upload failed. Check the file and try again.');

  const { data, error } = await supabase
    .from('voicemail_drops')
    .insert({
      account_owner_id: input.accountOwnerId,
      name: input.name.trim(),
      description: input.description,
      transcript: input.transcript,
      storage_path: path,
      file_name: input.file.name,
      mime_type: audioContentType(input.file.name),
      size_bytes: input.file.size,
      duration_seconds: input.durationSeconds,
      campaign_types: input.campaignTypes,
      uses_ai_voice: input.usesAiVoice,
      discloses_business_name: input.discloses_business_name,
      includes_callback_number: input.includes_callback_number,
      includes_opt_out: input.includes_opt_out,
      consent_confirmed: input.consent_confirmed,
    })
    .select(COLUMNS)
    .single();

  if (error) {
    // Never leave an orphaned file behind when the row could not be created.
    await supabase.storage.from(BUCKET).remove([path]);
    throw toError(error, 'Could not save this voicemail drop.');
  }
  return data as unknown as VoicemailDrop;
}

export type UpdateVoicemailDropPatch = Partial<
  ComplianceFlags & {
    name: string;
    description: string | null;
    transcript: string | null;
    campaign_types: DropCampaignType[];
    uses_ai_voice: boolean;
  }
>;

export async function updateVoicemailDrop(
  accountOwnerId: string,
  id: string,
  patch: UpdateVoicemailDropPatch,
): Promise<VoicemailDrop> {
  const { data, error } = await supabase
    .from('voicemail_drops')
    .update(patch.name === undefined ? patch : { ...patch, name: patch.name.trim() })
    .eq('id', id)
    .eq('account_owner_id', accountOwnerId)
    .select(COLUMNS)
    .single();
  if (error) throw toError(error, 'Could not update this voicemail drop.');
  return data as unknown as VoicemailDrop;
}

export function setVoicemailDropStatus(
  accountOwnerId: string,
  id: string,
  status: VoicemailDropStatus,
): Promise<VoicemailDrop> {
  return updateVoicemailDrop(accountOwnerId, id, {}).catch(() => {
    throw new Error('unreachable');
  }) as never;
}
