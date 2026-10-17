import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_VOICE_SECONDS, pickRecorderMime } from '@/lib/jobMessages';

export type RecorderState = 'idle' | 'recording' | 'unsupported' | 'denied';
export type RecorderError = 'unsupported' | 'denied' | 'unavailable' | 'too_short';

export interface RecordedClip {
  blob: Blob;
  durationMs: number;
  /** Container type without codec suffix, e.g. `audio/webm` (what storage allow-lists expect). */
  mime: string;
}
/** Alias used by the team chat code. */
export type VoiceResult = RecordedClip;

export const RECORDER_ERROR_COPY: Record<RecorderError, string> = {
  unsupported: 'Voice notes are not supported in this browser.',
  denied: 'Microphone access is blocked. Allow it in your browser settings to send voice notes.',
  unavailable: 'No microphone was found or it could not be used.',
  too_short: 'Hold a little longer — that voice note was too short.',
};

const MIN_CLIP_MS = 600;

export function isVoiceRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

/**
 * MediaRecorder wrapper: auto-stops at MAX_VOICE_SECONDS, always releases the mic
 * (stop, cancel, error, unmount — including unmounting while the permission prompt is open),
 * ignores double starts, supports cancel.
 *
 * Backwards compatible: `state`, `elapsed` (seconds), `start`, `stop`, `cancel` and
 * `onClip({ blob, durationMs })` behave as before; `mime`, `elapsedMs`, `error`, `starting`
 * and `clearError` are additions.
 */
export function useVoiceRecorder(onClip: (clip: RecordedClip) => void) {
  const supported = isVoiceRecordingSupported();
  const [state, setState] = useState<RecorderState>(supported ? 'idle' : 'unsupported');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<RecorderError | null>(null);
  const [starting, setStarting] = useState(false);

  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(0);
  const cancelledRef = useRef(false);
  const startingRef = useRef(false);
  const aliveRef = useRef(true);
  const timerRef = useRef<number | null>(null);
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;

  const release = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recRef.current = null;
    chunksRef.current = [];
    if (aliveRef.current) setElapsedMs(0);
  }, []);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    else release();
  }, [release]);

  const start = useCallback(async () => {
    if (!supported) {
      setError('unsupported');
      return;
    }
    if (recRef.current || startingRef.current) return; // double click / second call while the prompt is open
    startingRef.current = true;
    setStarting(true);
    setError(null);
    cancelledRef.current = false;

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!aliveRef.current) {
        // Unmounted while the permission prompt was open: never leave the mic on.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream; // tracked immediately so any failure below can release it

      const mimeType = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onerror = () => {
        cancelledRef.current = true;
        if (aliveRef.current) setError('unavailable');
        if (rec.state !== 'inactive') rec.stop();
        else {
          release();
          if (aliveRef.current) setState('idle');
        }
      };
      rec.onstop = () => {
        const durationMs = Math.min(Date.now() - startedRef.current, MAX_VOICE_SECONDS * 1000);
        const mime = (rec.mimeType || mimeType || 'audio/webm').split(';')[0].trim().toLowerCase();
        const blob = new Blob(chunksRef.current, { type: mime });
        const cancelled = cancelledRef.current;
        const tooShort = durationMs < MIN_CLIP_MS || blob.size === 0;
        release();
        if (aliveRef.current) setState('idle');
        if (cancelled || !aliveRef.current) return;
        if (tooShort) {
          setError('too_short');
          return;
        }
        onClipRef.current({ blob, durationMs, mime });
      };

      startedRef.current = Date.now();
      rec.start(250);
      setState('recording');
      timerRef.current = window.setInterval(() => {
        const ms = Date.now() - startedRef.current;
        setElapsedMs(ms);
        if (ms >= MAX_VOICE_SECONDS * 1000) stop();
      }, 250);
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      release();
      if (!aliveRef.current) return;
      const name = (e as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setState('denied');
        setError('denied');
      } else {
        setState('idle');
        setError(name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError' ? 'unavailable' : 'unsupported');
      }
    } finally {
      startingRef.current = false;
      if (aliveRef.current) setStarting(false);
    }
  }, [supported, release, stop]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelledRef.current = true;
      const rec = recRef.current;
      if (rec && rec.state !== 'inactive') rec.stop();
      else release();
    };
  }, [release]);

  return {
    state,
    /** Whole seconds (legacy). */
    elapsed: Math.floor(elapsedMs / 1000),
    elapsedMs,
    error,
    starting,
    start,
    stop,
    cancel,
    clearError: () => setError(null),
  };
}
