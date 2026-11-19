import { useCallback, useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/Button';
import { useExportBundleT } from '@/i18n/exportBundleNamespace';
import {
  TenantExportError, createHttpTransport, createMemorySink, newSession, runChunkedExport,
  type ExportProgress, type ExportSession, type ExportSink,
} from '@/lib/tenantExport';

/**
 * Self-serve whole-account export (open formats: tar + NDJSON + manifest). Owner/admin only — enforced server-side.
 * Large accounts are pulled in small verified chunks (resumable); the archive only becomes a finished file once the
 * server has proven that every record is included. Where the browser allows it the archive streams straight to disk.
 */

interface Writable { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<Writable> }>;

type Phase = 'idle' | 'running' | 'paused' | 'done' | 'failed';
const RESUMABLE = new Set(['retries_exhausted', 'network', 'server', 'aborted', 'auth']);

export function FullExportButton() {
  const { t } = useExportBundleT();
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  const sessionRef = useRef<ExportSession | null>(null);
  const memRef = useRef<ReturnType<typeof createMemorySink> | null>(null);
  const writableRef = useRef<Writable | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const discard = useCallback(async () => {
    abortRef.current?.abort();
    const w = writableRef.current;
    writableRef.current = null;
    sessionRef.current = null;
    memRef.current = null;
    if (w) await w.abort().catch(() => undefined); // drops the half-written file: an unfinished archive must not survive
  }, []);

  useEffect(() => () => { void discard(); }, [discard]);

  const run = async (resume: boolean) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setErrorKey(null);
    try {
      if (!resume || !sessionRef.current) {
        await discard();
        const stamp = new Date().toISOString().slice(0, 10);
        const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
        if (picker) {
          try {
            // Streams to disk: no memory ceiling for very large accounts.
            const handle = await picker({ suggestedName: `vireek-export-${stamp}.tar`, types: [{ description: 'tar archive', accept: { 'application/x-tar': ['.tar'] } }] });
            writableRef.current = await handle.createWritable();
          } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') return; // the person closed the save dialog
            writableRef.current = null; // picker unavailable or blocked: fall back to an in-memory archive
          }
        }
        sessionRef.current = newSession();
        memRef.current = writableRef.current ? null : createMemorySink();
      }
      const w = writableRef.current;
      const sink: ExportSink = w ? { write: (p: Uint8Array) => w.write(p) } : (memRef.current as ExportSink);

      const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '');
      const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
      if (!base || !anon) throw new TenantExportError('protocol', { problems: ['not_configured'] });

      const ctl = new AbortController();
      abortRef.current = ctl;
      setPhase('running');
      const manifest = await runChunkedExport({
        session: sessionRef.current as ExportSession,
        sink,
        signal: ctl.signal,
        onProgress: setProgress,
        transport: createHttpTransport({
          baseUrl: base,
          anonKey: anon,
          getToken: async () => {
            const { data: { session } } = await supabase.auth.getSession(); // refreshed automatically when close to expiry
            if (!session) throw new TenantExportError('auth');
            return session.access_token;
          },
        }),
      });

      if (writableRef.current) {
        await writableRef.current.close();
        writableRef.current = null;
      } else if (memRef.current) {
        const url = URL.createObjectURL(memRef.current.toBlob());
        const a = document.createElement('a');
        a.href = url;
        a.download = `vireek-export-${manifest.exportedAt.slice(0, 10)}.tar`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      setFingerprint(manifest.rootSha256.slice(0, 16));
      sessionRef.current = null;
      memRef.current = null;
      setPhase('done');
    } catch (e) {
      const code = e instanceof TenantExportError ? e.code : 'generic';
      if (RESUMABLE.has(code) && sessionRef.current && !sessionRef.current.poisoned) {
        setPhase('paused');
        setErrorKey(code === 'auth' ? 'auth' : code === 'aborted' ? null : 'generic');
      } else {
        await discard();
        setPhase('failed');
        setErrorKey(['forbidden', 'incomplete', 'integrity', 'sink'].includes(code) ? code : 'generic');
      }
    } finally {
      runningRef.current = false;
    }
  };

  const running = phase === 'running';
  const pct = progress && progress.totalRows > 0 ? Math.min(100, Math.round((progress.rowsDone / progress.totalRows) * 100)) : 0;
  const rows = (progress?.rowsDone ?? 0).toLocaleString();
  const total = (progress?.totalRows ?? 0).toLocaleString();
  const table = progress?.table ? t(`tables.${progress.table}`) : '';

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
      <h2 className="text-base font-semibold text-text-primary">{t('title')}</h2>
      <p className="mt-1 text-sm text-text-secondary">{t('description')}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {phase === 'paused' ? (
          <>
            <Button type="button" onClick={() => void run(true)}><Download className="h-4 w-4" aria-hidden="true" />{t('actions.resume')}</Button>
            <Button type="button" variant="secondary" onClick={() => { void discard().then(() => { setPhase('idle'); setProgress(null); setErrorKey(null); }); }}>{t('actions.startOver')}</Button>
          </>
        ) : (
          <Button type="button" onClick={() => void run(false)} loading={running} loadingLabel={t('status.preparing')} disabled={running}>
            <Download className="h-4 w-4" aria-hidden="true" />{t('actions.download')}
          </Button>
        )}
        {running && <Button type="button" variant="ghost" onClick={() => abortRef.current?.abort()}>{t('actions.cancel')}</Button>}
      </div>

      {(running || phase === 'paused') && progress && (
        <div className="mt-3" role="status" aria-live="polite">
          <progress className="h-2 w-full" max={100} value={pct} aria-label={t('status.progressLabel')} />
          <p className="mt-1 text-sm text-text-secondary">
            {phase === 'paused' ? t('status.paused', { rows, total })
              : progress.phase === 'verifying' ? t('status.verifying')
              : progress.phase === 'planning' ? t('status.preparing')
              : t('status.downloading', { table, rows, total })}
          </p>
        </div>
      )}
      {phase === 'done' && progress && (
        <p role="status" className="mt-3 text-sm text-text-secondary">{t('status.done', { rows: progress.totalRows.toLocaleString(), fingerprint: fingerprint ?? '' })}</p>
      )}
      {errorKey && <p role="alert" className="mt-2 text-sm text-danger">{t(`errors.${errorKey}`)}</p>}
    </section>
  );
}
