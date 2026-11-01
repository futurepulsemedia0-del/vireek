import { supabase } from '@/lib/supabase';
import { BANNER_KINDS, fromLoginEvent, fromSecurityEvent, mergeActivity, type ActivityItem, type ActivityKind, type LoginEventRowLike, type SecurityEventRowLike } from '@/lib/activityFeed';

const LIMIT = 500;

/** The signed-in user's own sign-ins + security changes (RLS scopes both tables to auth.uid()). */
export async function fetchAccountActivity(userId: string): Promise<ActivityItem[]> {
  // Only columns that exist in every login_events definition in this repo.
  const [security, logins] = await Promise.all([
    supabase.from('security_events').select('id,event,occurred_at,meta,acknowledged_at').eq('user_id', userId).order('occurred_at', { ascending: false }).limit(LIMIT),
    supabase.from('login_events').select('id,device_label,is_new_device,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(LIMIT),
  ]);
  if (security.error) throw security.error;
  if (logins.error) throw logins.error;
  return mergeActivity(
    ((security.data ?? []) as SecurityEventRowLike[]).map(fromSecurityEvent).filter((i): i is ActivityItem => i !== null),
    ((logins.data ?? []) as LoginEventRowLike[]).map(fromLoginEvent),
  );
}

export async function acknowledgeSecurityEvents(): Promise<void> {
  const { error } = await supabase.rpc('acknowledge_security_events');
  if (error) throw error;
}

/** Lightweight query for the layout-wide banner: unacknowledged, banner-worthy events from the last 14 days. */
export async function fetchBannerKinds(userId: string): Promise<ActivityKind[]> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('security_events')
    .select('event')
    .eq('user_id', userId)
    .is('acknowledged_at', null)
    .in('event', [...BANNER_KINDS])
    .gte('occurred_at', since)
    .limit(20);
  if (error) throw error;
  return [...new Set((data ?? []).map((r) => (r as { event: ActivityKind }).event))];
}
