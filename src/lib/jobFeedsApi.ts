/**
 * Job-board syndication - data access (staff only; enforced by RLS on job_board_feeds).
 * The public XML feeds are served by the `job-feeds` edge function, not through this module.
 */

import { supabase } from '@/lib/supabase';
import type { FeedBoard } from '../../supabase/functions/_shared/job-feeds/engine';

export interface BoardFeed {
  board: FeedBoard;
  enabled: boolean;
  linkedin_company_id: string | null;
  poster_email: string | null;
  enabled_at: string | null;
  last_fetched_at: string | null;
  fetch_count: number;
  last_job_count: number | null;
  last_skipped_count: number | null;
}

export interface BoardFeedPatch {
  enabled?: boolean;
  linkedin_company_id?: string | null;
  poster_email?: string | null;
}

const COLUMNS =
  'board, enabled, linkedin_company_id, poster_email, enabled_at, last_fetched_at, fetch_count, last_job_count, last_skipped_count';

export const FEED_SITE = 'https://vireek.com';
export const feedUrl = (board: FeedBoard): string => `${FEED_SITE}/feeds/${board}.xml`;

export async function fetchBoardFeeds(): Promise<Record<FeedBoard, BoardFeed>> {
  const { data, error } = await supabase.from('job_board_feeds').select(COLUMNS);
  if (error) throw new Error('Could not load job-board settings.');
  const map = {} as Record<FeedBoard, BoardFeed>;
  for (const row of (data as unknown as BoardFeed[]) ?? []) map[row.board] = row;
  return map;
}

export async function updateBoardFeed(board: FeedBoard, patch: BoardFeedPatch): Promise<BoardFeed> {
  const { data, error } = await supabase
    .from('job_board_feeds')
    .update(patch)
    .eq('board', board)
    .select(COLUMNS)
    .single();
  if (error) {
    if (error.code === '42501') throw new Error("You don't have permission to do that.");
    if (error.code === '23514') throw new Error('One of the values is not valid. Check the company ID and email.');
    throw new Error('Could not save this job board.');
  }
  return data as unknown as BoardFeed;
}
