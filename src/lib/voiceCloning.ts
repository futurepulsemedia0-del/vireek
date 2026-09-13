import { supabase } from '@/lib/supabase';

/** Uploads a voice sample to the private `voice-samples` bucket, scoped to the user's own folder. */
export async function uploadVoiceSample(userId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'mp3';
  const path = `${userId}/sample-${Date.now()}.${ext}`;

  const { error } = await supabase.storage.from('voice-samples').upload(path, file, { upsert: true });
  if (error) throw error;
  return path;
}

/** Kicks off ElevenLabs voice cloning for an already-uploaded sample. */
export async function triggerVoiceCloning(storagePath: string): Promise<{ error: string | null }> {
  const { error } = await supabase.functions.invoke('clone-voice', {
    body: { storagePath },
  });
  return { error: error ? error.message : null };
}
