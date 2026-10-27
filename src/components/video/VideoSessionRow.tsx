import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, ExternalLink, Loader2, PhoneOff, Video } from 'lucide-react';
import { ClipPlayer } from '@/components/video/ClipPlayer';
import {
  STATUS_META,
  buildJoinUrl,
  effectiveStatus,
  expiresInLabel,
  formatDuration,
  friendlyVideoError,
  isJoinable,
  type VideoClipRow,
  type VideoSessionRow,
} from '@/lib/videoSession';
import { endVideoSession } from '@/lib/videoSessionApi';

const TONE: Record<string, string> = {
  success: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-tertiary text-text-secondary',
};

interface Props {
  session: VideoSessionRow;
  clips: VideoClipRow[];
  title?: string;
  subtitle?: string;
  canEnd: boolean;
  canDeleteClips: boolean;
  onChanged: () => void;
}

export function VideoSessionRow({ session, clips, title, subtitle, canEnd, canDeleteClips, onChanged }: Props) {
  const [copied, setCopied] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = effectiveStatus(session);
  const meta = STATUS_META[status];
  const joinable = isJoinable(status);
  const url = buildJoinUrl(window.location.origin, session.join_token);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this link', url);
    }
  };

  const end = async () => {
    if (!window.confirm('End this session for everyone?')) return;
    setEnding(true);
    setError(null);
    try {
      await endVideoSession(session.join_token);
      onChanged();
    } catch (err) {
      setError(friendlyVideoError(err));
    } finally {
      setEnding(false);
    }
  };

  return (
    <li className="rounded-xl border border-border/70 bg-bg-primary p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
            <Video size={14} className="shrink-0 text-text-secondary" aria-hidden="true" />
            <span className="truncate">{title ?? session.title}</span>
          </p>
          <p className="mt-0.5 text-xs text-text-secondary">
            {[
              subtitle,
              session.expert_name ? `Expert: ${session.expert_name}` : session.expert_label ? `For ${session.expert_label}` : null,
              new Date(session.created_at).toLocaleString(),
              session.duration_seconds ? formatDuration(session.duration_seconds) : status === 'waiting' ? expiresInLabel(session.expires_at) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[meta.tone]}`}>{meta.label}</span>
      </div>

      {joinable && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Link to={`/live/${session.join_token}`} className="focus-ring inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-white hover:brightness-110">
            <ExternalLink size={12} aria-hidden="true" /> {status === 'live' ? 'Rejoin' : 'Open session'}
          </Link>
          <button type="button" onClick={() => void copy()} className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary">
            {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />} {copied ? 'Copied' : 'Copy expert link'}
          </button>
          {canEnd && (
            <button type="button" onClick={() => void end()} disabled={ending} className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger/5 disabled:opacity-60">
              {ending ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <PhoneOff size={12} aria-hidden="true" />} End
            </button>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-1.5 text-xs text-danger">{error}</p>}

      {clips.length > 0 && (
        <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
          {clips.map((c) => (
            <ClipPlayer key={c.id} clip={c} canDelete={canDeleteClips} onDeleted={onChanged} />
          ))}
        </div>
      )}
    </li>
  );
}
