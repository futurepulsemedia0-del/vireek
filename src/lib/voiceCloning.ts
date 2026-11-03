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
export async function triggerVoiceCloning(storagePath: string, consentId: string): Promise<{ error: string | null }> {
  const { error } = await supabase.functions.invoke('clone-voice', {
    body: { storagePath, consentId },
  });
  if (!error) return { error: null };
  try {
    const j = await (error as { context?: Response }).context?.json();
    if (j && typeof j.error === 'string') return { error: j.error };
  } catch { /* fall through */ }
  return { error: error.message };
}
/** Permanently deletes the cloned voice (at ElevenLabs and in the database) and its uploaded sample. */
export async function deleteClonedVoice(): Promise<{ error: string | null }> {
  const { error } = await supabase.functions.invoke('delete-cloned-voice', { body: {} });
  return { error: error ? error.message : null };
}
