import { useCallback, useEffect, useRef, useState } from 'react';
import { LIVE_LIMITS, frameToBlob } from '@/lib/liveCopilot';
import { toWav16kMono } from '@/lib/fieldEstimate';

export type CameraStatus = 'idle' | 'starting' | 'live' | 'error';

export interface LiveClip {
  /** Original recording (WebM / MP4) - what Expert Assist accepts. */
  raw: Blob;
  /** 16 kHz mono WAV - what the AI accepts reliably. */
  wav: Blob;
  seconds: number;
}

type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };

/**
 * Owns the phone camera + microphone for a Live Copilot session.
 *
 * Audio is captured with echo-cancellation, noise-suppression and auto-gain
 * OFF on purpose: those filters are tuned for speech and would suppress the
 * very compressor / bearing / relay noise the copilot needs to hear.
 */
export function useLiveCapture() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const clipSecondsRef = useRef(0);

  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [clip, setClip] = useState<LiveClip | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const acquireWakeLock = useCallback(async () => {
    try {
      wakeLockRef.current = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      wakeLockRef.current = null; // not supported / denied - purely a convenience
    }
  }, []);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const stop = useCallback(() => {
    clearTimer();
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null; // discard - the session is being torn down
      rec.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    setRecording(false);
    setTorchOn(false);
    setTorchSupported(false);
    setStatus('idle');
  }, []);

  const start = useCallback(async () => {
    if (streamRef.current) return;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('error');
      setError('This browser cannot access the camera (HTTPS is required). Open Vireek in Chrome or Safari.');
      return;
    }
    setStatus('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      const track = stream.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() ?? {}) as TorchCapabilities;
      setTorchSupported(Boolean(caps.torch));
      await acquireWakeLock();
      setStatus('live');
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      setStatus('error');
      setError(
        name === 'NotAllowedError'
          ? 'Camera / microphone access was blocked. Allow it in your browser settings and try again.'
          : name === 'NotFoundError'
            ? 'No camera was found on this device.'
            : 'Could not start the camera. Close other apps that may be using it and try again.',
      );
    }
  }, [acquireWakeLock]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as unknown as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
    }
  }, [torchOn]);

  const captureFrame = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    return video && streamRef.current ? frameToBlob(video) : null;
  }, []);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    const audioTracks = stream?.getAudioTracks() ?? [];
    if (!audioTracks.length || typeof MediaRecorder === 'undefined') {
      setError('The microphone is not available. Check permissions and try again.');
      return;
    }
    setError(null);
    setClip(null);
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(new MediaStream(audioTracks), mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      clearTimer();
      setRecording(false);
      const raw = chunksRef.current.length
        ? new Blob(chunksRef.current, { type: rec.mimeType || mimeType || 'audio/webm' })
        : null;
      if (!raw || raw.size < 1000) return;
      setProcessing(true);
      void toWav16kMono(raw)
        .then((wav) => setClip({ raw, wav, seconds: clipSecondsRef.current }))
        .catch(() => setError('Could not process that recording. Try again.'))
        .finally(() => setProcessing(false));
    };
    recorderRef.current = rec;
    rec.start();
    clipSecondsRef.current = 0;
    setElapsed(0);
    setRecording(true);
    timerRef.current = window.setInterval(() => {
      clipSecondsRef.current += 1;
      setElapsed(clipSecondsRef.current);
    }, 1000);
  }, []);

  // Hard stop at the max clip length.
  useEffect(() => {
    if (recording && elapsed >= LIVE_LIMITS.audioSeconds) stopRecording();
  }, [recording, elapsed, stopRecording]);

  // Re-acquire the screen wake lock when the tab becomes visible again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && streamRef.current) void acquireWakeLock();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [acquireWakeLock]);

  // Always release camera + mic on unmount.
  useEffect(() => stop, [stop]);

  return {
    videoRef,
    status,
    error,
    recording,
    processing,
    elapsed,
    clip,
    clearClip: () => setClip(null),
    torchSupported,
    torchOn,
    start,
    stop,
    toggleTorch,
    captureFrame,
    startRecording,
    stopRecording,
  };
}
