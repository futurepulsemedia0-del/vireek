import { useRef, useState } from 'react';
import { AlertTriangle, Camera, CameraOff, Check, Circle, Copy, Loader2, Mic, MicOff, PhoneOff, RefreshCw, Share2, Square, SwitchCamera, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useStream } from '@/components/video/VideoLobby';
import type { ClipState } from '@/hooks/useVideoCall';
import type { EngineSnapshot } from '@/lib/videoCallEngine';
import { buildJoinUrl, buildShare, formatDuration, type PublicSession } from '@/lib/videoSession';

interface Props {
  session: PublicSession;
  token: string;
  snap: EngineSnapshot;
  relay: boolean;
  clip: ClipState;
  gate: { ok: boolean; reason: string | null };
  onMic: (on: boolean) => void;
  onCamera: (on: boolean) => void;
  onFlip: () => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onRetryClip: () => void;
  onDismissClip: () => void;
  onDownloadClip: () => void;
  onEnd: () => void;
  onLeave: () => void;
}

const QUALITY: Record<EngineSnapshot['quality'], { label: string; cls: string }> = {
  good: { label: 'Good connection', cls: 'bg-success-500/90' },
  fair: { label: 'Fair connection', cls: 'bg-warning-500/90' },
  poor: { label: 'Poor connection', cls: 'bg-danger/90' },
  unknown: { label: 'Connecting', cls: 'bg-white/20' },
};

function RoundButton({ label, onClick, active, danger, disabled, children }: { label: string; onClick: () => void; active?: boolean; danger?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`focus-ring flex h-12 w-12 items-center justify-center rounded-full text-white transition-colors disabled:opacity-40 ${danger ? 'bg-danger hover:brightness-110' : active ? 'bg-white text-black' : 'bg-white/15 hover:bg-white/25'}`}
    >
      {children}
    </button>
  );
}

