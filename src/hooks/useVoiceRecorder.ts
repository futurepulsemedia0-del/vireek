import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_VOICE_SECONDS, pickRecorderMime } from '@/lib/jobMessages';

export type RecorderState = 'idle' | 'recording' | 'unsupported' | 'denied';

export interface RecordedClip {
  blob: Blob;
  durationMs: number;
}

/** MediaRecorder wrapper: auto-stops at MAX_VOICE_SECONDS, always releases the mic, supports cancel. */
export function useVoiceRecorder(onClip: (clip: RecordedClip) => void) {
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  const [state, setState] = useState<RecorderState>(supported ? 'idle' : 'unsupported');
  const [elapsed, setElapsed] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(0);
  const cancelledRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;

  const release = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recRef.current = null;
    setElapsed(0);
  }, []);

  const stop = useCallback(() => {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stop();
  }, [stop]);

  const start = useCallback(async () => {
    if (!supported || recRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream;
      recRef.current = rec;
      chunksRef.current = [];
      cancelledRef.current = false;
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const durationMs = Date.now() - startedRef.current;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || mimeType || 'audio/webm' });
        const discard = cancelledRef.current || durationMs < 600 || blob.size === 0;
        release();
        setState('idle');
        if (!discard) onClipRef.current({ blob, durationMs });
      };
      startedRef.current = Date.now();
      rec.start();
      setState('recording');
      timerRef.current = window.setInterval(() => {
        const s = Math.floor((Date.now() - startedRef.current) / 1000);
        setElapsed(s);
        if (s >= MAX_VOICE_SECONDS) stop();
      }, 250);
    } catch (e) {
      release();
      setState((e as DOMException)?.name === 'NotAllowedError' ? 'denied' : 'unsupported');
    }
  }, [supported, release, stop]);

  useEffect(() => () => {
    cancelledRef.current = true;
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
    else release();
  }, [release]);

  return { state, elapsed, start, stop, cancel };
}
