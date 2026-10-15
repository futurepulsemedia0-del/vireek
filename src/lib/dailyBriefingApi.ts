import { supabase } from '@/lib/supabase';
import {
  daysBetween,
  localParts,
  sanitizePrefs,
  type Briefing,
  type BriefingPrefs,
  type SectionKey,
} from '@/lib/dailyBriefing';

/** A preference row as the UI needs it (RLS already limits which rows come back). */
export interface PrefRecord {
  id: string;
  teamMemberId: string | null;
  prefs: BriefingPrefs;
  createdAt: string;
  updatedAt: string;
}

interface PrefDbRow {
  id: string;
  team_member_id: string | null;
  enabled: boolean;
  send_hour: number;
  timezone: string;
  channel_push: boolean;
  channel_email: boolean;
  channel_in_app: boolean;
  sections: string[] | null;
  last_sent_on: string | null;
  created_at: string;
  updated_at: string;
}

const toRecord = (r: PrefDbRow): PrefRecord => ({
  id: r.id,
  teamMemberId: r.team_member_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  prefs: sanitizePrefs({
    enabled: r.enabled,
    sendHour: r.send_hour,
    timezone: r.timezone,
    channels: { push: r.channel_push, email: r.channel_email, inApp: r.channel_in_app },
    sections: r.sections as SectionKey[] | null,
    lastSentOn: r.last_sent_on,
  }),
});

const toPatch = (p: Partial<BriefingPrefs>) => {
  const s = sanitizePrefs(p);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (p.enabled !== undefined) patch.enabled = s.enabled;
  if (p.sendHour !== undefined) patch.send_hour = s.sendHour;
  if (p.timezone !== undefined) patch.timezone = s.timezone;
  if (p.channels !== undefined) {
    patch.channel_push = s.channels.push;
    patch.channel_email = s.channels.email;
    patch.channel_in_app = s.channels.inApp;
  }
  if (p.sections !== undefined) patch.sections = s.sections;
  return patch;
};

export const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
};

/** Today's (or yesterday's, if the 7am run hasn't happened yet) briefing for the signed-in person. */
export async function fetchLatestBriefing(now: number = Date.now()): Promise<Briefing | null> {
  const { data, error } = await supabase
    .from('daily_briefings')
    .select('briefing_date,payload')
    .order('briefing_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.payload) return null;
  const today = localParts(now, browserTimezone()).date;
  if (daysBetween(data.briefing_date as string, today) > 1) return null; // never show a stale briefing as current
  return data.payload as Briefing;
}

/** Rebuilds the caller's own briefing (in-app only — never pushes or emails). */
export async function refreshBriefing(): Promise<boolean> {
  const { data, error } = await supabase.functions.invoke('daily-briefing', {
    body: { mode: 'self' },
  });
  return !error && (data as { ok?: boolean } | null)?.ok === true;
}

export async function fetchPrefRecords(): Promise<PrefRecord[]> {
  const { data, error } = await supabase
    .from('briefing_preferences')
    .select('*')
    .order('created_at');
  if (error || !data) throw error ?? new Error('Could not load briefing preferences');
  return (data as PrefDbRow[]).map(toRecord);
}

export async function savePrefs(id: string, patch: Partial<BriefingPrefs>): Promise<void> {
  const { error } = await supabase.from('briefing_preferences').update(toPatch(patch)).eq('id', id);
  if (error) throw error;
}

/** Owner enrols an active team member (they then get their role's briefing). */
export async function enrollMember(ownerId: string, teamMemberId: string): Promise<void> {
  const { error } = await supabase
    .from('briefing_preferences')
    .insert({
      account_owner_id: ownerId,
      team_member_id: teamMemberId,
      timezone: browserTimezone(),
    });
  if (error) throw error;
}

/**
 * New rows default to a US timezone. The first time someone opens the app we adopt their browser
 * timezone — once: any save (which bumps updated_at) turns this off, so we never overwrite a choice.
 */
export async function syncBrowserTimezone(
  records: PrefRecord[],
  myRowId: string | undefined,
): Promise<void> {
  const mine = records.find((r) => r.id === myRowId);
  const tz = browserTimezone();
  if (!mine || mine.createdAt !== mine.updatedAt || mine.prefs.timezone === tz) return;
  await savePrefs(mine.id, { timezone: tz }).catch(() => undefined);
}
