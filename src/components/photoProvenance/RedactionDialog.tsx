import { useEffect, useRef, useState } from 'react';
import { Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { usePhotoProvenanceT } from '@/i18n/photoProvenanceNamespace';
import { normalizeRegions, type RedactionRegion } from '@/lib/photoProvenance';
import { createRedactedCopy, downloadPhotoBlob } from '@/lib/photoProvenanceApi';

interface Props {
  open: boolean;
  jobId: string;
  captureId: string;
  originalSha256: string;
  originalPath: string;
  onClose: () => void;
  onSaved: () => void;
}

const pct = (n: number) => Math.round(n * 1000) / 10;

/**
 * Manual redaction (people / faces / sensitive areas). Drag to draw boxes, OR use the numeric fields (a single-pointer,
 * non-dragging alternative per WCAG 2.5.7). Boxes are burned into a NEW copy (EXIF dropped); the original is never changed.
 * Automatic face detection is intentionally not offered: it is not reliable enough to promise privacy.
 */
export function RedactionDialog({ open, jobId, captureId, originalSha256, originalPath, onClose, onSaved }: Props) {
  const { t } = usePhotoProvenanceT();
  const { toast } = useToast();
  const dialogRef = useFocusTrap(open);
  useEscapeToClose(open, onClose);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [regions, setRegions] = useState<RedactionRegion[]>([]);
  const [kind, setKind] = useState<RedactionRegion['kind']>('person');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<RedactionRegion | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    let revoked: string | null = null;
    let cancelled = false;
    setRegions([]);
    downloadPhotoBlob(originalPath)
      .then((b) => {
        if (cancelled) return;
        setBlob(b);
        revoked = URL.createObjectURL(b);
        setUrl(revoked);
      })
      .catch(() => toast(t('redact.failed'), 'error'));
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
      setUrl(null);
      setBlob(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, originalPath]);

  if (!open) return null;

  const point = (e: React.PointerEvent): { x: number; y: number } => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = point(e);
    setDraft({ x: start.current.x, y: start.current.y, w: 0, h: 0, kind });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const p = point(e);
    setDraft({ x: start.current.x, y: start.current.y, w: p.x - start.current.x, h: p.y - start.current.y, kind });
  };
  const onUp = () => {
    if (draft) setRegions((r) => normalizeRegions([...r, draft]));
    start.current = null;
    setDraft(null);
  };

  const update = (i: number, key: 'x' | 'y' | 'w' | 'h', valuePct: number) => {
    if (!Number.isFinite(valuePct)) return;
    setRegions((rs) => normalizeRegions(rs.map((r, idx) => (idx === i ? { ...r, [key]: Math.min(100, Math.max(0, valuePct)) / 100 } : r))));
  };

  async function save() {
    if (!blob || !regions.length) { toast(t('redact.noRegions'), 'warning'); return; }
    setSaving(true);
    try {
      await createRedactedCopy({ captureId, jobId, originalSha256, source: blob, regions });
      toast(t('redact.saved'), 'success');
      onSaved();
      onClose();
    } catch {
      toast(t('redact.failed'), 'error');
    } finally {
      setSaving(false);
    }
  }

  const shown = draft ? [...regions, draft] : regions;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg-primary/80 p-4" role="presentation">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="pp-redact-title" className="max-h-full w-full max-w-3xl overflow-auto rounded-xl border border-border bg-bg-secondary p-4">
        <h3 id="pp-redact-title" className="text-base font-semibold text-text-primary">{t('redact.title')}</h3>
        <p className="mt-1 text-sm text-text-secondary">{t('redact.help')}</p>

        <div className="mt-3 flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t('redact.title')}>
          {(['person', 'sensitive'] as const).map((k) => (
            <Button key={k} size="xs" variant="secondary" selected={kind === k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>
              {t(`redact.${k}`)}
            </Button>
          ))}
          <Button size="xs" variant="ghost" onClick={() => setRegions((r) => r.slice(0, -1))} disabled={!regions.length}>
            <Undo2 size={14} aria-hidden="true" />
            {t('redact.undo')}
          </Button>
        </div>

        <div
          ref={stage}
          role="img"
          aria-label={t('redact.canvas')}
          className="relative mt-3 touch-none select-none overflow-hidden rounded-lg border border-border bg-bg-primary"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {url && <img src={url} alt="" draggable={false} className="block max-h-[60vh] w-full object-contain" />}
          {shown.map((r, i) => (
            <div
              key={i}
              aria-hidden="true"
              className="absolute border-2 border-cta bg-text-primary/90"
              style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
            />
          ))}
        </div>

        {regions.length > 0 && (
          <ul className="mt-3 space-y-2">
            {regions.map((r, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                <span className="font-semibold text-text-primary">{i + 1}. {t(`redact.${r.kind}`)}</span>
                {(['x', 'y', 'w', 'h'] as const).map((k) => (
                  <label key={k} className="flex items-center gap-1">
                    <span>{k.toUpperCase()} %</span>
                    <input
                      type="number" min={0} max={100} step={0.5} value={pct(r[k])}
                      onChange={(e) => update(i, k, Number(e.target.value))}
                      className="focus-ring w-20 rounded-md border border-border bg-bg-primary px-2 py-1 text-text-primary"
                    />
                  </label>
                ))}
                <Button size="xs" variant="ghost" iconOnly aria-label={t('redact.undo')} onClick={() => setRegions((rs) => rs.filter((_, idx) => idx !== i))}>
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>{t('redact.cancel')}</Button>
          <Button size="sm" onClick={() => void save()} loading={saving} disabled={!regions.length || !blob}>{t('redact.save')}</Button>
        </div>
      </div>
    </div>
  );
}
