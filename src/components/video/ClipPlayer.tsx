import { useState } from 'react';
import { Download, Loader2, Play, Trash2 } from 'lucide-react';
import { formatBytes, formatDuration, type VideoClipRow } from '@/lib/videoSession';
import { deleteClip, getClipUrl } from '@/lib/videoSessionApi';
import { friendlyVideoError } from '@/lib/videoSession';

/** Loads a short-lived signed URL only when the user asks to play (no wasted signing for long lists). */
export function ClipPlayer({ clip, canDelete, onDeleted }: { clip: VideoClipRow; canDelete: boolean; onDeleted?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<'open' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setBusy('open');
    setError(null);
    try {
      setUrl(await getClipUrl(clip.storage_path));
    } catch {
      setError('Could not open this clip. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this clip permanently? This cannot be undone.')) return;
    setBusy('delete');
    setError(null);
    try {
      await deleteClip(clip.id);
      onDeleted?.();
    } catch (err) {
      setError(friendlyVideoError(err));
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-border/70 bg-bg-primary p-2.5">
      {url ? (
        <video src={url} controls playsInline preload="metadata" className="aspect-video w-full rounded-lg bg-black" aria-label="Recorded clip" />
      ) : (
        <button
          type="button"
          onClick={() => void open()}
          disabled={busy !== null}
          className="focus-ring flex aspect-video w-full items-center justify-center gap-2 rounded-lg bg-bg-tertiary text-sm font-medium text-text-primary hover:bg-bg-tertiary/70 disabled:opacity-60"
        >
          {busy === 'open' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          Play clip · {formatDuration(clip.duration_seconds)}
        </button>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary">
        <span>{new Date(clip.created_at).toLocaleString()}</span>
        <span>{formatBytes(clip.size_bytes)}</span>
        {clip.recorded_by_name && <span>by {clip.recorded_by_name}</span>}
        <span className="ml-auto flex items-center gap-2">
          {url && (
            <a href={url} download className="focus-ring inline-flex items-center gap-1 rounded text-text-secondary hover:text-accent">
              <Download size={12} aria-hidden="true" /> Download
            </a>
          )}
          {canDelete && (
            <button type="button" onClick={() => void remove()} disabled={busy !== null} className="focus-ring inline-flex items-center gap-1 rounded text-text-secondary hover:text-danger disabled:opacity-60">
              {busy === 'delete' ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Trash2 size={12} aria-hidden="true" />} Delete
            </button>
          )}
        </span>
      </div>
      {error && <p role="alert" className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}
