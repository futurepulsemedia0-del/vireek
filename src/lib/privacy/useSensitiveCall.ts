import { useEffect, useState } from 'react';
import { readCallSensitive, type AccessErrorKind, AccessLogError } from '@/lib/privacy/accessLog';

export type SensitiveCallState =
  | { status: 'loading'; recordingUrl: null; transcript: null }
  | { status: 'ready'; recordingUrl: string | null; transcript: string | null }
  | { status: 'error'; recordingUrl: null; transcript: null; kind: AccessErrorKind };

/** Loads recording + transcript of ONE call through the logged RPC when the component mounts / the id changes. */
export function useSensitiveCall(callId: string): SensitiveCallState {
  const [state, setState] = useState<SensitiveCallState>({ status: 'loading', recordingUrl: null, transcript: null });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', recordingUrl: null, transcript: null });
    void (async () => {
      try {
        const r = await readCallSensitive(callId);
        if (!cancelled) setState({ status: 'ready', recordingUrl: r?.recordingUrl ?? null, transcript: r?.transcript ?? null });
      } catch (e) {
        if (!cancelled) setState({ status: 'error', recordingUrl: null, transcript: null, kind: e instanceof AccessLogError ? e.kind : 'unknown' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [callId]);

  return state;
}
