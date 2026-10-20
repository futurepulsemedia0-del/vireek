import { supabase } from '@/lib/supabase';
import {
  feedErrorMessage,
  feedHttpsUrl,
  parseOverview,
  type CalendarFeed,
  type DetailLevel,
  type FeedOverview,
  type FeedScope,
} from '@/lib/calendarFeeds';

/**
 * All writes go through SECURITY DEFINER RPCs (20271020000000_calendar_ics_feeds.sql),
 * which re-check the caller's role; the table itself is read-only from the client.
 */

function feedBaseUrl(): string {
  return String(import.meta.env.VITE_SUPABASE_URL ?? '');
}

export function feedUrlFor(feed: Pick<CalendarFeed, 'token'>): string {
  return feedHttpsUrl(feedBaseUrl(), feed.token);
}

export async function fetchFeedOverview(): Promise<FeedOverview> {
  const { data, error } = await supabase.rpc('calendar_feed_overview');
  if (error) throw new Error(feedErrorMessage(error, 'Could not load calendar links.'));
  return parseOverview(data);
}

function toFeed(data: unknown, fallback: string): CalendarFeed {
  const parsed = parseOverview({ feeds: [data] }).feeds[0];
  if (!parsed) throw new Error(fallback);
  return parsed;
}

export async function ensureCalendarFeed(scope: FeedScope, memberId: string | null): Promise<CalendarFeed> {
  const fallback = 'Could not create the calendar link.';
  const { data, error } = await supabase.rpc('calendar_feed_ensure', { p_scope: scope, p_member_id: memberId });
  if (error) throw new Error(feedErrorMessage(error, fallback));
  return toFeed(data, fallback);
}

export async function regenerateCalendarFeed(feedId: string): Promise<CalendarFeed> {
  const fallback = 'Could not regenerate the calendar link.';
  const { data, error } = await supabase.rpc('calendar_feed_regenerate', { p_feed_id: feedId });
  if (error) throw new Error(feedErrorMessage(error, fallback));
  return toFeed(data, fallback);
}

export async function updateCalendarFeed(
  feedId: string,
  patch: { enabled?: boolean; detailLevel?: DetailLevel },
): Promise<CalendarFeed> {
  const fallback = 'Could not update the calendar link.';
  const { data, error } = await supabase.rpc('calendar_feed_update', {
    p_feed_id: feedId,
    p_enabled: patch.enabled ?? null,
    p_detail_level: patch.detailLevel ?? null,
  });
  if (error) throw new Error(feedErrorMessage(error, fallback));
  return toFeed(data, fallback);
}
