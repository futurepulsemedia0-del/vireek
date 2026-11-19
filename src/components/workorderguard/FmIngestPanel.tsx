import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { ClipboardList } from 'lucide-react';
import { importOrders } from '@/lib/workOrderGuardApi';
import { parseForwardedEmail, FIELD_LABELS, type ImportResult } from '@/lib/workOrderGuardImport';
import {
  getIngestText, IngestError, listIngestItems, markIngest, originalDownloadUrl, uploadPdf, type IngestItem,
} from '@/lib/fmIngestApi';
import { useFmcheckT } from '@/i18n/fmcheckNamespace';

interface Props { profileId: string; timezone: string; onImported: () => void }
type Load = { status: 'loading' | 'error' | 'ready'; items: IngestItem[] };

/** PDF upload + forwarded-email inbox. Everything is reviewed by the manager before the existing Guard import runs. */
export function FmIngestPanel({ profileId, timezone, onImported }: Props) {
  const { t } = useFmcheckT();
  const { toast } = useToast();
  const [load, setLoad] = useState<Load>({ status: 'loading', items: [] });
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ item: IngestItem; result: ImportResult } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try { setLoad({ status: 'ready', items: await listIngestItems() }); }
    catch { setLoad({ status: 'error', items: [] }); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const errMsg = (e: unknown): string => {
    const code = e instanceof IngestError ? e.code : 'upload_failed';
    return t(`ingest.error.${code}`, { defaultValue: t('ingest.error.upload_failed') });
  };

  const onFile = async (f: File | undefined) => {
    if (!f || busy) return;
    setBusy(true);
    try {
      const r = await uploadPdf(f);
      toast(r.duplicate ? t('ingest.duplicate') : t('ingest.uploaded'), 'success');
    } catch (e) { toast(errMsg(e), 'error'); }
    finally { setBusy(false); await refresh(); }
  };

  const openReview = async (item: IngestItem) => {
    if (busy) return;
    setBusy(true);
    try {
      const text = await getIngestText(item.id);
      setReview({ item, result: parseForwardedEmail(text, { timezone }) });
    } catch { toast(t('ingest.loadFailed'), 'error'); }
    finally { setBusy(false); }
  };

  const doImport = async () => {
    if (!review || busy || review.result.orders.length === 0) return;
    setBusy(true);
    try {
      const s = await importOrders(profileId, 'email', review.item.originalName ?? 'forwarded email', review.result.orders);
      await markIngest(review.item.id, 'imported', s.batchIds[0]);
      toast(t('ingest.imported'), 'success');
      setReview(null); onImported();
    } catch (e) { toast(e instanceof Error ? e.message : t('ingest.error.upload_failed'), 'error'); }
    finally { setBusy(false); await refresh(); }
  };

  const dismiss = async (item: IngestItem) => {
    if (busy) return;
    setBusy(true);
    try { await markIngest(item.id, 'dismissed'); } catch { toast(t('ingest.error.upload_failed'), 'error'); }
    finally { setBusy(false); await refresh(); }
  };

  const download = async (item: IngestItem) => {
    if (!item.originalPath) return;
    try { window.location.assign(await originalDownloadUrl(item.originalPath, item.originalName ?? 'original')); }
    catch { toast(t('ingest.error.upload_failed'), 'error'); }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h2 className="text-base font-semibold text-text-primary">{t('ingest.title')}</h2>
        <p className="mt-1 text-sm text-text-secondary">{t('ingest.intro')}</p>
        <label className="focus-ring mt-3 inline-flex min-h-[48px] cursor-pointer items-center rounded-xl bg-accent px-5 font-semibold text-on-accent">
          {busy ? t('ingest.uploading') : t('ingest.upload')}
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="sr-only" disabled={busy}
            onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <p className="mt-2 text-xs text-text-secondary">{t('ingest.dropHint')}</p>
      </section>

      <section aria-labelledby="fm-ingest-list" className="space-y-2">
        <h3 id="fm-ingest-list" className="text-sm font-semibold text-text-primary">{t('ingest.listTitle')}</h3>
        {load.status === 'loading' && <p className="text-sm text-text-secondary" role="status">{t('ingest.loading')}</p>}
        {load.status === 'error' && <EmptyState icon={ClipboardList} variant="load-failed" title={t('ingest.loadFailed')} action={{ label: t('ingest.retry'), onClick: () => { void refresh(); } }} />}
        {load.status === 'ready' && load.items.length === 0 && <p className="text-sm text-text-secondary">{t('ingest.empty')}</p>}
        {load.status === 'ready' && load.items.length > 0 && (
          <ul className="space-y-2">
            {load.items.map((it) => (
              <li key={it.id} className="rounded-xl border border-border bg-bg-secondary px-3 py-3 text-sm">
                <p className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-text-primary">{t(`ingest.channel.${it.channel}`)} · {it.originalName ?? it.subject ?? '—'}</span>
                  <span className="text-xs text-text-secondary">{t(`ingest.status.${it.status}`)}</span>
                </p>
                {it.sender && <p className="text-xs text-text-secondary">{t('ingest.from')}: <bdi>{it.sender}</bdi></p>}
                {it.status === 'rejected' && it.rejectCode && <p className="text-xs text-danger">{t(`ingest.reject.${it.rejectCode}`, { defaultValue: it.rejectCode })}</p>}
                {it.status === 'needs_ocr' && <p className="text-xs text-text-secondary">{t('ingest.needsOcrHint')}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {it.status === 'ready' && <Button size="sm" onClick={() => void openReview(it)} disabled={busy}>{t('ingest.review')}</Button>}
                  {it.originalPath && <Button size="sm" variant="secondary" onClick={() => void download(it)}>{t('ingest.download')}</Button>}
                  {(it.status === 'ready' || it.status === 'needs_ocr' || it.status === 'rejected') && <Button size="sm" variant="ghost" onClick={() => void dismiss(it)} disabled={busy}>{t('ingest.dismiss')}</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {review && (
        <section role="dialog" aria-modal="false" aria-labelledby="fm-ingest-review" className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4" aria-live="polite">
          <h3 id="fm-ingest-review" className="text-base font-semibold text-text-primary">{t('ingest.reviewTitle')}</h3>
          {review.item.subject && <p className="text-xs text-text-secondary">{t('ingest.subject')}: <bdi>{review.item.subject}</bdi></p>}
          {review.result.missingRequired.length > 0 && (
            <p role="alert" className="text-sm text-danger">{t('ingest.missing', { fields: review.result.missingRequired.map((f) => FIELD_LABELS[f]).join(', ') })}</p>
          )}
          {review.result.errors.length > 0 && <p className="text-xs text-warning">{t('ingest.problems', { count: review.result.errors.length })}: {review.result.errors.slice(0, 3).map((e) => e.message).join(' · ')}</p>}
          {review.result.orders.map((o) => (
            <dl key={o.woNumber} className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-text-secondary">{FIELD_LABELS.woNumber}</dt><dd className="text-text-primary"><bdi>{o.woNumber}</bdi></dd>
              <dt className="text-text-secondary">{FIELD_LABELS.receivedAt}</dt><dd className="text-text-primary"><bdi>{o.receivedAt}</bdi></dd>
              {o.nteCents != null && <><dt className="text-text-secondary">{FIELD_LABELS.nte}</dt><dd className="text-text-primary"><bdi>{(o.nteCents / 100).toFixed(2)}</bdi></dd></>}
              {o.location && <><dt className="text-text-secondary">{FIELD_LABELS.location}</dt><dd className="text-text-primary"><bdi>{o.location}</bdi></dd></>}
            </dl>
          ))}
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void doImport()} disabled={busy || review.result.orders.length === 0}>{busy ? t('ingest.importing') : t('ingest.import')}</Button>
            <Button variant="ghost" onClick={() => setReview(null)} disabled={busy}>{t('ingest.close')}</Button>
          </div>
        </section>
      )}
    </div>
  );
}
