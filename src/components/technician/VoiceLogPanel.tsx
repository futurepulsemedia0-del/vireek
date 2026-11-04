// Hands-free voice job log: tap and speak -> queued on device (works offline) -> AI draft
// (findings, parts, time, customer notes) -> technician reviews/edits -> approves.
// The AI only suggests. Nothing reaches the job notes or a customer without approval.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Mic, ShieldAlert, Square, WifiOff } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useOnlineStatus } from '@/hooks/forms/useOnlineStatus';
import { isVoiceSupported, startVoiceRecording, type VoiceRecording } from '@/lib/offline/capture';
import { useVoiceLogT } from '@/i18n/voiceLogNamespace';
import {
  MAX_RECORDING_SECONDS, discardDraft, discardQueued, enqueueRecording, giveConsent, hasConsent, listPendingApprovals,
  listQueued, loadReadyDrafts, processApprovals, processQueue, processRecording, submitApproval, type VoiceDraft,
} from '@/lib/voiceLog/service';
import type { PendingApproval } from '@/lib/voiceLog/approvalFlow';
import { EstimateDraftCard } from '@/components/technician/EstimateDraftCard';
import type { QueuedRecording } from '@/lib/voiceLog/queue';
import { LOW_CONFIDENCE, VOICE_LANGS, type VoiceExtraction, type VoiceLang } from '../../../supabase/functions/_shared/voice-log/extract';

type TFn = (key: string, opts?: Record<string, unknown>) => string;
const inputCls = 'w-full min-h-[48px] rounded-md border border-border bg-bg-primary px-3 py-2 text-base text-text-primary';
const btnPrimary = 'min-h-[56px] w-full rounded-lg bg-accent px-4 py-3 text-base font-semibold text-white disabled:opacity-50';
const btnGhost = 'min-h-[48px] rounded-md border border-border px-4 py-2 text-base font-medium text-text-primary disabled:opacity-50';

