// src/lib/native/mobileSurfacesApi.ts — reads / writes the signed-in person's own surface settings.
// RLS (user_mobile_surface_prefs) limits every row to auth.uid(); nothing here can touch another user.

import { supabase } from '@/lib/supabase';
import {
  DEFAULT_MOBILE_SURFACE_PREFS,
  normalizeMobileSurfacePrefs,
  type MobileSurfacePrefs,
} from './mobileSurfacesCore';

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('You need to be signed in.');
  return data.user.id;
}

export async function loadMobileSurfacePrefs(): Promise<MobileSurfacePrefs> {
  const userId = await currentUserId();
  const { data, error } = await supabase
    .from('user_mobile_surface_prefs')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error('Could not load your mobile settings.');
  return data ? normalizeMobileSurfacePrefs(data) : { ...DEFAULT_MOBILE_SURFACE_PREFS };
}

export async function saveMobileSurfacePrefs(patch: Partial<MobileSurfacePrefs>): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase
    .from('user_mobile_surface_prefs')
    .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' });
  if (error) throw new Error('Could not save your mobile settings.');
}
