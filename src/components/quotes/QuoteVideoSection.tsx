/**
 * Customer side of Video Quotes (rendered on the public /quote/:token page).
 * Supplementary by design: if videos fail to load, or there are none, this
 * renders nothing and the normal quote / accept flow is untouched.
 *
 *  - plays shared video explanations from short-lived signed URLs
 *  - reports watch progress (viewed / 25 / 50 / 75 / 90 / completed)
 *  - after watching, the customer can confirm "I watched this" with their name
 *  - shows a Join button while the technician has a live estimate open
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Radio } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LiveVideoFrame } from '@/components/quotes/LiveVideoFrame';
import {
  createProgressReporter,
  formatDuration,
  friendlyVideoError,
  isWatched,
  type PublicQuoteVideo,
} from '@/lib/quoteVideo';
import {
  acknowledgeVideo,
  fetchLiveStatus,
  fetchPublicQuoteVideos,
  joinLiveEstimate,
  trackVideoEvent,
  type PublicVideoState,
} from '@/lib/quoteVideoApi';

const LIVE_POLL_MS = 20_000;

interface ItemProps {
  token: string;
  video: PublicQuoteVideo;
  customerName: string;
  quoteOpen: boolean;
  onUrlExpired: () => void;
}

function PublicVideoItem({ token, video, customerName, quoteOpen, onUrlExpired }: ItemProps) {
  const [watched, setWatched] = useState(video.completed || isWatched(video.max_progress));
  const [acknowledged, setAcknowledged] = useState(video.acknowledged);
  const [name, setName] = useState(customerName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewedRef = useRef(false);
  const refreshedRef = useRef(false);

  const reporter = useMemo(
    () =>
      createProgressReporter((step) => {
        if (step >= 90) setWatched(true);
        if (step === 100) trackVideoEvent(token, video.id, 'completed');
        else trackVideoEvent(token, video.id, 'progress', step);
      }),
    [token, video.id],
  );

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await acknowledgeVideo(token, video.id, name);
      setAcknowledged(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : friendlyVideoError(null));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
      <p className="text-sm font-semibold text-text-primary">{video.title}</p>
      {video.note ? <p className="mt-1 whitespace-pre-line text-sm text-text-secondary">{video.note}</p> : null}
      <video
        src={video.url}
        controls
        playsInline
        preload="metadata"
        controlsList="nodownload"
        disablePictureInPicture
        aria-label={`${video.title}${video.duration_seconds ? ` (${formatDuration(video.duration_seconds)})` : ''}`}
        className="mt-3 aspect-video w-full rounded-xl bg-black"
        onContextMenu={(e) => e.preventDefault()}
        onPlay={() => {
          if (viewedRef.current) return;
          viewedRef.current = true;
          trackVideoEvent(token, video.id, 'viewed');
        }}
        onTimeUpdate={(e) => reporter.update(e.currentTarget.currentTime, e.currentTarget.duration)}
        onEnded={(e) => reporter.update(e.currentTarget.duration, e.currentTarget.duration)}
        onError={() => {
          // Signed URL probably expired: fetch fresh ones once.
          if (refreshedRef.current) return;
          refreshedRef.current = true;
          onUrlExpired();
        }}
      />

      {acknowledged ? (
        <p className="mt-3 flex items-center gap-2 text-sm font-medium text-success-500">
          <CheckCircle2 size={16} aria-hidden="true" /> Thanks — your confirmation was sent.
        </p>
      ) : watched && quoteOpen ? (
        <div className="mt-3 space-y-2">
          <Input id={`ack-${video.id}`} label="Your name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" onClick={() => void confirm()} disabled={busy || name.trim().length === 0}>
            {busy ? 'Sending…' : 'I watched this explanation'}
          </Button>
          <p className="text-xs text-text-secondary">This only confirms you watched the video. You still accept or decline the quote below.</p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}

interface Props {
  token: string;
  customerName?: string | null;
  quoteOpen: boolean;
}

export function QuoteVideoSection({ token, customerName, quoteOpen }: Props) {
  const [state, setState] = useState<PublicVideoState | null>(null);
  const [live, setLive] = useState(false);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await fetchPublicQuoteVideos(token);
    if (next) {
      setState(next);
      setLive(next.live);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only the cheap live flag (never the video list: that would rotate signed URLs mid-playback).
  useEffect(() => {
    if (liveUrl) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void fetchLiveStatus(token).then(setLive);
    }, LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [token, liveUrl]);

  const join = async () => {
    setJoining(true);
    setJoinError(null);
    try {
      setLiveUrl(await joinLiveEstimate(token, customerName ?? ''));
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : friendlyVideoError(null));
      void fetchLiveStatus(token).then(setLive);
    } finally {
      setJoining(false);
    }
  };

  const videos = state?.videos ?? [];
  if (videos.length === 0 && !live && !liveUrl) return null;

  return (
    <section className="mx-auto w-full max-w-5xl px-4 pt-8" aria-label="Video from your technician">
      {liveUrl ? (
        <div className="mb-6 space-y-3">
          <LiveVideoFrame url={liveUrl} title="Live video estimate" />
          <Button size="sm" variant="secondary" onClick={() => setLiveUrl(null)}>
            Leave call
          </Button>
        </div>
      ) : live ? (
        <div role="status" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/40 bg-accent/10 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Radio size={16} className="text-accent" aria-hidden="true" /> Your technician is live now and ready to go over your estimate.
          </p>
          <Button size="sm" onClick={() => void join()} disabled={joining}>
            {joining ? 'Joining…' : 'Join video estimate'}
          </Button>
          {joinError ? (
            <p role="alert" className="w-full text-sm text-danger">
              {joinError}
            </p>
          ) : null}
        </div>
      ) : null}

      {videos.length > 0 ? (
        <>
          <h2 className="mb-3 text-base font-semibold text-text-primary">A message about your estimate</h2>
          <ul className="space-y-4">
            {videos.map((v) => (
              <PublicVideoItem
                key={v.id}
                token={token}
                video={v}
                customerName={customerName ?? ''}
                quoteOpen={quoteOpen}
                onUrlExpired={() => void load()}
              />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
