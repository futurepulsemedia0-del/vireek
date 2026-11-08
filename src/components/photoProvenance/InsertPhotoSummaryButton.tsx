import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { usePhotoProvenanceT } from '@/i18n/photoProvenanceNamespace';
import { appendSummaryWithinLimit, photoEvidencePlainText } from '@/lib/photoProvenance';
import { fetchPhotoSummary } from '@/lib/photoProvenanceApi';

/**
 * Dispute helper: appends the verified-photo summary (plain English, no coordinates) to a free-text evidence field.
 * Idempotent (a second click replaces the earlier block) and never truncates silently.
 */
export function InsertPhotoSummaryButton({ jobId, current, max, onInsert }: { jobId: string; current: string; max: number; onInsert: (next: string) => void }) {
  const { t } = usePhotoProvenanceT();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const { captures } = await fetchPhotoSummary(jobId);
      if (captures.length === 0) { toast(t('dispute.none'), 'info'); return; }
      const next = appendSummaryWithinLimit(current, photoEvidencePlainText(captures), max);
      if (next === null) { toast(t('dispute.tooLong'), 'warning'); return; }
      onInsert(next);
      toast(t('dispute.inserted'), 'success');
    } catch {
      toast(t('dispute.failed'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" size="xs" variant="secondary" loading={busy} onClick={() => void run()}>
      <ShieldCheck size={14} aria-hidden="true" />
      {t('dispute.insert')}
    </Button>
  );
}
