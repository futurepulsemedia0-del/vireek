/**
 * Records a short video with the device camera (MediaRecorder) or picks a file.
 * Output is handed to onCaptured(); nothing is uploaded here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Circle, Square, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { probeDuration } from '@/lib/fieldEstimate';
import {
  MAX_RECORD_SECONDS,
  formatDuration,
  pickRecorderMime,
  uploadErrorMessage,
  validateUpload,
} from '@/lib/quoteVideo';

export interface CapturedVideo {
  blob: Blob;
  fileName?: string;
  durationSeconds: number | null;
}

interface Props {
  onCaptured: (video: CapturedVideo) => void;
  disabled?: boolean;
}

type Phase = 'idle' | 'starting' | 'recording';

export function QuoteVideoCapture({ onCaptured, disabled = false }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const previewRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    recorderRef.current = null;
    setStream((s) => {
      s?.getTracks().forEach((t) => t.stop());
      return null;
    });
  }, []);

  // Release the camera if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      const rec = recorderRef.current;
      if (rec) rec.onstop = null;
      cleanup();
    };
  }, [cleanup]);

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = stream;
  }, [stream]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const start = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Recording is not supported in this browser. Use "Upload a video" instead.');
      return;
    }
    setPhase('starting');
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
    } catch (e) {
      setPhase('idle');
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      setError(
        denied
          ? 'Camera or microphone access was blocked. Allow it in your browser settings, or upload a video instead.'
          : 'Could not start the camera. Upload a video instead.',
      );
      return;
    }

    const mimeType = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(media, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 64_000,
    });
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const seconds = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || mimeType || 'video/webm' });
      chunksRef.current = [];
      cleanup();
      setPhase('idle');
      setElapsed(0);
      const check = validateUpload({ type: blob.type, sizeBytes: blob.size, durationSeconds: seconds });
      if (!check.ok) {
        setError(uploadErrorMessage(check.code));
        return;
      }
      onCaptured({ blob, durationSeconds: seconds });
    };

    recorderRef.current = rec;
    setStream(media);
    startedAtRef.current = Date.now();
    rec.start(1000);
    setPhase('recording');
    timerRef.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setElapsed(s);
      if (s >= MAX_RECORD_SECONDS) stop();
    }, 250);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const duration = await probeDuration(file, 'video');
    const check = validateUpload({ type: file.type, fileName: file.name, sizeBytes: file.size, durationSeconds: duration });
    if (!check.ok) {
      setError(uploadErrorMessage(check.code));
      return;
    }
    onCaptured({ blob: file, fileName: file.name, durationSeconds: duration });
  };

  return (
    <div className="space-y-3">
      {phase !== 'idle' ? (
        <div className="overflow-hidden rounded-xl border border-border bg-black">
          <video ref={previewRef} muted playsInline autoPlay className="aspect-video w-full object-cover" aria-label="Camera preview" />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {phase === 'recording' ? (
          <>
            <Button size="sm" variant="primary" onClick={stop}>
              <Square size={14} aria-hidden="true" /> Stop
            </Button>
            <span role="timer" aria-live="off" className="text-sm font-semibold tabular-nums text-danger">
              <Circle size={10} className="mr-1 inline fill-current" aria-hidden="true" />
              {formatDuration(elapsed)} / {formatDuration(MAX_RECORD_SECONDS)}
            </span>
          </>
        ) : (
          <>
            <Button size="sm" onClick={() => void start()} disabled={disabled || phase === 'starting'}>
              <Circle size={14} aria-hidden="true" /> {phase === 'starting' ? 'Starting camera…' : 'Record video'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} disabled={disabled}>
              <Upload size={14} aria-hidden="true" /> Upload a video
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/*"
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
