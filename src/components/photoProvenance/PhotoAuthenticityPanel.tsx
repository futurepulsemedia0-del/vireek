import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, Info, Loader2, RefreshCw, ScanSearch } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { usePhotoProvenanceT } from '@/i18n/photoProvenanceNamespace';
import { PhotoStatusBadge } from '@/components/photoProvenance/PhotoStatusBadge';
import type { PhotoCaptureView } from '@/lib/photoProvenance';
import {
  c2paLineKey, capturesToAnalyse, confidenceBarPercent, orderedReasons,
  type AuthenticityReason, type StoredAuthenticity,
} from '@/lib/photoAuthenticity';
import { fetchAuthenticity, requestAuthenticity } from '@/lib/photoAuthenticityApi';
import { fetchPhotoSummary } from '@/lib/photoProvenanceApi';

const EFFECT_ICON = { supports: CircleCheck, weakens: CircleAlert, info: Info } as const;
const EFFECT_CLASS = { supports: 'text-success', weakens: 'text-warning', info: 'text-text-secondary' } as const;

function ReasonItem({ reason }: { reason: AuthenticityReason }) {
  const { t } = usePhotoProvenanceT();
  const Icon = EFFECT_ICON[reason.effect];
  const key = `authenticity.reason.${reason.code}`;
  // Unknown codes (e.g. produced by a newer analyzer) fall back to a neutral sentence instead of showing a raw key.
  const text = t(key, { ...reason.detail, defaultValue: t('authenticity.reason.unknown') });
  return (
    <li className="flex items-start gap-2 text-sm text-text-primary">
      <Icon size={14} className={`mt-0.5 shrink-0 ${EFFECT_CLASS[reason.effect]}`} aria-hidden="true" />
      <span>
        <span className="sr-only">{t(`authenticity.effect.${reason.effect}`)}: </span>
        {text}
      </span>
    </li>
  );
}

function ReportBlock({ capture, stored }: { capture: PhotoCaptureView; stored: StoredAuthenticity }) {
  const { t } = usePhotoProvenanceT();
  const { consistency: c, c2pa } = stored.report;
  const percent = confidenceBarPercent(c);
  const problems = c2pa.problems.map((p) => t(`authenticity.c2pa.problem.${p}`, { defaultValue: p })).join(', ');
  return (
    <div className="mt-2 space-y-3">
      <div>
        <p className="text-xs font-semibold text-text-secondary">{t('authenticity.scoreLabel')}</p>
        {c.confidence === null ? (
          <>
            <p className="text-sm font-medium text-text-primary">{t(`authenticity.level.${c.level}`)}</p>
            <p className="text-xs text-text-secondary">{t('authenticity.insufficientHelp')}</p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-text-primary">
              {t(`authenticity.level.${c.level}`)} · {t('authenticity.score', { score: c.confidence })}
            </p>
            <div
              role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
              aria-label={`${t('authenticity.scoreLabel')} (${capture.short_id})`}
              className="mt-1 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-bg-secondary"
            >
              <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
            </div>
          </>
        )}
      </div>

      {c.reasons.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-text-secondary">{t('authenticity.reasonsTitle')}</p>
          <ul className="mt-1 space-y-1">
            {orderedReasons(c.reasons).map((r, i) => <ReasonItem key={`${r.code}-${i}`} reason={r} />)}
          </ul>
        </div>
      )}

      <div>
        <p className="text-xs font-semibold text-text-secondary">{t('authenticity.c2pa.title')}</p>
        <p className="text-sm text-text-primary">{t(`authenticity.c2pa.line.${c2paLineKey(c2pa)}`, { problems })}</p>
        {c2pa.status === 'read' && c2pa.signer?.commonName && (
          <p className="text-xs text-text-secondary">{t('authenticity.c2pa.signedBy', { name: c2pa.signer.commonName })}</p>
        )}
        {c2pa.declaresGeneratedMedia && <p className="text-xs text-text-secondary">{t('authenticity.c2pa.declaresGenerated')}</p>}
        {c2pa.declaresEdits && <p className="text-xs text-text-secondary">{t('authenticity.c2pa.declaresEdits')}</p>}
      </div>
    </div>
  );
}

/**
 * Per-photo authenticity checks for a job, for dispute and warranty evidence views.
 * Shows a confidence WITH reasons and the C2PA reading; never a verdict. Checks run only when asked (they read the stored original).
 */
export function PhotoAuthenticityPanel({ jobId }: { jobId: string }) {
  const { t } = usePhotoProvenanceT();
  const { toast } = useToast();
  const [captures, setCaptures] = useState<PhotoCaptureView[] | null>(null);
  const [reports, setReports] = useState<Map<string, StoredAuthenticity>>(new Map());
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(false);
    setCaptures(null);
    try {
      const [summary, stored] = await Promise.all([fetchPhotoSummary(jobId), fetchAuthenticity(jobId)]);
      setCaptures(summary.captures);
      setReports(stored);
    } catch {
      setError(true);
    }
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);

  const pending = useMemo(() => (captures ? capturesToAnalyse(captures, reports) : []), [captures, reports]);

  async function analyse(ids: string[]) {
    setBusy((b) => new Set([...b, ...ids]));
    let failed = 0;
    for (const id of ids) {
      try {
        await requestAuthenticity(id);
      } catch {
        failed++;
      }
      setBusy((b) => { const n = new Set(b); n.delete(id); return n; });
    }
    if (failed > 0) toast(t('authenticity.analyzeFailed'), 'error');
    try { setReports(await fetchAuthenticity(jobId)); } catch { setError(true); }
  }

  return (
    <section aria-labelledby={`pa-title-${jobId}`} className="rounded-xl border border-border bg-bg-primary p-4">
      <h3 id={`pa-title-${jobId}`} className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <ScanSearch size={14} aria-hidden="true" />
        {t('authenticity.title')}
      </h3>
      <p className="mt-1 text-xs text-text-secondary">{t('authenticity.intro')}</p>
      <p className="mt-1 rounded-lg border border-border bg-bg-secondary p-2 text-xs text-text-secondary" role="note">{t('authenticity.notVerdict')}</p>

      {error ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-danger" role="alert">
          <span>{t('authenticity.loadFailed')}</span>
          <Button size="xs" variant="secondary" onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />{t('authenticity.retry')}</Button>
        </div>
      ) : captures === null ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-text-secondary" role="status"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('authenticity.loading')}</p>
      ) : captures.length === 0 ? (
        <p className="mt-3 text-sm text-text-secondary">{t('authenticity.empty')}</p>
      ) : (
        <>
          {pending.length > 0 && (
            <Button size="xs" variant="secondary" className="mt-3" loading={pending.some((id) => busy.has(id))} onClick={() => void analyse(pending)}>
              <ScanSearch size={14} aria-hidden="true" />
              {t('authenticity.runAll', { count: pending.length })}
            </Button>
          )}
          <ul className="mt-3 space-y-3">
            {captures.map((c) => {
              const stored = reports.get(c.id);
              return (
                <li key={c.id} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{t('authenticity.photo', { id: c.short_id })}</span>
                    <PhotoStatusBadge status={c.status} />
                  </div>
                  {stored ? (
                    <ReportBlock capture={c} stored={stored} />
                  ) : c.files_erased ? (
                    <p className="mt-2 text-xs text-text-secondary">{t('authenticity.erased')}</p>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-text-secondary">{t('authenticity.notChecked')}</span>
                      <Button size="xs" variant="secondary" loading={busy.has(c.id)} onClick={() => void analyse([c.id])}>{t('authenticity.run')}</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
