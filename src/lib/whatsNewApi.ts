import { supabase } from '@/lib/supabase';

/** Release ids the signed-in user has marked read (RLS limits rows to auth.uid()). */
export async function fetchReadReleaseIds(): Promise<Set<string>> {
  const { data, error } = await supabase.from('release_note_reads').select('release_id');
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((row: { release_id: string }) => row.release_id));
}

export async function markReleasesRead(userId: string, releaseIds: string[]): Promise<void> {
  if (releaseIds.length === 0) return;
  const { error } = await supabase
    .from('release_note_reads')
    .upsert(
      releaseIds.map((release_id) => ({ user_id: userId, release_id })),
      { onConflict: 'user_id,release_id', ignoreDuplicates: true },
    );
  if (error) throw new Error(error.message);
}
