/**
 * AI Photo + Voice-Based Estimating panel (dashboard side).
 *
 * A technician adds photos, records a voice note and/or attaches a short
 * video, taps Analyze, and gets a diagnosis, scope of work, parts, labor and
 * a Good / Better / Best draft to review. This component NEVER writes to
 * `quotes` - "Apply" hands the reviewed result to TieredEstimateBuilder,
 * which owns the draft, and the page owns the save.
 *
 * Photos reuse the builder's own uploader (`onPickPhotos`), so a photo added
 * here is also the one the customer sees on the estimate.
 *
 * Used by src/components/quotes/TieredEstimateBuilder.tsx.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ClipboardList,
  Loader2,
  Mic,
  Sparkles,
  Square,
  Trash2,
  Video,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { formatCents } from '@/lib/quotes';
import { TIER_META } from '@/lib/estimates';
import {
  FIELD_LIMITS,
  SEVERITY_META,
  analyzeFieldEstimate,
  probeDuration,
  removeFieldMedia,
  toWav16kMono,
  uploadFieldMedia,
} from '@/lib/fieldEstimate';
import type { FieldEstimateResult } from '@/lib/fieldEstimate';

interface FieldEstimatePanelProps {
  userId: string;
  /** Folder key shared with the builder's photo uploads. */
  draftId: string;
  /** Storage paths (bucket `quote-photos`) of the photos already on the draft. */
  photoPaths: string[];
  uploadingPhotos: number;
  photoLimitReached: boolean;
  onPickPhotos: (files: FileList | null) => void;
  /** Return false when the user cancels (e.g. declines to overwrite existing options). */
  onApply: (result: FieldEstimateResult) => boolean;
}

type RecState = 'idle' | 'recording' | 'processing';
type Stage = 'idle' | 'uploading' | 'analyzing';

interface AudioClip {
  blob: Blob;
  url: string;
  seconds: number | null;
}

