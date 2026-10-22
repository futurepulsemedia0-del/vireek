/**
 * Display helpers for data sealed with a customer-managed key.
 *
 * A sealed value is stored in the original column as a `sealed://<id>` marker. These helpers
 * render normal values untouched (zero behaviour change for accounts that don't use sealing)
 * and offer an explicit "Reveal" / "Play" step for sealed ones; every open is audit-logged by
 * the `trust-vault` function.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { openSealedField, openSealedRecording } from '@/lib/trustPack/api';
import { isSealedMarker, sealedIdFromMarker } from '@/lib/trustPack/envelope';

type Status = 'idle' | 'loading' | 'revealed' | 'error';

export interface SealedState {
  isSealed: boolean;
  /** Marker with no recoverable id (sealing failed at write time, or the item was purged). */
  unavailable: boolean;
  status: Status;
  value: string | null;
  error: string;
  reveal: () => void;
}

export function useSealedValue(raw: string | null | undefined): SealedState {
  const sealed = isSealedMarker(raw);
  const id = sealed ? sealedIdFromMarker(raw as string) : null;
  const [status, setStatus] = useState<Status>('idle');
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setStatus('idle'); setValue(null); setError(''); }, [raw]);

  const reveal = useCallback(() => {
    if (!id) return;
    setStatus('loading');
    openSealedField(id)
      .then((v) => { if (alive.current) { setValue(v); setStatus('revealed'); } })
      .catch((e: Error) => { if (alive.current) { setError(e.message || 'Could not open this item.'); setStatus('error'); } });
  }, [id]);

  if (!sealed) return { isSealed: false, unavailable: false, status: 'revealed', value: raw ?? null, error: '', reveal };
  return { isSealed: true, unavailable: !id, status, value, error, reveal };
}

function LockedBox({ label, state, actionLabel }: { label: string; state: Pick<SealedState, 'unavailable' | 'status' | 'error' | 'reveal'>; actionLabel: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-bg-primary p-4 text-sm text-text-secondary" role="group" aria-label={label}>
      <Lock size={16} className="shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1">
        {state.unavailable ? `${label} was not stored because your encryption key was unavailable.` : `${label} is encrypted with your key.`}
        {state.status === 'error' && <span role="alert" className="ml-1 text-red-500">{state.error}</span>}
      </span>
      {!state.unavailable && (
        <button type="button" onClick={state.reveal} disabled={state.status === 'loading'}
          className="focus-ring inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-semibold text-text-primary hover:bg-bg-tertiary disabled:opacity-60">
          {state.status === 'loading' && <Loader2 size={14} className="animate-spin" aria-hidden />} {actionLabel}
        </button>
      )}
    </div>
  );
}

/** Shows `children(plainText)`; sealed values are revealed on demand. */
export function SealedText({ value, children }: { value: string; children: (text: string) => ReactNode }) {
  const s = useSealedValue(value);
  if (!s.isSealed) return <>{children(value)}</>;
  if (s.status === 'revealed' && s.value !== null) return <>{children(s.value)}</>;
  return <LockedBox label="Transcript" state={s} actionLabel="Reveal transcript" />;
}

/** Notice for pages that parse the transcript themselves (CallDetailPage). Renders nothing for plain values. */
export function SealedNotice({ state }: { state: SealedState }) {
  if (!state.isSealed || (state.status === 'revealed' && state.value !== null)) return null;
  return <LockedBox label="Transcript" state={state} actionLabel="Reveal transcript" />;
}

/** Shows `children(playableUrl)`; sealed recordings are decrypted on demand into a blob URL. */
export function SealedAudio({ url, children }: { url: string; children: (playableUrl: string) => ReactNode }) {
  const sealed = isSealedMarker(url);
  const id = sealed ? sealedIdFromMarker(url) : null;
  const [status, setStatus] = useState<Status>('idle');
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const current = useRef<string | null>(null);

  useEffect(() => () => { if (current.current) URL.revokeObjectURL(current.current); }, []);
  useEffect(() => {
    if (current.current) { URL.revokeObjectURL(current.current); current.current = null; }
    setObjectUrl(null); setStatus('idle'); setError('');
  }, [url]);

  const reveal = useCallback(() => {
    if (!id) return;
    setStatus('loading');
    openSealedRecording(id)
      .then((blob) => {
        const u = URL.createObjectURL(new Blob([blob], { type: 'audio/wav' }));
        current.current = u;
        setObjectUrl(u);
        setStatus('revealed');
      })
      .catch((e: Error) => { setError(e.message || 'Could not open this recording.'); setStatus('error'); });
  }, [id]);

  if (!sealed) return <>{children(url)}</>;
  if (status === 'revealed' && objectUrl) return <>{children(objectUrl)}</>;
  return <LockedBox label="Recording" state={{ unavailable: !id, status, error, reveal }} actionLabel="Decrypt and play" />;
}
