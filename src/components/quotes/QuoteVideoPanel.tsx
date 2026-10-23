/**
 * Technician side of Video Quotes (rendered on /dashboard/quotes/:id).
 *  - record or upload a short explanation, preview it, then share it with the customer
 *  - see exactly what the customer did (opened / watched % / acknowledged)
 *  - start an optional live video estimate (Daily.co) the customer joins from the quote link
 *  - owner-only retention setting
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, RefreshCw, Trash2, Video as VideoIcon, Radio, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  MAX_VIDEOS_PER_QUOTE,
  RETENTION_CHOICES,
  describeEngagement,
  formatBytes,
  formatDuration,
  type QuoteVideoRow,
  type WatchTone,
} from '@/lib/quoteVideo';
import {
  deleteQuoteVideo,
  endLiveEstimate,
  getQuoteVideoRetentionDays,
  listQuoteVideos,
  setQuoteVideoRetentionDays,
  setQuoteVideoShared,
  signQuoteVideoPreview,
  startLiveEstimate,
  uploadQuoteVideo,
  type LiveSessionInfo,
} from '@/lib/quoteVideoApi';
import { LiveVideoFrame } from '@/components/quotes/LiveVideoFrame';
import { QuoteVideoCapture, type CapturedVideo } from '@/components/quotes/QuoteVideoCapture';

const SECTION = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const TONE: Record<WatchTone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  warning: 'bg-warning-500/10 text-warning-500',
  success: 'bg-success-500/10 text-success-500',
};

interface Props {
  quoteId: string;
  quoteStatus: string;
  customerName: string | null;
}

type Draft = CapturedVideo & { previewUrl: string };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Please try again.';
}

export function QuoteVideoPanel({ quoteId, quoteStatus, customerName }: Props) {
  const { accountOwnerId, isOwner, teamMember } = useAuth();
  const { toast } = useToast();

  const [videos, setVideos] = useState<QuoteVideoRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState('Explanation of findings');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [retention, setRetention] = useState<number | null>(null);
  const [live, setLive] = useState<LiveSessionInfo | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const requestRef = useRef(0);

  const open = quoteStatus === 'draft' || quoteStatus === 'sent';
  const atLimit = (videos?.length ?? 0) >= MAX_VIDEOS_PER_QUOTE;

  const load = useCallback(async () => {
    const id = ++requestRef.current;
    try {
      const rows = await listQuoteVideos(quoteId);
      if (id === requestRef.current) {
        setVideos(rows);
        setLoadError(false);
      }
    } catch {
      if (id === requestRef.current) setLoadError(true);
    }
  }, [quoteId]);

  useEffect(() => {
    void load();
    void getQuoteVideoRetentionDays().then(setRetention).catch(() => undefined);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      requestRef.current++;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // Free the blob URL of a discarded / replaced draft.
  useEffect(() => {
    return () => {
      if (draft) URL.revokeObjectURL(draft.previewUrl);
    };
  }, [draft]);

  const handleCaptured = (video: CapturedVideo) => {
    setDraft({ ...video, previewUrl: URL.createObjectURL(video.blob) });
    setTitle('Explanation of findings');
    setNote('');
  };

  const handleSave = async () => {
    if (!draft || !accountOwnerId) return;
    setSaving(true);
    try {
      await uploadQuoteVideo({
        ownerId: accountOwnerId,
        quoteId,
        blob: draft.blob,
        fileName: draft.fileName,
        title,
        note,
        durationSeconds: draft.durationSeconds,
      });
      setDraft(null);
      toast('Video saved. Preview it, then share it with the customer.', 'success');
      await load();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const togglePreview = async (video: QuoteVideoRow) => {
    if (previews[video.id]) {
      setPreviews(({ [video.id]: _removed, ...rest }) => rest);
      return;
    }
    setBusyId(video.id);
    try {
      const url = await signQuoteVideoPreview(video.storage_path);
      setPreviews((p) => ({ ...p, [video.id]: url }));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const toggleShared = async (video: QuoteVideoRow) => {
    setBusyId(video.id);
    try {
      await setQuoteVideoShared(video.id, !video.shared);
      toast(video.shared ? 'Hidden from the customer' : 'Shared with the customer', 'success');
      await load();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (video: QuoteVideoRow) => {
    if (confirmId !== video.id) {
      setConfirmId(video.id);
      window.setTimeout(() => setConfirmId((c) => (c === video.id ? null : c)), 4000);
      return;
    }
    setBusyId(video.id);
    setConfirmId(null);
    try {
      await deleteQuoteVideo(video.id);
      setPreviews(({ [video.id]: _removed, ...rest }) => rest);
      toast('Video deleted', 'success');
      await load();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleRetention = async (days: number) => {
    const previous = retention;
    setRetention(days);
    try {
      await setQuoteVideoRetentionDays(days);
      toast('Retention updated', 'success');
    } catch (e) {
      setRetention(previous);
      toast(errorText(e), 'error');
    }
  };

  const handleStartLive = async () => {
    setLiveBusy(true);
    try {
      setLive(await startLiveEstimate(quoteId, teamMember?.member_name?.trim() || 'Technician'));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setLiveBusy(false);
    }
  };

  const handleEndLive = async () => {
    if (!live) return;
    setLiveBusy(true);
    try {
      await endLiveEstimate(live.sessionId);
      setLive(null);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setLiveBusy(false);
    }
  };

  return (
    <section className={SECTION} aria-labelledby="qd-video">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="qd-video" className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <VideoIcon size={16} aria-hidden="true" /> Video explanation
        </h2>
        <Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Refresh videos">
          <RefreshCw size={14} aria-hidden="true" />
        </Button>
      </div>

      <p className="mb-4 text-sm text-text-secondary">
        Record a 1–2 minute walkthrough of what you found{customerName ? ` for ${customerName}` : ''}. The customer watches it on their quote
        page and approves there. Nothing is visible to them until you share it.
      </p>

      {/* ---------- add ---------- */}
      {!open ? (
        <p className="mb-4 rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-secondary">
          This quote has been answered, so new videos can no longer be added.
        </p>
      ) : atLimit ? (
        <p className="mb-4 rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-secondary">
          This quote has {MAX_VIDEOS_PER_QUOTE} videos, the maximum. Delete one to add another.
        </p>
      ) : draft ? (
        <div className="mb-4 space-y-3 rounded-xl border border-border bg-bg-primary p-3">
          <video src={draft.previewUrl} controls playsInline className="aspect-video w-full rounded-lg bg-black" aria-label="Recorded video preview" />
          <p className="text-xs text-text-secondary">
            {formatDuration(draft.durationSeconds)} · {formatBytes(draft.blob.size)}
          </p>
          <Input id="qv-title" label="Title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          <Textarea
            id="qv-note"
            label="Note for the customer (optional)"
            value={note}
            maxLength={1000}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void handleSave()} disabled={saving || !accountOwnerId}>
              {saving ? 'Uploading…' : 'Save video'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setDraft(null)} disabled={saving}>
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <div className="mb-4">
          <QuoteVideoCapture onCaptured={handleCaptured} />
        </div>
      )}

      {/* ---------- list ---------- */}
      {loadError ? (
        <p role="alert" className="text-sm text-danger">
          Could not load videos. <button className="underline" onClick={() => void load()}>Try again</button>
        </p>
      ) : videos === null ? (
        <p role="status" className="text-sm text-text-secondary">Loading videos…</p>
      ) : videos.length === 0 ? (
        <p className="text-sm text-text-secondary">No videos yet.</p>
      ) : (
        <ul className="space-y-3">
          {videos.map((v) => {
            const eng = describeEngagement(v);
            const busy = busyId === v.id;
            return (
              <li key={v.id} className="rounded-xl border border-border bg-bg-primary p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold text-text-primary">{v.title}</p>
                    <p className="text-xs text-text-secondary">
                      {formatDuration(v.duration_seconds)} · {formatBytes(v.size_bytes)}
                    </p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${TONE[eng.tone]}`}>{eng.label}</span>
                </div>
                {previews[v.id] ? (
                  <video src={previews[v.id]} controls playsInline preload="metadata" className="mt-3 aspect-video w-full rounded-lg bg-black" aria-label={`Preview: ${v.title}`} />
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void togglePreview(v)} disabled={busy}>
                    {previews[v.id] ? 'Hide preview' : 'Preview'}
                  </Button>
                  <Button size="sm" variant={v.shared ? 'secondary' : 'primary'} onClick={() => void toggleShared(v)} disabled={busy}>
                    {v.shared ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                    {v.shared ? 'Hide from customer' : 'Share with customer'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void handleDelete(v)} disabled={busy}>
                    <Trash2 size={14} aria-hidden="true" /> {confirmId === v.id ? 'Click again to confirm' : 'Delete'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ---------- live ---------- */}
      <div className="mt-5 border-t border-border pt-4">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Radio size={14} aria-hidden="true" /> Live video estimate
        </h3>
        {live ? (
          <div className="space-y-3">
            <LiveVideoFrame url={live.url} title="Live video estimate" />
            <Button size="sm" variant="secondary" onClick={() => void handleEndLive()} disabled={liveBusy}>
              <PhoneOff size={14} aria-hidden="true" /> End session
            </Button>
          </div>
        ) : (
          <>
            <p className="mb-2 text-xs text-text-secondary">
              {quoteStatus === 'draft'
                ? 'Send the quote first: the customer joins from the link in their quote page.'
                : 'Start a call, then ask the customer to open their quote link — a Join button appears. Calls are not recorded.'}
            </p>
            <Button size="sm" variant="secondary" onClick={() => void handleStartLive()} disabled={liveBusy || !open}>
              {liveBusy ? 'Starting…' : 'Start live video estimate'}
            </Button>
          </>
        )}
      </div>

      {/* ---------- retention (owner) ---------- */}
      {isOwner && retention !== null ? (
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4 text-sm text-text-secondary">
          <label htmlFor="qv-retention">Keep videos for</label>
          <select
            id="qv-retention"
            value={retention}
            onChange={(e) => void handleRetention(Number(e.target.value))}
            className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
          >
            {RETENTION_CHOICES.some((c) => c.days === retention) ? null : <option value={retention}>{retention} days</option>}
            {RETENTION_CHOICES.map((c) => (
              <option key={c.days} value={c.days}>{c.label}</option>
            ))}
          </select>
          <span className="text-xs">after the customer responds. Then the file is permanently deleted.</span>
        </div>
      ) : null}
    </section>
  );
}
