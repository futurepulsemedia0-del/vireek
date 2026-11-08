import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { usePhotoProvenanceT } from '@/i18n/photoProvenanceNamespace';
import { isNative } from '@/lib/native/platform';
import { takeNativePhoto } from '@/lib/native/camera';
import { capturePhoto, getQueueStats, startPhotoQueueAutoFlush, subscribeQueue, type QueueStats } from '@/lib/photoProvenanceApi';

/**
 * In-app capture for evidence photos.
 *  - App (Capacitor): the native camera -> source `in_app_camera`.
 *  - Browser: a file input with `capture` -> source `web_input` (the browser cannot prove it came from the camera).
 *  - "Import from gallery" -> source `gallery_import` (always labelled as imported).
 * The photo is fingerprinted and queued on the device first, so a dead zone never loses it.
 */
export function PhotoCaptureButton({ jobId, onSaved }: { jobId: string; onSaved?: () => void }) {
  const { t } = usePhotoProvenanceT();
  const { toast } = useToast();
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<QueueStats>({ pending: 0, failed: 0, offline: 0 });

  useEffect(() => {
    startPhotoQueueAutoFlush();
    const refresh = () => { void getQueueStats(jobId).then(setStats); };
    refresh();
    return subscribeQueue(refresh);
  }, [jobId]);

  async function save(file: File, source: 'in_app_camera' | 'gallery_import' | 'web_input') {
    setBusy(true);
    try {
      const { delivered } = await capturePhoto({ file, jobId, source });
      toast(t(delivered ? 'capture.saved' : 'capture.queued'), delivered ? 'success' : 'info');
      onSaved?.();
    } catch (e) {
      toast(e instanceof Error && e.message === 'unsupported_image_type' ? t('capture.unsupported') : t('capture.failed'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onTake() {
    if (isNative()) {
      const file = await takeNativePhoto().catch(() => null);
      if (file) await save(file, 'in_app_camera');
      return;
    }
    cameraInput.current?.click();
  }

  const onPicked = (source: 'web_input' | 'gallery_import') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void save(file, source);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => void onTake()} loading={busy} loadingLabel={t('capture.taking')}>
        <Camera size={16} aria-hidden="true" />
        {t('capture.take')}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => galleryInput.current?.click()} disabled={busy}>
        <ImagePlus size={16} aria-hidden="true" />
        {t('capture.import')}
      </Button>
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onPicked('web_input')} />
      <input ref={galleryInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onPicked('gallery_import')} />
      <p className="text-xs text-text-secondary" role="status" aria-live="polite">
        {stats.pending > 0 && t('capture.queue', { pending: stats.pending })}
        {stats.failed > 0 && <span className="ms-2 text-danger">{t('capture.queueFailed', { failed: stats.failed })}</span>}
      </p>
    </div>
  );
}