function ConfidenceBadge({ value, t }: { value: number; t: TFn }) {
  const low = value < LOW_CONFIDENCE;
  const Icon = low ? AlertTriangle : CheckCircle2;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${low ? 'bg-warning-500/10 text-warning-500' : 'bg-success-500/10 text-success-500'}`}
      title={t('confidence', { pct: Math.round(value * 100) })}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {low ? t('check') : t('confident')} · {Math.round(value * 100)}%
    </span>
  );
}

function DraftCard({ draft, jobId, t, onDone, onApproved }: { draft: VoiceDraft; jobId: string; t: TFn; onDone: () => void; onApproved: (ex: VoiceExtraction) => void }) {
  const { toast } = useToast();
  const [ex, setEx] = useState<VoiceExtraction>(draft.extraction);
  const [busy, setBusy] = useState(false);

  async function approve() {
    setBusy(true);
    try {
      // Saved on this device first, then synced: never lost, works with no signal.
      const r = await submitApproval(jobId, draft.id, ex);
      if (r === 'conflict') toast(t('approvalConflict'), 'error');
      else { toast(r === 'done' ? t('approved') : t('approvalQueued'), 'success'); onApproved(ex); }
      onDone();
    } catch { toast(t('approveFailed'), 'error'); } finally { setBusy(false); }
  }
  async function discard() {
    if (!navigator.onLine) { toast(t('discardNeedsOnline'), 'error'); return; }
    setBusy(true);
    try { await discardDraft(draft.id); onDone(); } catch { toast(t('approveFailed'), 'error'); } finally { setBusy(false); }
  }

  return (
    <article className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 p-3" aria-label={t('draftTitle')}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-text-primary">{t('draftTitle')}</h3>
        <span className="rounded-full bg-bg-tertiary px-2 py-1 text-xs font-medium text-text-secondary">{t('aiBadge')}</span>
      </header>
      {draft.needs_review && <p className="text-sm font-medium text-warning-500" role="note">{t('needsReview')}</p>}

      <label className="block text-sm text-text-secondary">{t('summary')}
        <textarea className={`${inputCls} mt-1`} rows={2} value={ex.summary} onChange={(e) => setEx({ ...ex, summary: e.target.value.slice(0, 1200) })} />
      </label>

      {ex.findings.length > 0 && (
        <fieldset className="space-y-2"><legend className="text-sm font-semibold text-text-primary">{t('findings')}</legend>
          {ex.findings.map((f, i) => (
            <div key={i} className="space-y-1">
              {f.severity === 'safety' && <p className="flex items-start gap-1 text-sm font-medium text-danger"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{t('safetyLabel')}</p>}
              <input className={inputCls} value={f.text} aria-label={t('findings')}
                onChange={(e) => setEx({ ...ex, findings: ex.findings.map((x, j) => (j === i ? { ...x, text: e.target.value.slice(0, 600), confidence: 1 } : x)) })} />
              <ConfidenceBadge value={f.confidence} t={t} />
            </div>
          ))}
        </fieldset>
      )}

      {ex.parts.length > 0 && (
        <fieldset className="space-y-2"><legend className="text-sm font-semibold text-text-primary">{t('parts')}</legend>
          {ex.parts.map((p, i) => (
            <div key={i} className="space-y-1">
              <div className="flex gap-2">
                <input className={inputCls} value={p.name} aria-label={t('parts')}
                  onChange={(e) => setEx({ ...ex, parts: ex.parts.map((x, j) => (j === i ? { ...x, name: e.target.value.slice(0, 160), confidence: 1 } : x)) })} />
                <input className={`${inputCls} w-24`} type="number" inputMode="numeric" min={1} max={999} value={p.quantity} aria-label={t('partQty')}
                  onChange={(e) => { const q = Math.round(Number(e.target.value)); setEx({ ...ex, parts: ex.parts.map((x, j) => (j === i ? { ...x, quantity: q >= 1 && q <= 999 ? q : x.quantity, confidence: 1 } : x)) }); }} />
              </div>
              <ConfidenceBadge value={p.confidence} t={t} />
            </div>
          ))}
        </fieldset>
      )}

      <label className="block text-sm text-text-secondary">{t('time')}
        <input className={`${inputCls} mt-1`} type="number" inputMode="numeric" min={1} max={1440} value={ex.time_minutes ?? ''}
          onChange={(e) => { const n = Math.round(Number(e.target.value)); setEx({ ...ex, time_minutes: n >= 1 && n <= 1440 ? n : null, time_confidence: 1 }); }} />
        {ex.time_minutes !== null && <span className="mt-1 block"><ConfidenceBadge value={ex.time_confidence} t={t} /></span>}
      </label>

      {ex.customer_notes.length > 0 && (
        <fieldset className="space-y-2"><legend className="text-sm font-semibold text-text-primary">{t('customerNotes')}</legend>
          {ex.customer_notes.map((n, i) => (
            <input key={i} className={inputCls} value={n} aria-label={t('customerNotes')}
              onChange={(e) => setEx({ ...ex, customer_notes: ex.customer_notes.map((x, j) => (j === i ? e.target.value.slice(0, 600) : x)) })} />
          ))}
        </fieldset>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" className={btnPrimary} disabled={busy} onClick={approve}>{busy ? t('approving') : t('approve')}</button>
        <button type="button" className={btnGhost} disabled={busy} onClick={discard}>{t('discard')}</button>
      </div>
    </article>
  );
}

export function VoiceLogPanel({ jobId }: { jobId: string }) {
  const { t } = useVoiceLogT();
  const tt = t as unknown as TFn;
  const { toast } = useToast();
  const online = useOnlineStatus();
  const [consent, setConsent] = useState(hasConsent);
  const [lang, setLang] = useState<VoiceLang>('auto');
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [queued, setQueued] = useState<QueuedRecording[]>([]);
  const [drafts, setDrafts] = useState<VoiceDraft[]>([]);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [approvedEx, setApprovedEx] = useState<VoiceExtraction | null>(null);
  const recRef = useRef<VoiceRecording | null>(null);
  const supported = isVoiceSupported();

  const refresh = useCallback(async () => {
    try { setQueued(await listQueued(jobId)); } catch { /* IndexedDB unavailable */ }
    try { setPending(await listPendingApprovals(jobId)); } catch { /* IndexedDB unavailable */ }
    try { setDrafts(await loadReadyDrafts(jobId)); } catch { /* keep last list */ }
  }, [jobId]);

  // Process the queue on mount, when signal returns, and on a gentle timer while items wait.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (navigator.onLine) { await processApprovals(jobId); await processQueue(jobId); }
      if (!cancelled) await refresh();
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, 20_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [jobId, online, refresh]);

  useEffect(() => {
    if (!recording) return undefined;
    const id = window.setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [recording]);
  useEffect(() => () => { recRef.current?.cancel(); }, []);

  const stop = useCallback(async () => {
    const rec = recRef.current;
    recRef.current = null;
    setRecording(false);
    if (!rec) return;
    try {
      const { blob, ext } = await rec.stop();
      await enqueueRecording(jobId, blob, ext, lang);
      toast(tt('saved'), 'success');
      await refresh();
      if (navigator.onLine) { await processQueue(jobId); await refresh(); }
    } catch { toast(tt('saveFailed'), 'error'); }
  }, [jobId, lang, refresh, toast, tt]);

  useEffect(() => { if (recording && seconds >= MAX_RECORDING_SECONDS) void stop(); }, [recording, seconds, stop]);

  async function start() {
    try { recRef.current = await startVoiceRecording(); setSeconds(0); setRecording(true); } catch { toast(tt('micDenied'), 'error'); }
  }

  if (!supported) return <section className="rounded-lg border border-border bg-bg-secondary p-3 text-sm text-text-secondary">{tt('unsupported')}</section>;

  if (!consent) {
    return (
      <section className="space-y-3 rounded-lg border border-border bg-bg-secondary p-3">
        <h2 className="text-base font-semibold text-text-primary">{tt('consentTitle')}</h2>
        <p className="text-sm text-text-secondary">{tt('consentBody')}</p>
        <button type="button" className={btnPrimary} onClick={() => { giveConsent(); setConsent(true); }}>{tt('consentAccept')}</button>
      </section>
    );
  }

  const stateLabel = (s: QueuedRecording['state']) => ({ waiting: tt('queued'), uploading: tt('uploading'), processing: tt('processing'), failed: tt('failed') }[s]);

  return (
    <section className="space-y-3 rounded-lg border border-border bg-bg-secondary p-3" aria-labelledby="voice-log-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="voice-log-title" className="text-base font-semibold text-text-primary">{tt('title')}</h2>
        <span className="rounded-full bg-bg-tertiary px-2 py-1 text-xs font-medium text-text-secondary">{tt('aiBadge')}</span>
      </div>

      <label className="block text-sm text-text-secondary">{tt('language')}
        <select className={`${inputCls} mt-1`} value={lang} disabled={recording} onChange={(e) => setLang(e.target.value as VoiceLang)}>
          {VOICE_LANGS.map((l) => <option key={l} value={l}>{l === 'auto' ? tt('langAuto') : l.toUpperCase()}</option>)}
        </select>
      </label>

      <button type="button" onClick={recording ? () => void stop() : () => void start()} aria-pressed={recording}
        className={`flex min-h-[88px] w-full items-center justify-center gap-3 rounded-xl px-4 py-4 text-lg font-bold text-white ${recording ? 'bg-danger' : 'bg-accent'}`}>
        {recording ? <Square className="h-7 w-7" aria-hidden="true" /> : <Mic className="h-7 w-7" aria-hidden="true" />}
        <span>{recording ? tt('tapToStop') : tt('tapToSpeak')}</span>
      </button>

      <div role="status" aria-live="polite" className="space-y-1 text-sm text-text-secondary">
        {recording && <p className="motion-safe:animate-pulse font-medium text-danger">{tt('recording', { seconds })}</p>}
        {!online && <p className="flex items-center gap-1"><WifiOff className="h-4 w-4" aria-hidden="true" />{tt('offline')}</p>}
      </div>

      {queued.map((q) => (
        <div key={q.id} className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg-primary p-2 text-sm text-text-primary">
          <span className="flex items-center gap-2">
            {q.state !== 'failed' && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />}
            {q.state === 'failed' && <AlertTriangle className="h-4 w-4 text-danger" aria-hidden="true" />}
            {stateLabel(q.state)}
          </span>
          {q.state === 'failed' && (
            <span className="flex gap-2">
              <button type="button" className={btnGhost} onClick={() => { void processRecording(q.id, { force: true }).then(refresh); }}>{tt('retry')}</button>
              <button type="button" className={btnGhost} onClick={() => { void discardQueued(q.id).then(refresh); }}>{tt('discard')}</button>
            </span>
          )}
        </div>
      ))}

      {pending.length > 0 && (
        <p role="status" className="flex items-center gap-2 rounded-md border border-border bg-bg-primary p-2 text-sm text-text-primary">
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />{tt('pendingApprovals', { count: pending.length })}
        </p>
      )}

      {drafts.map((d) => <DraftCard key={d.id} draft={d} jobId={jobId} t={tt} onDone={() => { void refresh(); }} onApproved={setApprovedEx} />)}

      {approvedEx && <EstimateDraftCard extraction={approvedEx} onClose={() => setApprovedEx(null)} />}
    </section>
  );
}
