// Client API for Reputation (/dashboard/reputation).
// Backend: supabase/functions/reputation (authenticated, scoped to the account
// owner), reputation-sync (cron) and reputation-oauth-callback. Provider calls
// live behind supabase/functions/_shared/reputation/providers.ts. Pure rules
// (trends, alert rules, reply checks) live in the shared engine so client and
// server can never disagree. Schema: 20270404000000_reputation_management.sql.
// Required keys: docs/reputation-integrations.md.

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { UserPermissions } from '@/contexts/AuthContext';
import {
  PLATFORMS,
  PLATFORM_LABEL,
  REPLY_MAX,
  REPLY_WARNING_LABEL,
  computeTrends,
  replyWarnings,
  safeReviewUrl,
  sentimentOf,
  type Platform,
  type ReplyWarning,
  type ReviewStatus,
  type Sentiment,
  type Trends,
} from '../../supabase/functions/_shared/reputation/engine';

export { PLATFORMS, PLATFORM_LABEL, REPLY_MAX, REPLY_WARNING_LABEL, computeTrends, replyWarnings, safeReviewUrl, sentimentOf };
export type { Platform, ReplyWarning, ReviewStatus, Sentiment, Trends };

export interface Review {
  id: string;
  connection_id: string | null;
  platform: Platform;
  source: 'api' | 'manual';
  external_id: string | null;
  reviewer_name: string;
  rating: number;
  body: string | null;
  reviewed_at: string;
  review_url: string | null;
  status: ReviewStatus;
  draft_reply: string | null;
  draft_source: 'ai' | 'template' | 'staff' | null;
  draft_generated_at: string | null;
  reply_text: string | null;
  replied_at: string | null;
  reply_via: 'api' | 'manual' | 'platform' | null;
  created_at: string;
}

export interface Connection {
  id: string;
  platform: Platform;
  external_id: string;
  display_name: string;
  status: 'active' | 'needs_reauth' | 'error';
  last_synced_at: string | null;
  last_error: string | null;
}

export interface PlatformInfo {
  platform: Platform;
  configured: boolean;
  sync: boolean;
  reply: boolean;
  oauth: boolean;
  note: string;
}

export interface ReputationSettings {
  alerts_enabled: boolean;
  alert_max_rating: number;
  brand_voice: string | null;
  signoff: string | null;
}

export interface Overview {
  settings: ReputationSettings;
  connections: Connection[];
  platforms: PlatformInfo[];
  reviews: Review[];
  total: number;
  truncated: boolean;
  businessName: string;
}

export interface DraftInfo {
  reply: string;
  source: 'ai' | 'template';
  flags: string[];
  warnings: ReplyWarning[];
}

export interface SyncSummary {
  connection: string;
  inserted: number;
  updated: number;
  alerts: number;
  error: string | null;
}

/** Same rule as the dashboard nav + the edge function: owner, or can_edit_business_profile. */
export function canManageReputation(isOwner: boolean, permissions: UserPermissions): boolean {
  return isOwner || permissions.can_edit_business_profile === true;
}

export const SENTIMENT_CLASS: Record<Sentiment, string> = {
  positive: 'text-success',
  neutral: 'text-warning-500',
  negative: 'text-danger',
};

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function timeAgo(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'Never';
  const mins = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : formatDate(iso);
}

export type InboxFilter = 'needs_reply' | 'all' | 'replied' | 'dismissed';

export interface InboxQuery {
  filter: InboxFilter;
  platform: Platform | 'all';
  maxRating: number; // 5 = any
  search: string;
}

/** Filters + orders the inbox: unanswered low ratings first, then newest. */
export function filterReviews(reviews: Review[], q: InboxQuery): Review[] {
  const needle = q.search.trim().toLowerCase();
  const out = reviews.filter((r) => {
    if (q.filter === 'needs_reply' && r.status !== 'new') return false;
    if (q.filter === 'replied' && r.status !== 'replied') return false;
    if (q.filter === 'dismissed' && r.status !== 'dismissed') return false;
    if (q.platform !== 'all' && r.platform !== q.platform) return false;
    if (r.rating > q.maxRating) return false;
    if (needle && !`${r.reviewer_name} ${r.body ?? ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  return out.sort((a, b) => {
    if (q.filter === 'needs_reply') {
      const urgent = Number(a.rating <= 3) - Number(b.rating <= 3);
      if (urgent !== 0) return -urgent;
    }
    return new Date(b.reviewed_at).getTime() - new Date(a.reviewed_at).getTime();
  });
}

// ---------------------------------------------------------------
// transport
// ---------------------------------------------------------------

async function errorMessage(error: unknown, fallback: string): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = (await error.context.json().catch(() => null)) as { detail?: string } | null;
    if (body?.detail) return body.detail;
  }
  return fallback;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('reputation', { body });
  if (error) throw new Error(await errorMessage(error, 'Could not reach the reputation service. Check your connection and try again.'));
  if (data?.error) throw new Error(String(data.detail ?? data.error));
  return data as T;
}

export const fetchOverview = () => call<Overview>({ action: 'overview' });
export const addManualReview = (input: { platform: Platform; rating: number; reviewerName: string; body: string; reviewedAt?: string; reviewUrl?: string }) =>
  call<Overview>({ action: 'add_manual', ...input });
export const deleteManualReview = (reviewId: string) => call<Overview>({ action: 'delete_manual', reviewId });
export const draftReply = (reviewId: string) => call<Overview & { draft: DraftInfo }>({ action: 'draft_reply', reviewId });
export const saveReply = (reviewId: string, text: string, post: boolean) => call<Overview>({ action: 'save_reply', reviewId, text, post });
export const setReviewStatus = (reviewId: string, status: 'new' | 'dismissed') => call<Overview>({ action: 'set_status', reviewId, status });
export const saveReputationSettings = (s: { alertsEnabled: boolean; alertMaxRating: number; brandVoice: string; signoff: string }) =>
  call<Overview>({ action: 'save_settings', ...s });
export const syncNow = (connectionId?: string) => call<Overview & { sync: SyncSummary[] }>({ action: 'sync', connectionId });
export const startOAuth = (platform: 'google' | 'facebook') => call<{ url: string }>({ action: 'oauth_start', platform });
export const connectYelp = (businessId: string) => call<Overview>({ action: 'connect_yelp', businessId });
export const disconnectSource = (connectionId: string) => call<Overview>({ action: 'disconnect', connectionId });
