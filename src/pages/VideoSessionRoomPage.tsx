import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Clock, LinkIcon, Loader2, VideoOff } from 'lucide-react';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { VideoLobby } from '@/components/video/VideoLobby';
import { VideoCallRoom } from '@/components/video/VideoCallRoom';
import { useVideoCall } from '@/hooks/useVideoCall';
import { formatDuration } from '@/lib/videoSession';

/** Public, token-gated page: /live/:token — used by the technician and by the remote expert. */
export function VideoSessionRoomPage() {
  const { token } = useParams<{ token: string }>();
  const call = useVideoCall(token);
  const { session, stage, snap } = call;

  useEffect(() => {
    const prev = document.title;
    document.title = session ? `${session.title} · Live video` : 'Live video session';
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.title = prev;
      meta.remove();
    };
  }, [session]);

  const shell = (children: React.ReactNode) => (
    <main className="flex min-h-[100dvh] items-center justify-center bg-bg-primary px-4 py-10">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );

  if (call.loadState === 'loading') {
    return shell(
      <div className="flex flex-col items-center gap-3 text-text-secondary" role="status" aria-live="polite">
        <Loader2 className="animate-spin" size={20} aria-hidden="true" />
        <p className="text-sm">Opening your session…</p>
      </div>,
    );
  }
  if (call.loadState === 'error') {
    return shell(<EmptyStateError icon={VideoOff} title="Could not open this session" description="Check your connection and try again." onRetry={call.retryLoad} />);
  }
  if (call.loadState === 'missing' || !session) {
    return shell(<EmptyState icon={LinkIcon} title="This link is not valid" description="It may be mistyped or incomplete. Ask the technician to send a new link." />);
  }
  if (session.status === 'expired') {
    return shell(<EmptyState icon={Clock} title="This link has expired" description="Ask the technician to start a new session and send you a fresh link." />);
  }
  if (session.status === 'cancelled') {
    return shell(<EmptyState icon={VideoOff} title="This session was cancelled" description="The technician closed it before anyone joined." />);
  }

  if (stage === 'ended') {
    const isTech = session.role === 'technician';
    return shell(
      <div className="space-y-4 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-success-500/10 text-success-500">
          <CheckCircle2 size={26} aria-hidden="true" />
        </span>
        <h1 className="text-xl font-bold text-text-primary">{isTech ? 'Session ended' : 'Thanks for helping out'}</h1>
        <p className="text-sm text-text-secondary">
          {session.duration_seconds ? `Call length ${formatDuration(session.duration_seconds)}. ` : ''}
          {isTech && call.savedCount > 0 ? `${call.savedCount} clip${call.savedCount > 1 ? 's' : ''} saved to the job timeline.` : isTech ? '' : 'You can close this page.'}
        </p>
        {isTech && session.job_id && (
          <Link to={`/dashboard/jobs/${session.job_id}`} className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">
            <ArrowLeft size={14} aria-hidden="true" /> Back to the job
          </Link>
        )}
        {isTech && call.clip.status === 'error' && <p className="text-xs text-danger">{call.clip.message}</p>}
      </div>,
    );
  }

  if (stage === 'lobby' || stage === 'joining') {
    return (
      <div className="bg-bg-primary">
        <VideoLobby session={session} snap={snap} joining={stage === 'joining'} error={call.joinError} onJoin={call.join} onMic={call.setMic} onCamera={call.setCamera} />
      </div>
    );
  }

  const downloadClip = () => {
    const pending = call.pendingClip;
    if (!pending) return;
    const url = URL.createObjectURL(pending.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-clip.${pending.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <>
      <VideoCallRoom
        session={session}
        token={token as string}
        snap={snap}
        relay={call.relay}
        clip={call.clip}
        gate={call.recordGate}
        onMic={call.setMic}
        onCamera={call.setCamera}
        onFlip={call.flipCamera}
        onStartRecording={() => void call.startRecording()}
        onStopRecording={() => call.stopRecording()}
        onRetryClip={call.retryUpload}
        onDismissClip={call.dismissClip}
        onDownloadClip={downloadClip}
        onEnd={() => void call.endSession()}
        onLeave={call.leave}
      />
      {call.joinError && <p role="alert" className="fixed inset-x-3 top-3 z-50 mx-auto max-w-sm rounded-xl bg-danger px-3 py-2 text-sm text-white">{call.joinError}</p>}
      <span className="sr-only" aria-live="polite">
        {snap.phase === 'connected' ? 'Connected' : snap.phase === 'reconnecting' ? 'Reconnecting' : ''}
      </span>
    </>
  );
}