export function VideoCallRoom(p: Props) {
  const { session, snap } = p;
  const remoteRef = useRef<HTMLVideoElement>(null);
  const localRef = useRef<HTMLVideoElement>(null);
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useStream(remoteRef, snap.remoteStream);
  useStream(localRef, snap.localStream);

  const isTech = session.role === 'technician';
  const link = buildJoinUrl(window.location.origin, p.token);
  const waiting = snap.phase === 'waiting' || snap.phase === 'connecting';
  const connected = snap.phase === 'connected';
  const q = QUALITY[snap.quality];
  const recording = snap.recording === 'recording';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this link', link);
    }
  };
  const share = async () => {
    const msg = buildShare(link, { business: session.business_name, title: session.title });
    if (navigator.share) {
      try {
        await navigator.share({ title: session.title, text: msg.text, url: link });
        return;
      } catch {
        /* cancelled: fall through to copy */
      }
    }
    void copy();
  };

  return (
    <div className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-black text-white">
      <video ref={remoteRef} autoPlay playsInline className="absolute inset-0 h-full w-full bg-black object-contain" aria-label="Remote video" />

      {/* top bar */}
      <div className="relative z-10 flex items-start justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 pb-6 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{session.title}</p>
          <p className="truncate text-xs text-white/70">{snap.remoteName ? `With ${snap.remoteName}` : isTech ? 'Waiting for the expert' : 'Waiting for the technician'}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {connected && (
            <span className={`flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium ${q.cls}`} role="status">
              <Wifi size={11} aria-hidden="true" /> {q.label}
            </span>
          )}
          {(recording || snap.remoteRecording) && (
            <span className="flex items-center gap-1.5 rounded-full bg-danger px-2.5 py-1 text-[11px] font-semibold" role="status">
              <Circle size={8} className="animate-pulse fill-white" aria-hidden="true" />
              {recording ? `REC ${formatDuration(snap.recordingSeconds)}` : 'This session is being recorded'}
            </span>
          )}
          {!p.relay && connected && snap.quality === 'poor' && <span className="rounded-full bg-black/60 px-2 py-1 text-[10px] text-white/80">Relay not configured</span>}
        </div>
      </div>

      {/* state overlays */}
      <div className="pointer-events-none relative z-10 flex flex-1 items-center justify-center px-6">
        {waiting && (
          <div className="pointer-events-auto w-full max-w-sm rounded-2xl bg-black/70 p-5 text-center backdrop-blur">
            <Loader2 className="mx-auto animate-spin" size={20} aria-hidden="true" />
            <p className="mt-3 text-base font-semibold">{isTech ? 'Waiting for the expert to join' : 'Waiting for the technician'}</p>
            {isTech ? (
              <>
                <p className="mt-1 break-all text-xs text-white/60">{link}</p>
                <div className="mt-4 flex justify-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy link'}</Button>
                  <Button variant="secondary" size="sm" onClick={() => void share()}><Share2 size={14} /> Share</Button>
                </div>
              </>
            ) : (
              <p className="mt-1 text-sm text-white/70">You will be connected as soon as they are here.</p>
            )}
          </div>
        )}
        {snap.phase === 'negotiating' && (
          <p className="rounded-full bg-black/70 px-4 py-2 text-sm" role="status"><Loader2 className="mr-2 inline animate-spin" size={14} aria-hidden="true" />Connecting video…</p>
        )}
        {snap.phase === 'reconnecting' && (
          <p className="rounded-full bg-warning-500/90 px-4 py-2 text-sm font-medium text-black" role="status"><WifiOff className="mr-2 inline" size={14} aria-hidden="true" />Connection lost. Reconnecting…</p>
        )}
        {snap.phase === 'failed' && (
          <div className="pointer-events-auto max-w-sm rounded-2xl bg-black/80 p-5 text-center" role="alert">
            <AlertTriangle className="mx-auto text-warning-500" size={26} aria-hidden="true" />
            <p className="mt-2 font-semibold">We could not keep the connection</p>
            <p className="mt-1 text-sm text-white/70">Your network may block video. Switch between Wi-Fi and mobile data, then rejoin.</p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => window.location.reload()}><RefreshCw size={14} /> Rejoin</Button>
          </div>
        )}
        {!snap.signalingOk && snap.phase !== 'failed' && (
          <p className="absolute bottom-2 rounded-full bg-black/70 px-3 py-1 text-xs" role="status">Reconnecting to the session…</p>
        )}
      </div>

      {/* local preview */}
      {snap.localStream && snap.hasCamera && (
        <video
          ref={localRef}
          autoPlay
          muted
          playsInline
          aria-label="Your camera"
          className={`absolute right-3 top-[max(5rem,calc(env(safe-area-inset-top)+4rem))] z-20 h-28 w-20 rounded-xl border border-white/30 bg-black object-cover shadow-lg sm:h-36 sm:w-28 ${snap.cameraOn ? '' : 'opacity-30'} ${isTech ? '' : '-scale-x-100'}`}
        />
      )}

      {/* clip status */}
      {p.clip.status !== 'idle' && (
        <div className="absolute inset-x-3 bottom-28 z-30 mx-auto max-w-sm rounded-xl bg-black/85 p-3 text-sm backdrop-blur" role="status">
          {p.clip.status === 'uploading' && <p className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Saving clip to the job timeline…</p>}
          {p.clip.status === 'saved' && (
            <p className="flex items-center justify-between gap-2"><span className="flex items-center gap-2"><Check size={14} className="text-success-500" /> Clip saved to the job timeline.</span><button type="button" className="focus-ring rounded text-xs text-white/70 underline" onClick={p.onDismissClip}>Dismiss</button></p>
          )}
          {p.clip.status === 'error' && (
            <div>
              <p className="flex items-start gap-2 text-danger"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> {p.clip.message}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={p.onRetryClip}><RefreshCw size={14} /> Try again</Button>
                <Button size="sm" variant="ghost" onClick={p.onDownloadClip}>Download copy</Button>
              </div>
            </div>
          )}
        </div>
      )}
      {snap.recordError && <p role="alert" className="absolute inset-x-3 bottom-28 z-30 mx-auto max-w-sm rounded-xl bg-danger/90 p-3 text-sm">{snap.recordError}</p>}

      {/* controls */}
      <div className="relative z-20 flex flex-col items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6">
        {isTech && !p.gate.ok && p.gate.reason && connected && <p className="text-[11px] text-white/60">{p.gate.reason}</p>}
        <div className="flex items-center gap-3">
          <RoundButton label={snap.micOn ? 'Mute microphone' : 'Unmute microphone'} active={!snap.micOn} disabled={!snap.hasMic} onClick={() => p.onMic(!snap.micOn)}>
            {snap.micOn && snap.hasMic ? <Mic size={20} /> : <MicOff size={20} />}
          </RoundButton>
          <RoundButton label={snap.cameraOn ? 'Turn camera off' : 'Turn camera on'} active={!snap.cameraOn} disabled={!snap.hasCamera} onClick={() => p.onCamera(!snap.cameraOn)}>
            {snap.cameraOn && snap.hasCamera ? <Camera size={20} /> : <CameraOff size={20} />}
          </RoundButton>
          {snap.canFlip && (
            <RoundButton label="Switch camera" disabled={recording} onClick={p.onFlip}><SwitchCamera size={20} /></RoundButton>
          )}
          {isTech && (
            recording ? (
              <RoundButton label="Stop and save recording" danger onClick={p.onStopRecording}><Square size={18} className="fill-white" /></RoundButton>
            ) : (
              <RoundButton label={p.gate.ok ? 'Record a clip' : p.gate.reason ?? 'Recording unavailable'} disabled={!p.gate.ok} onClick={() => { setConfirmed(false); setConfirmOpen(true); }}>
                <Circle size={20} className="fill-danger text-danger" />
              </RoundButton>
            )
          )}
          <RoundButton label={isTech ? 'End session for everyone' : 'Leave session'} danger onClick={isTech ? p.onEnd : p.onLeave}><PhoneOff size={20} /></RoundButton>
        </div>
      </div>

      {/* recording confirmation */}
      {confirmOpen && (
        <div className="absolute inset-0 z-40 flex items-end justify-center bg-black/60 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="rec-title">
          <div className="w-full max-w-sm rounded-2xl bg-bg-secondary p-5 text-text-primary">
            <h2 id="rec-title" className="text-lg font-semibold">Record a clip?</h2>
            <p className="mt-1 text-sm text-text-secondary">Your camera view and the conversation are saved to this job (up to 5 minutes per clip). {snap.remoteName ?? 'The expert'} has agreed and will see a recording indicator.</p>
            <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="focus-ring mt-0.5 h-4 w-4 accent-[var(--color-accent,#2563eb)]" />
              <span>I have told the customer and anyone on site that this is being recorded.</span>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>Cancel</Button>
              <Button size="sm" disabled={!confirmed} onClick={() => { setConfirmOpen(false); p.onStartRecording(); }}>Start recording</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
