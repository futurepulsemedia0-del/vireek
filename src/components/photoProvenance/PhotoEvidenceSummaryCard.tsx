import { useEffect, useState } from 'react';
import { Copy, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { usePhotoProvenanceT } from '@/i18n/photoProvenanceNamespace';
import { photoEvidencePlainText, summaryCounts, type PhotoCaptureView } from '@/lib/photoProvenance';
import { fetchPhotoSummary } from '@/lib/photoProvenanceApi';

/**
 * Read-only "verified photos" block for invoices and accepted quotes (linked to a job). Renders nothing when the job
 * has no sealed photos or the summary cannot be loaded, so it never adds noise to documents that don't need it.
 * The copied text is plain English for external readers and never contains coordinates.
 */
export function PhotoEvidenceSummaryCard({ jobId }: { jobId: string }) {
  const { t } = usePhotoProvenanceT();
  const { toast } = useToast();
  const [captures, setCaptures] = useState<PhotoCaptureView[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCaptures(null);
    fetchPhotoSummary(jobId)
      .then((s) => { if (!cancelled) setCaptures(s.captures); })
      .catch(() => { if (!cancelled) setCaptures([]); });
    return () => { cancelled = true; };
  }, [jobId]);

  if (!captures || captures.length === 0) return null;
  const counts = summaryCounts(captures);

  return (
    <section aria-labelledby={`pp-card-${jobId}`} className="rounded-xl border border-border bg-bg-primary p-4">
      <h2 id={`pp-card-${jobId}`} className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <ShieldCheck size={14} aria-hidden="true" />
        {t('card.title')}
      </h2>
      <p className="mt-2 text-sm text-text-primary">
        {t('summary.counts', { total: counts.total, unmodified: counts.unmodified, imported: counts.imported, offline: counts.offline, integrityFailed: counts.integrityFailed })}
      </p>
      <p className="mt-1 text-xs text-text-secondary">{t('card.note')}</p>
      <Button
        size="xs"
        variant="secondary"
        className="mt-3"
        onClick={() => {
          navigator.clipboard.writeText(photoEvidencePlainText(captures)).then(
            () => toast(t('card.copied'), 'success'),
            () => toast(photoEvidencePlainText(captures), 'info', { sticky: true }),
          );
        }}
      >
        <Copy size={14} aria-hidden="true" />
        {t('card.copy')}
      </Button>
      <p className="mt-2 text-xs text-text-secondary">{t('limits.summary')}</p>
    </section>
  );
}
