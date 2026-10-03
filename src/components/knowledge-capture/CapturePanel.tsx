import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, RefreshCw, ScanSearch, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  formatDate,
  SOURCE_LABELS,
  type KceManualSourceType,
  type KceOverview,
} from '@/lib/knowledgeCapture';
import {
  fetchRecentCaptures,
  ingestCapture,
  retryCapture,
  runCaptureScan,
  setAutoCapture,
  uploadCaptureMedia,
  type CaptureRow,
  type ScanProgress,
} from '@/lib/knowledgeCaptureApi';

const MANUAL_OPTIONS: { value: KceManualSourceType; label: string }[] = [
  { value: 'voice_note', label: 'Voice note' },
  { value: 'video', label: 'Video walkthrough' },
  { value: 'correction', label: 'Correction' },
  { value: 'manual', label: 'Written note' },
];

const STATUS_TEXT: Record<CaptureRow['status'], string> = {
  pending: 'Waiting',
  processing: 'Processing',
  extracted: 'Rules found',
  no_knowledge: 'Nothing reusable',
  failed: 'Failed',
};

export function CapturePanel({
  overview,
  isReviewer,
  onChanged,
}: {
  overview: KceOverview | null;
  isReviewer: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [captures, setCaptures] = useState<CaptureRow[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [type, setType] = useState<KceManualSourceType>('voice_note');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [autoCapture, setAuto] = useState(overview?.auto_capture ?? false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!isReviewer) return;
    try {
      setCaptures(await fetchRecentCaptures());
    } catch {
      setCaptures([]);
    }
  }, [isReviewer]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setAuto(overview?.auto_capture ?? false);
  }, [overview?.auto_capture]);

  const scan = async () => {
    setScanning(true);
    setProgress(null);
    try {
      const result = await runCaptureScan(setProgress);
      const msg = result.quotaExhausted
        ? `Hourly AI limit reached — ${result.remaining} still queued. Run again later.`
        : `Scan complete: ${result.rulesCreated} new candidate rule${result.rulesCreated === 1 ? '' : 's'} from ${result.processed} source${result.processed === 1 ? '' : 's'}.`;
      toast(msg, result.failed > 0 ? 'info' : 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Scan failed.', 'error');
    } finally {
      setScanning(false);
      onChanged();
      void load();
    }
  };

  const submit = async () => {
    if (!file && notes.trim().length < 15) {
      toast('Add a few words of notes or attach a recording.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const mediaPath = file ? await uploadCaptureMedia(file) : undefined;
      const res = await ingestCapture({
        sourceType: type,
        notes: notes.trim() || undefined,
        mediaPath,
      });
      if (res.queued) toast(res.message ?? 'Saved and queued.', 'info');
      else if ((res.rules_created ?? 0) > 0)
        toast('Captured — a candidate rule is waiting for review.', 'success');
      else toast('Saved. Nothing reusable was found in it.', 'info');
      setNotes('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      onChanged();
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not capture this.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const retry = async (id: string) => {
    try {
      const r = await retryCapture(id);
      toast(
        r.outcome === 'failed' ? 'Still failing — try again later.' : 'Reprocessed.',
        r.outcome === 'failed' ? 'error' : 'success',
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Retry failed.', 'error');
    }
    void load();
    onChanged();
  };

  const toggleAuto = async () => {
    const next = !autoCapture;
    setAuto(next);
    try {
      await setAutoCapture(next);
      toast(next ? 'Automatic capture is on.' : 'Automatic capture is off.', 'success');
    } catch (e) {
      setAuto(!next);
      toast(e instanceof Error ? e.message : 'Could not change the setting.', 'error');
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section
        className="rounded-2xl border border-border/80 bg-bg-secondary p-5"
        aria-labelledby="kce-record"
      >
        <h2
          id="kce-record"
          className="flex items-center gap-2 text-sm font-semibold text-text-primary"
        >
          <Mic size={16} className="text-accent" aria-hidden="true" /> Capture an expert's knowledge
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">
          Record what an experienced technician knows: a voice note after a tricky job, a video
          walkthrough, or a correction to a wrong diagnosis. Audio/video up to 14 MB.
        </p>
        <div className="mt-4 space-y-3">
          <div role="radiogroup" aria-label="Capture type" className="flex flex-wrap gap-2">
            {MANUAL_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={type === o.value}
                onClick={() => setType(o.value)}
                className={`focus-ring rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${type === o.value ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:border-accent/40'}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <Textarea
            label="Notes"
            rows={5}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={6000}
            placeholder="e.g. On Trane XR16s, if you hear loud clicking at startup and the compressor hums, it's almost always the dual run capacitor — don't condemn the compressor first."
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,video/mp4,video/quicktime,video/webm"
              className="sr-only"
              id="kce-file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <label
              htmlFor="kce-file"
              className="focus-within:ring-2 inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-primary hover:border-accent/40"
            >
              <Upload size={14} aria-hidden="true" /> {file ? file.name : 'Attach audio or video'}
            </label>
            <Button size="sm" onClick={submit} disabled={submitting}>
              {submitting ? 'Extracting…' : 'Capture knowledge'}
            </Button>
          </div>
        </div>
      </section>

      {isReviewer && (
        <section
          className="rounded-2xl border border-border/80 bg-bg-secondary p-5"
          aria-labelledby="kce-scan"
        >
          <h2
            id="kce-scan"
            className="flex items-center gap-2 text-sm font-semibold text-text-primary"
          >
            <ScanSearch size={16} className="text-accent" aria-hidden="true" /> Mine your existing
            records
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            Reads the last 90 days of completed-job notes, callbacks, AI diagnoses with outcomes,
            live copilot sessions, expert sessions and call transcripts. Everything it finds becomes
            a candidate — nothing goes live without a human.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={scan} disabled={scanning}>
              <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} aria-hidden="true" />{' '}
              {scanning ? 'Scanning…' : 'Scan now'}
            </Button>
            {overview && (overview.pending_captures ?? 0) > 0 && !scanning && (
              <span className="text-xs text-text-secondary">
                {overview.pending_captures} queued
              </span>
            )}
          </div>
          {progress && (
            <p className="mt-3 text-xs text-text-secondary" role="status" aria-live="polite">
              Found {progress.enqueued} new · processed {progress.processed} ·{' '}
              {progress.rulesCreated} candidate rules · {progress.remaining} remaining
            </p>
          )}
          <label className="mt-5 flex cursor-pointer items-start gap-3 border-t border-border/60 pt-4 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={autoCapture}
              onChange={toggleAuto}
              className="focus-ring mt-0.5 h-4 w-4 rounded border-border"
            />
            <span>
              <span className="block font-semibold text-text-primary">Capture automatically</span>
              Scans new records on a schedule. Candidates still wait for your review.
            </span>
          </label>
        </section>
      )}

      {isReviewer && (
        <section className="lg:col-span-2" aria-labelledby="kce-recent">
          <h2 id="kce-recent" className="mb-3 text-sm font-semibold text-text-primary">
            Recent captures
          </h2>
          {captures === null ? (
            <Skeleton className="h-24 w-full" />
          ) : captures.length === 0 ? (
            <EmptyState
              icon={ScanSearch}
              title="Nothing captured yet"
              description="Run a scan or record a voice note to start building your tribal knowledge base."
            />
          ) : (
            <ul className="divide-y divide-border/60 rounded-2xl border border-border/80 bg-bg-secondary">
              {captures.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs"
                >
                  <span className="font-medium text-text-primary">
                    {SOURCE_LABELS[c.source_type]}
                  </span>
                  <span className="text-text-secondary">{formatDate(c.created_at)}</span>
                  <span className={c.status === 'failed' ? 'text-danger' : 'text-text-secondary'}>
                    {STATUS_TEXT[c.status]}
                    {c.status === 'extracted' && c.rules_found > 0 ? ` · ${c.rules_found}` : ''}
                  </span>
                  {c.status === 'failed' && (
                    <button
                      type="button"
                      onClick={() => retry(c.id)}
                      className="focus-ring rounded-lg px-2 py-1 font-medium text-accent hover:bg-accent/10"
                    >
                      Retry
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