function clock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ResultView({
  result,
  onApply,
  onDiscard,
  applied,
}: {
  result: FieldEstimateResult;
  onApply: () => void;
  onDiscard: () => void;
  applied: boolean;
}) {
  const severity = SEVERITY_META[result.diagnosis.severity];
  const recommended = result.tiers.find((t) => t.tier === result.recommended_tier) ?? result.tiers[0];
  const confidencePct = Math.round(result.diagnosis.confidence * 100);
  const unverified = result.tiers.reduce((n, t) => n + t.line_items.filter((l) => l.needs_review).length, 0);

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      {(result.safety_flags.length > 0 || result.diagnosis.severity === 'emergency') && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
          <div className="text-xs leading-relaxed text-text-primary">
            <p className="font-semibold text-danger">Safety concern - address before quoting</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-text-secondary">
              {result.safety_flags.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-bg-primary p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[0.65rem] font-semibold ${severity.className}`}>
            {severity.label}
          </span>
          <span className="text-[0.65rem] text-text-secondary">
            {result.diagnosis.service_type.replace('_', ' ')} - confidence {confidencePct}%
          </span>
        </div>
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-tertiary"
          role="progressbar"
          aria-label="AI confidence"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={confidencePct}
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${confidencePct}%` }} />
        </div>
        <p className="mt-2 text-sm font-semibold text-text-primary">{result.diagnosis.summary}</p>
        {result.diagnosis.probable_cause && (
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            <span className="font-medium text-text-primary">Likely cause: </span>
            {result.diagnosis.probable_cause}
          </p>
        )}
        {result.diagnosis.evidence.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-text-secondary">
            {result.diagnosis.evidence.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>

      {result.missing_info.length > 0 && (
        <div className="rounded-xl border border-warning-500/30 bg-warning-500/10 p-3">
          <p className="text-xs font-semibold text-text-primary">Confirm on site</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-text-secondary">
            {result.missing_info.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-bg-primary p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
            <ClipboardList size={12} className="text-accent" /> Scope of work
          </p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-text-secondary">
            {result.scope_of_work.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
        <div className="rounded-xl border border-border bg-bg-primary p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
            <Wrench size={12} className="text-accent" /> Parts &amp; labor
            <span className="font-normal text-text-secondary">({TIER_META[recommended.tier].label})</span>
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-text-secondary">
            {result.parts.length === 0 && <li>Labor only - no parts identified.</li>}
            {result.parts.map((p) => (
              <li key={p.name}>
                {p.quantity} x {p.name}
              </li>
            ))}
          </ul>
          {(recommended.labor_hours || recommended.crew_size) && (
            <p className="mt-2 text-xs text-text-secondary">
              Labor: {recommended.labor_hours ? `~${recommended.labor_hours} h` : 'time TBD'}
              {recommended.crew_size ? ` - crew of ${recommended.crew_size}` : ''}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {result.tiers.map((t) => (
          <div
            key={t.tier}
            className={`rounded-xl border bg-bg-primary p-3 ${
              t.tier === result.recommended_tier ? TIER_META[t.tier].ringClass : 'border-border'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`text-[0.65rem] font-semibold uppercase tracking-wide ${TIER_META[t.tier].accentClass}`}>
                {TIER_META[t.tier].label}
              </span>
              {t.tier === result.recommended_tier && (
                <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[0.6rem] font-semibold text-accent">
                  Recommended
                </span>
              )}
            </div>
            <p className="mt-1 text-sm font-semibold text-text-primary">{t.name}</p>
            <p className="text-lg font-bold text-text-primary">{formatCents(t.total_cents)}</p>
            <p className="text-[0.65rem] text-text-secondary">before tax</p>
            <ul className="mt-2 space-y-1">
              {t.line_items.map((l, i) => (
                <li key={`${l.description}-${i}`} className="flex items-start justify-between gap-2 text-xs">
                  <span className="text-text-secondary">
                    {l.quantity > 1 ? `${l.quantity} x ` : ''}
                    {l.description}
                    {l.needs_review && (
                      <span className="ml-1 rounded bg-warning-500/10 px-1 text-[0.6rem] font-medium text-warning-500">
                        verify
                      </span>
                    )}
                    {l.source === 'price_book' && !l.needs_review && (
                      <span className="ml-1 rounded bg-success-500/10 px-1 text-[0.6rem] font-medium text-success-500">
                        price book
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums text-text-primary">
                    {formatCents(l.quantity * l.unit_price_cents)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {(result.warnings.length > 0 || unverified > 0) && (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-text-secondary">
          {unverified > 0 && (
            <li>
              {unverified} line{unverified === 1 ? '' : 's'} use an AI ballpark or a price-book range - confirm them
              before sending.
            </li>
          )}
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {result.transcript && (
        <details className="rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-secondary">
          <summary className="focus-ring cursor-pointer font-medium text-text-primary">Voice transcript</summary>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed">{result.transcript}</p>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={onApply} disabled={applied}>
          {applied ? <CheckCircle2 size={14} /> : <Sparkles size={14} />}
          {applied ? 'Applied - review the options below' : 'Apply to estimate'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
          <Trash2 size={14} /> Discard
        </Button>
        <p className="text-[0.7rem] text-text-secondary">
          AI-generated draft. Confirm every price before it goes to a customer.
        </p>
      </div>
    </div>
  );
}

export function FieldEstimatePanel({
  userId,
  draftId,
  photoPaths,
  uploadingPhotos,
  photoLimitReached,
  onPickPhotos,
  onApply,
}: FieldEstimatePanelProps) {
  const [notes, setNotes] = useState('');
  const [audio, setAudio] = useState<AudioClip | null>(null);
  const [video, setVideo] = useState<{ file: File; seconds: number | null } | null>(null);
  const [recState, setRecState] = useState<RecState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FieldEstimateResult | null>(null);
  const [applied, setApplied] = useState(false);

  const photoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const busy = stage !== 'idle';

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const replaceAudio = useCallback((clip: AudioClip | null) => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = clip?.url ?? null;
    setAudio(clip);
  }, []);

  // Release mic, timer and object URL if the panel unmounts mid-recording.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const setClipFromBlob = useCallback(
    async (blob: Blob) => {
      const wav = await toWav16kMono(blob);
      const seconds = await probeDuration(wav, 'audio');
      if (seconds !== null && seconds > FIELD_LIMITS.audioSeconds) {
        setError(`That voice note is ${Math.round(seconds)} s. Keep it under ${FIELD_LIMITS.audioSeconds / 60} minutes.`);
        return;
      }
      if (wav.size > 8 * 1024 * 1024) {
        setError('That audio file is too large. Record a shorter note.');
        return;
      }
      replaceAudio({ blob: wav, url: URL.createObjectURL(wav), seconds });
    },
    [replaceAudio]
  );

  const stopRecording = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const startRecording = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice recording is not supported in this browser. Upload an audio file instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) =>
        MediaRecorder.isTypeSupported(m)
      );
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stopStream();
        setRecState('processing');
        void setClipFromBlob(new Blob(chunksRef.current, { type: rec.mimeType || mimeType || 'audio/webm' }))
          .catch(() => setError('Could not process that recording. Try again.'))
          .finally(() => setRecState('idle'));
      };
      recorderRef.current = rec;
      rec.start();
      setElapsed(0);
      setRecState('recording');
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch {
      stopStream();
      setError('Microphone access was blocked. Allow it in your browser settings, or upload an audio file.');
    }
  };

  // Hard stop at the max length.
  useEffect(() => {
    if (recState === 'recording' && elapsed >= FIELD_LIMITS.audioSeconds) stopRecording();
  }, [elapsed, recState, stopRecording]);

  const handleAudioFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setRecState('processing');
    try {
      await setClipFromBlob(file);
    } catch {
      setError('Could not read that audio file.');
    } finally {
      setRecState('idle');
    }
  };

  const handleVideoFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > FIELD_LIMITS.videoBytes) {
      setError(
        `That video is ${(file.size / 1048576).toFixed(0)} MB. Keep it under 40 MB - about 30 seconds is plenty.`
      );
      return;
    }
    const seconds = await probeDuration(file, 'video');
    if (seconds !== null && seconds > FIELD_LIMITS.videoSeconds) {
      setError(`That video is ${Math.round(seconds)} s. Keep it under ${FIELD_LIMITS.videoSeconds} seconds.`);
      return;
    }
    setVideo({ file, seconds });
  };

  const hasEvidence = photoPaths.length > 0 || audio !== null || video !== null || notes.trim().length >= 10;
  const canAnalyze = !busy && recState === 'idle' && uploadingPhotos === 0 && hasEvidence;

  const handleAnalyze = async () => {
    if (!canAnalyze) return;
    setError(null);
    setResult(null);
    setApplied(false);

    let audioPath: string | null = null;
    let videoPath: string | null = null;
    try {
      setStage('uploading');
      [audioPath, videoPath] = await Promise.all([
        audio ? uploadFieldMedia(userId, draftId, audio.blob, 'audio') : Promise.resolve(null),
        video ? uploadFieldMedia(userId, draftId, video.file, 'video', video.file.name) : Promise.resolve(null),
      ]);

      setStage('analyzing');
      const res = await analyzeFieldEstimate({ photoPaths, audioPath, videoPath, notes });
      setResult(res);
      // The server deletes voice/video after analysis (the transcript is kept).
      replaceAudio(null);
      setVideo(null);
    } catch (e) {
      void removeFieldMedia([audioPath, videoPath].filter((p): p is string => Boolean(p)));
      setError(e instanceof Error ? e.message : 'Could not generate an estimate. Try again.');
    } finally {
      setStage('idle');
    }
  };

  const overPhotoCap = photoPaths.length > FIELD_LIMITS.photos;

  return (
    <section
      aria-labelledby="field-estimate-title"
      className="rounded-2xl border border-accent/30 bg-accent/5 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={15} className="text-accent" />
        <h3 id="field-estimate-title" className="text-sm font-semibold text-text-primary">
          AI Field Estimate
        </h3>
        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[0.65rem] font-medium text-accent">
          Photo + Voice
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
        Snap the problem, say what you see, and get a diagnosis, scope, parts, labor and a Good / Better / Best draft
        priced from your price book.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || photoLimitReached || uploadingPhotos > 0}
          onClick={() => photoInputRef.current?.click()}
        >
          {uploadingPhotos > 0 ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
          {uploadingPhotos > 0 ? `Uploading ${uploadingPhotos}...` : `Photos (${photoPaths.length})`}
        </Button>
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            onPickPhotos(e.target.files);
            e.target.value = '';
          }}
        />

        {recState === 'recording' ? (
          <Button type="button" size="sm" variant="secondary" onClick={stopRecording} aria-label="Stop recording">
            <Square size={14} className="text-danger" />
            <span className="tabular-nums">
              {clock(elapsed)} / {clock(FIELD_LIMITS.audioSeconds)}
            </span>
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || recState === 'processing'}
            onClick={() => void startRecording()}
          >
            {recState === 'processing' ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
            {recState === 'processing' ? 'Processing...' : audio ? 'Re-record voice' : 'Record voice'}
          </Button>
        )}

        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || recState !== 'idle'}
          onClick={() => videoInputRef.current?.click()}
        >
          <Video size={14} /> {video ? 'Replace video' : 'Add video'}
        </Button>
        <input
          ref={videoInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            void handleVideoFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        <button
          type="button"
          disabled={busy || recState !== 'idle'}
          onClick={() => audioInputRef.current?.click()}
          className="focus-ring rounded-lg px-2 py-1 text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline disabled:opacity-50"
        >
          or upload audio
        </button>
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            void handleAudioFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {(audio || video) && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {audio && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-primary px-2 py-1">
              <audio controls src={audio.url} className="h-8 max-w-[220px]" />
              <button
                type="button"
                disabled={busy}
                onClick={() => replaceAudio(null)}
                aria-label="Remove voice note"
                className="focus-ring text-text-secondary hover:text-danger disabled:opacity-50"
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
          {video && (
            <span className="flex items-center gap-2 rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-secondary">
              <Video size={12} />
              {video.file.name.length > 22 ? `${video.file.name.slice(0, 19)}...` : video.file.name}
              {video.seconds !== null && ` - ${Math.round(video.seconds)} s`}
              <button
                type="button"
                disabled={busy}
                onClick={() => setVideo(null)}
                aria-label="Remove video"
                className="focus-ring hover:text-danger disabled:opacity-50"
              >
                <Trash2 size={12} />
              </button>
            </span>
          )}
        </div>
      )}

      <div className="mt-3">
        <Textarea
          label="Technician notes (optional)"
          rows={2}
          maxLength={FIELD_LIMITS.notesChars}
          value={notes}
          disabled={busy}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. 12-year-old 40-gal tank, corroded inlet fitting, slow drip, customer wants it fixed today"
        />
      </div>

      <p className="mt-2 text-[0.7rem] leading-relaxed text-text-secondary">
        Photos are used only to draft this estimate. Voice and video are deleted right after analysis; the transcript
        stays on the quote. Tell customers before you record them.
        {overPhotoCap && ` The first ${FIELD_LIMITS.photos} photos are analyzed.`}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={() => void handleAnalyze()} disabled={!canAnalyze}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {stage === 'uploading' ? 'Uploading...' : stage === 'analyzing' ? 'Analyzing...' : 'Analyze & draft estimate'}
        </Button>
        <p role="status" aria-live="polite" className="text-xs text-text-secondary">
          {stage === 'analyzing' ? 'Reading photos and audio - usually 10 to 30 seconds.' : ''}
        </p>
      </div>

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-danger">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      {result && (
        <ResultView
          result={result}
          applied={applied}
          onApply={() => {
            if (onApply(result)) setApplied(true);
          }}
          onDiscard={() => {
            setResult(null);
            setApplied(false);
          }}
        />
      )}
    </section>
  );
}
