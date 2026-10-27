/**
 * Customer side of the AR Product Visualizer (rendered on the public /quote/:token page).
 * Supplementary by design: if there are no previews, the quote is already
 * answered, or loading fails, this renders nothing and the normal quote /
 * accept flow is untouched.
 *
 *  - lists the equipment the technician attached, with real-world dimensions
 *  - opens ONE 3D viewer at a time (keeps memory + data use low on phones)
 *  - "View in your space" launches AR at true size on supported phones
 *  - on desktop / unsupported devices, offers a QR code to continue on a phone
 *  - reports views / AR launches so the technician knows the customer engaged
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Ruler } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ArModelViewer, type ArReadyInfo } from '@/components/quotes/ArModelViewer';
import {
  AR_CATEGORY_LABELS,
  detectPlatform,
  formatDimensions,
  formatLength,
  modelSubtitle,
  optionLabel,
  optionRefs,
  publicDimensions,
  type ArUnit,
  type PublicArPreview,
} from '@/lib/quoteAr';
import { fetchPublicArPreviews, trackArEvent } from '@/lib/quoteArApi';

/** Signed URLs last 30 minutes; refresh before opening if the list is older than this. */
const STALE_AFTER_MS = 20 * 60 * 1000;

interface Props {
  token: string;
  /** Hidden once the customer has accepted / declined. */
  quoteOpen: boolean;
  /** `quote.options` as delivered by the public quote RPC (shape-checked inside). */
  rawOptions?: unknown;
}

function QrFallback({ platform }: { platform: ReturnType<typeof detectPlatform> }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const desktop = platform === 'desktop';

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void import('qrcode')
      .then((mod) => mod.default.toDataURL(window.location.href, { margin: 1, width: 176 }))
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  return (
    <div role="status" className="flex flex-col items-start gap-3 rounded-xl border border-border bg-bg-primary p-3 sm:flex-row sm:items-center">
      {desktop && dataUrl ? (
        <img src={dataUrl} width={88} height={88} alt="QR code that opens this quote on your phone" className="rounded-lg bg-white p-1" />
      ) : null}
      <p className="text-sm text-text-secondary">
        {desktop
          ? 'AR works on phones and tablets. Scan the code with your phone camera to open this quote and place the equipment in your room.'
          : 'This device can’t place objects in AR. You can still rotate the model above, or open this quote on a newer phone or tablet to see it in your space.'}
      </p>
    </div>
  );
}

export function QuoteArSection({ token, quoteOpen, rawOptions }: Props) {
  const [previews, setPreviews] = useState<PublicArPreview[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [unit, setUnit] = useState<ArUnit>('in');
  const loadedAtRef = useRef(0);
  const platform = useMemo(
    () => detectPlatform(typeof navigator !== 'undefined' ? navigator.userAgent : '', typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0),
    [],
  );
  const refs = useMemo(() => optionRefs(rawOptions), [rawOptions]);

  const refresh = useCallback(async () => {
    const state = await fetchPublicArPreviews(token);
    if (state) {
      loadedAtRef.current = Date.now();
      setPreviews(state.previews);
    }
    return state;
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void fetchPublicArPreviews(token).then((state) => {
      if (cancelled) return;
      loadedAtRef.current = Date.now();
      setPreviews(state?.previews ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const toggle = async (preview: PublicArPreview) => {
    if (openId === preview.id) {
      setOpenId(null);
      return;
    }
    if (Date.now() - loadedAtRef.current > STALE_AFTER_MS) await refresh();
    setOpenId(preview.id);
    trackArEvent(token, preview.id, 'viewed', platform);
  };

  if (!quoteOpen || !previews || previews.length === 0) return null;
  const showOptionLabel = refs.length > 1;

  return (
    <section className="mx-auto w-full max-w-5xl px-4 pt-8" aria-labelledby="qar-heading">
      <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark sm:p-5">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="qar-heading" className="flex items-center gap-2 text-base font-semibold text-text-primary">
              <Box size={16} aria-hidden="true" /> See it in your space
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              Preview the equipment in 3D, then place it at real size in your own room with your phone’s camera.
            </p>
          </div>
          <div role="group" aria-label="Measurement units" className="flex shrink-0 overflow-hidden rounded-xl border border-border">
            {(['in', 'cm'] as const).map((u) => (
              <button
                key={u}
                type="button"
                aria-pressed={unit === u}
                onClick={() => setUnit(u)}
                className={`focus-ring min-h-[40px] px-4 text-sm font-medium transition-colors ${
                  unit === u ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary hover:text-text-primary'
                }`}
              >
                {u === 'in' ? 'Inches' : 'cm'}
              </button>
            ))}
          </div>
        </div>

        <ul className="space-y-3">
          {previews.map((p) => {
            const open = openId === p.id;
            const subtitle = modelSubtitle(p);
            return (
              <li key={p.id} className="rounded-xl border border-border bg-bg-primary p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold text-text-primary">{p.name}</p>
                    <p className="text-xs text-text-secondary">
                      {AR_CATEGORY_LABELS[p.category] ?? 'Equipment'}
                      {subtitle ? ` · ${subtitle}` : ''}
                      {showOptionLabel && p.option_id ? ` · ${optionLabel(p.option_id, refs)}` : ''}
                    </p>
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-text-secondary">
                      <Ruler size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>
                        {formatDimensions(publicDimensions(p), unit)}
                        {p.clearance_mm > 0 ? ` · allow ${formatLength(p.clearance_mm, unit)} clear in front for service` : ''}
                      </span>
                    </p>
                  </div>
                  <Button size="sm" variant={open ? 'secondary' : 'primary'} aria-expanded={open} onClick={() => void toggle(p)}>
                    {open ? 'Close preview' : 'Preview in 3D / AR'}
                  </Button>
                </div>

                {open ? (
                  <div className="mt-3">
                    <ArModelViewer
                      name={p.name}
                      glbUrl={p.glb_url}
                      usdzUrl={p.usdz_url}
                      placement={p.placement}
                      onReady={(info: ArReadyInfo) => {
                        if (!info.canActivateAR) trackArEvent(token, p.id, 'ar_unsupported', platform);
                      }}
                      onArLaunched={() => trackArEvent(token, p.id, 'ar_launched', platform)}
                      onArFailed={() => trackArEvent(token, p.id, 'ar_failed', platform)}
                      onRetry={() => void refresh()}
                      fallback={<QrFallback platform={platform} />}
                    />
                    <p className="mt-3 text-xs text-text-secondary">
                      Shown at true size. Point your camera at the floor{p.placement === 'wall' ? ' or wall' : ''} and move slowly so your phone can
                      find the surface. The preview is for visualisation only — final fit is confirmed at installation.
                    </p>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
