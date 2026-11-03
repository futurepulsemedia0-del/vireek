import { supabase } from '@/lib/supabase';

/** Uploads a voice sample to the private `voice-samples` bucket, scoped to the user's own folder. */
export async function uploadVoiceSample(userId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'mp3';
  const path = `${userId}/sample-${Date.now()}.${ext}`;

  const { error } = await supabase.storage.from('voice-samples').upload(path, file, { upsert: true });
  if (error) throw error;
  return path;
}

/**
 * Kicks off ElevenLabs voice cloning for an already-uploaded sample.
 * Requires the owner's explicit consent; the server records who consented and when.
 */
export async function triggerVoiceCloning(
  storagePath: string,
  consentConfirmed: boolean,
): Promise<{ error: string | null }> {
  if (consentConfirmed !== true) return { error: 'Please confirm consent before cloning a voice.' };
  const { error } = await supabase.functions.invoke('clone-voice', {
    body: { storagePath, consent: true },
  });
  return { error: error ? error.message : null };
}

/** Permanently deletes the cloned voice (at ElevenLabs and in the database) and its uploaded sample. */
export async function deleteClonedVoice(): Promise<{ error: string | null }> {
  const { error } = await supabase.functions.invoke('delete-cloned-voice', { body: {} });
  return { error: error ? error.message : null };
}
