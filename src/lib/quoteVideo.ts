/**
 * Video quotes - pure client helpers (no network, no Supabase).
 *
 * Limits and validation come from the SAME engine the edge functions use, so the
 * UI can never accept something the server will reject (or the other way round).
 */

import {
  ALLOWED_VIDEO_MIME,
  DEFAULT_RETENTION_DAYS,
  MAX_RECORD_SECONDS,
  MAX_VIDEOS_PER_QUOTE,
  MAX_VIDEO_BYTES,
  WATCHED_THRESHOLD_PERCENT,
  buildStoragePath,
  clampRetentionDays,
  isWatched,
  normalizeVideoMime,
  progressStep,
  validateUpload,
  watchPercent,
  type QuoteVideoMime,
  type UploadCheck,
} from '../../supabase/functions/_shared/quote-video/engine';

export {
  ALLOWED_VIDEO_MIME,
  DEFAULT_RETENTION_DAYS,
  MAX_RECORD_SECONDS,
  MAX_VIDEOS_PER_QUOTE,
  MAX_VIDEO_BYTES,
  WATCHED_THRESHOLD_PERCENT,
  buildStoragePath,
  clampRetentionDays,
  isWatched,
  normalizeVideoMime,
  progressStep,
  validateUpload,
  watchPercent,
};
export type { QuoteVideoMime, UploadCheck };

/** Technician-side row (RLS-scoped select on quote_videos). */
export interface QuoteVideoRow {
  id: string;
  quote_id: string | null;
  title: string;
  note: string | null;
  storage_path: string;
  mime_type: QuoteVideoMime;
  size_bytes: number;
  duration_seconds: number | null;
  shared: boolean;
  shared_at: string | null;
  view_count: number;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  max_progress: number;
  completed_at: string | null;
  acknowledged_at: string | null;
  acknowledged_name: string | null;
  created_at: string;
}

/** Customer-side item (edge function output - no storage paths). */
export interface PublicQuoteVideo {
  id: string;
  title: string;
  note: string | null;
  mime_type: string;
  duration_seconds: number | null;
  max_progress: number;
  completed: boolean;
  acknowledged: boolean;
  url: string;
}

export const RETENTION_CHOICES: ReadonlyArray<{ days: number; label: string }> = [
  { days: 90, label: '90 days' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
  { days: 730, label: '2 years' },
  { days: 1825, label: '5 years' },
];

/** Codecs in order of preference; Safari only does MP4, everything else WebM. */
export const RECORDER_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
] as const;

export function pickRecorderMime(isTypeSupported: ((type: string) => boolean) | undefined): string | undefined {
  if (!isTypeSupported) return undefined;
  return RECORDER_MIME_CANDIDATES.find((m) => isTypeSupported(m));
}

/** 75 -> "1:15". Unknown / invalid -> an em dash. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '\u2014';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '\u2014';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type WatchTone = 'neutral' | 'warning' | 'success';

/** Short, honest status line for the technician: what the customer actually did. */
export function describeEngagement(
  video: Pick<QuoteVideoRow, 'shared' | 'view_count' | 'max_progress' | 'acknowledged_at' | 'acknowledged_name'>,
): { label: string; tone: WatchTone } {
  if (!video.shared) return { label: 'Private \u2014 customer cannot see it yet', tone: 'neutral' };
  if (video.acknowledged_at) {
    const who = video.acknowledged_name ? ` by ${video.acknowledged_name}` : '';
    return { label: `Watched and acknowledged${who}`, tone: 'success' };
  }
  if (isWatched(video.max_progress)) return { label: 'Watched \u2014 not acknowledged yet', tone: 'success' };
  if (video.view_count > 0) return { label: `Started \u2014 watched ${video.max_progress}%`, tone: 'warning' };
  return { label: 'Shared \u2014 not opened yet', tone: 'neutral' };
}

const UPLOAD_MESSAGES: Record<Exclude<UploadCheck, { ok: true }>['code'], string> = {
  TYPE: 'Use an MP4, MOV or WebM video.',
  SIZE: `That video is too large. Keep it under ${Math.round(MAX_VIDEO_BYTES / 1048576)} MB.`,
  EMPTY: 'That video file is empty. Please record it again.',
  DURATION: 'That video is too long. Keep it under 10 minutes - 1 to 2 minutes is ideal.',
};

export function uploadErrorMessage(code: Exclude<UploadCheck, { ok: true }>['code']): string {
  return UPLOAD_MESSAGES[code];
}

/** Map stable SQL / edge error codes to customer- or technician-facing copy. */
const ERROR_COPY: Array<[string, string]> = [
  ['QUOTE_VIDEO_LIMIT', `A quote can have up to ${MAX_VIDEOS_PER_QUOTE} videos. Delete one to add another.`],
  ['QUOTE_CLOSED', 'This quote has already been answered, so videos can no longer be added.'],
  ['UPLOAD_MISSING', 'The upload did not finish. Please try again.'],
  ['INVALID_SIZE', 'That video is too large or empty.'],
  ['INVALID_PATH', 'Could not save the video. Please try again.'],
  ['FORBIDDEN', 'You do not have permission to manage quote videos.'],
  ['NOT_FOUND', 'That video no longer exists.'],
  ['LIVE_NOT_CONFIGURED', 'Live video is not set up for this workspace yet.'],
  ['LIVE_UNAVAILABLE', 'The video service is unavailable right now. Please try again in a minute.'],
  ['NO_LIVE_SESSION', 'The live session has ended.'],
  ['JOIN_LIMIT', 'This live session has reached its join limit. Ask your technician for a new one.'],
  ['WATCH_REQUIRED', 'Please watch the video first.'],
  ['NAME_REQUIRED', 'Please type your name to confirm.'],
  ['QUOTE_NOT_OPEN', 'This quote has already been answered.'],
];

export function friendlyVideoError(code: string | null | undefined, fallback = 'Something went wrong. Please try again.'): string {
  if (!code) return fallback;
  return ERROR_COPY.find(([key]) => code.includes(key))?.[1] ?? fallback;
}

/** Throttled progress reporter: fires once per newly-reached step (25/50/75/90/100). */
export function createProgressReporter(report: (percent: number) => void) {
  let lastStep = 0;
  return {
    update(currentTime: number, duration: number): void {
      const step = progressStep(watchPercent(currentTime, duration));
      if (step > lastStep) {
        lastStep = step;
        report(step);
      }
    },
    reset(): void {
      lastStep = 0;
    },
  };
}
