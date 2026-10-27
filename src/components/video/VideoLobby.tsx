import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, CameraOff, Loader2, Mic, MicOff, Video } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { EngineSnapshot } from '@/lib/videoCallEngine';
import { expiresInLabel, validateDisplayName, type PublicSession } from '@/lib/videoSession';

export function useStream(ref: React.RefObject<HTMLVideoElement>, stream: MediaStream | null) {
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [ref, stream]);
}

interface Props {
  session: PublicSession;
  snap: EngineSnapshot;
  joining: boolean;
  error: string | null;
  onJoin: (name: string, consent: boolean) => void;
  onMic: (on: boolean) => void;
  onCamera: (on: boolean) => void;
}

/** Pre-join screen: device preview, name, recording consent. Doubles as the user gesture mobile browsers need. */
export function VideoLobby({ session, snap, joining, error, onJoin, onMic, onCamera }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState(false);
  useStream(videoRef, snap.localStream);

  const isExpert = session.role === 'expert';
  const nameError = isExpert && touched ? validateDisplayName(name) : null;
  const preparing = snap.phase === 'preparing' || snap.phase === 'idle';

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col justify-center gap-5 px-4 py-8 pb-[max(2rem,env(safe-area-inset-bottom))]">
      <header className="text-center">
        <p className="text-xs font-medium text-text-secondary">{session.business_name ?? 'Live video session'}</p>
        <h1 className="mt-1 text-2xl font-bold text-text-primary">{session.title}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {isExpert
            ? `${session.technician_name ?? 'A technician'} invited${session.expert_label ? ` you as ${session.expert_label}` : ' you'} to help remotely.`
            : 'Check your camera and microphone, then join. The expert connects when they open the link.'}
        </p>
        <p className="mt-1 text-xs text-text-secondary">{expiresInLabel(session.expires_at)}</p>
      </header>

      <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-border bg-black">
        {snap.localStream && snap.hasCamera && snap.cameraOn ? (
          <video ref={videoRef} autoPlay muted playsInline className="h-full w-full -scale-x-100 object-cover" aria-label="Your camera preview" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-white/70">
            {preparing ? <Loader2 className="animate-spin" size={20} aria-hidden="true" /> : <CameraOff size={28} aria-hidden="true" />}
            <p className="px-6 text-center text-sm">{preparing ? 'Allow camera and microphone when your browser asks…' : 'Camera is off'}</p>
          </div>
        )}
        <div className="absolute inset-x-0 bottom-3 flex justify-center gap-3">
          <button type="button" onClick={() => onMic(!snap.micOn)} disabled={!snap.hasMic} aria-pressed={!snap.micOn} aria-label={snap.micOn ? 'Mute microphone' : 'Unmute microphone'} className="focus-ring flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white disabled:opacity-40">
            {snap.micOn && snap.hasMic ? <Mic size={18} /> : <MicOff size={18} />}
          </button>
          <button type="button" onClick={() => onCamera(!snap.cameraOn)} disabled={!snap.hasCamera} aria-pressed={!snap.cameraOn} aria-label={snap.cameraOn ? 'Turn camera off' : 'Turn camera on'} className="focus-ring flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white disabled:opacity-40">
            {snap.cameraOn && snap.hasCamera ? <Camera size={18} /> : <CameraOff size={18} />}
          </button>
        </div>
      </div>

      {snap.mediaIssue && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-xs text-text-primary">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
          {snap.mediaIssue.message} You can still join and watch or listen.
        </p>
      )}

      {isExpert && (
        <div className="space-y-3">
          <Input id="vs-name" label="Your name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} placeholder="e.g. Sam from Carrier support" maxLength={60} autoComplete="name" error={nameError ?? undefined} required />
          {session.recording_allowed && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-primary">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="focus-ring mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent,#2563eb)]" />
              <span>
                I agree the technician may record this session (video and audio) and save it to the job record.
                <span className="mt-0.5 block text-xs text-text-secondary">Optional. You will see a clear indicator whenever recording is on.</span>
              </span>
            </label>
          )}
        </div>
      )}

      {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}

      <Button size="lg" onClick={() => { setTouched(true); onJoin(name, consent); }} disabled={joining || preparing} className="w-full">
        {joining ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <Video size={18} aria-hidden="true" />}
        {joining ? 'Joining…' : isExpert ? 'Join session' : 'Start session'}
      </Button>
    </div>
  );
}
