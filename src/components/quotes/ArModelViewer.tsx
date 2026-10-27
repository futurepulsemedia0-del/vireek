/**
 * 3D viewer + "View in your space" AR launcher, shared by the customer quote
 * page and the technician's scale-check preview.
 *
 * Why imperative: <model-viewer> is a web component. Creating it with
 * document.createElement keeps React 18 attribute quirks and JSX typings out
 * of the picture, and makes cleanup deterministic.
 *
 * AR is TRUE SIZE: `ar-scale="fixed"` stops the customer from pinching the
 * unit to a convenient size, so what they see on their wall / floor is what
 * gets installed. The GLB must be exported in metres (the glTF standard).
 *
 * AR modes (in order): Android Scene Viewer -> WebXR -> iOS Quick Look. If no
 * USDZ is supplied, model-viewer generates one from the GLB on the device.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { loadModelViewer } from '@/lib/loadModelViewer';
import { metersToDimensions, type ArPlacement, type Dimensions } from '@/lib/quoteAr';

interface ViewerElement extends HTMLElement {
  canActivateAR?: boolean;
  activateAR?: () => Promise<void> | void;
  getDimensions?: () => { x: number; y: number; z: number };
}

export interface ArReadyInfo {
  canActivateAR: boolean;
  /** Real size measured from the loaded model (null if the element cannot report it). */
  measured: Dimensions | null;
}

interface Props {
  name: string;
  glbUrl: string;
  usdzUrl: string | null;
  placement: ArPlacement;
  /** Rendered under the viewer when the device cannot do AR (e.g. a QR code for the phone). */
  fallback?: ReactNode;
  onReady?: (info: ArReadyInfo) => void;
  onArLaunched?: () => void;
  onArFailed?: () => void;
  /** Called when the model cannot be loaded (e.g. an expired signed URL). */
  onLoadError?: () => void;
  /** Called when the person taps "Try again" so the parent can fetch fresh URLs. */
  onRetry?: () => void;
}

type ViewerState = 'loading' | 'ready' | 'error';

const AR_CHECK_TRIES = 5;
const AR_CHECK_INTERVAL_MS = 300;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export function ArModelViewer({
  name,
  glbUrl,
  usdzUrl,
  placement,
  fallback,
  onReady,
  onArLaunched,
  onArFailed,
  onLoadError,
  onRetry,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<ViewerElement | null>(null);
  const [state, setState] = useState<ViewerState>('loading');
  const [progress, setProgress] = useState(0);
  const [canAr, setCanAr] = useState(false);
  const [arChecked, setArChecked] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Keep the latest callbacks without re-creating the 3D element when they change.
  const cb = useRef({ onReady, onArLaunched, onArFailed, onLoadError });
  useEffect(() => {
    cb.current = { onReady, onArLaunched, onArFailed, onLoadError };
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let el: ViewerElement | null = null;
    const timers: number[] = [];
    setState('loading');
    setProgress(0);
    setCanAr(false);
    setArChecked(false);

    // model-viewer works out AR support asynchronously after the model loads
    // (WebXR needs a device query), so poll briefly before concluding "no AR".
    const checkAr = (measured: Dimensions | null, tries: number) => {
      if (cancelled || !el) return;
      const can = Boolean(el.canActivateAR);
      if (can || tries >= AR_CHECK_TRIES) {
        setCanAr(can);
        setArChecked(true);
        cb.current.onReady?.({ canActivateAR: can, measured });
        return;
      }
      timers.push(window.setTimeout(() => checkAr(measured, tries + 1), AR_CHECK_INTERVAL_MS));
    };
    const onLoad = () => {
      if (cancelled || !el) return;
      let measured: Dimensions | null = null;
      try {
        const d = el.getDimensions?.();
        if (d && Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.z)) {
          measured = metersToDimensions(d.x, d.y, d.z);
        }
      } catch {
        measured = null;
      }
      setState('ready');
      checkAr(measured, 0);
    };
    const onError = () => {
      if (cancelled) return;
      setState('error');
      cb.current.onLoadError?.();
    };
    const onProgress = (event: Event) => {
      const total = (event as CustomEvent<{ totalProgress?: number }>).detail?.totalProgress;
      if (typeof total === 'number' && Number.isFinite(total)) setProgress(Math.min(1, Math.max(0, total)));
    };
    const onArStatus = (event: Event) => {
      if ((event as CustomEvent<{ status?: string }>).detail?.status === 'failed') cb.current.onArFailed?.();
    };

    loadModelViewer()
      .then(() => {
        if (cancelled) return;
        el = document.createElement('model-viewer') as ViewerElement;
        el.setAttribute('src', glbUrl);
        if (usdzUrl) el.setAttribute('ios-src', usdzUrl);
        el.setAttribute('alt', `3D model of ${name}`);
        el.setAttribute('camera-controls', '');
        el.setAttribute('touch-action', 'pan-y');
        el.setAttribute('shadow-intensity', '1');
        el.setAttribute('shadow-softness', '0.8');
        el.setAttribute('environment-image', 'neutral');
        el.setAttribute('ar', '');
        el.setAttribute('ar-modes', 'scene-viewer webxr quick-look');
        el.setAttribute('ar-scale', 'fixed');
        el.setAttribute('ar-placement', placement);
        if (!prefersReducedMotion()) el.setAttribute('auto-rotate', '');
        el.style.width = '100%';
        el.style.height = '100%';
        el.style.display = 'block';
        el.addEventListener('load', onLoad);
        el.addEventListener('error', onError);
        el.addEventListener('progress', onProgress);
        el.addEventListener('ar-status', onArStatus);
        host.appendChild(el);
        elRef.current = el;
      })
      .catch(() => {
        if (cancelled) return;
        setState('error');
        cb.current.onLoadError?.();
      });

    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
      if (el) {
        el.removeEventListener('load', onLoad);
        el.removeEventListener('error', onError);
        el.removeEventListener('progress', onProgress);
        el.removeEventListener('ar-status', onArStatus);
        el.remove();
      }
      elRef.current = null;
    };
  }, [glbUrl, usdzUrl, name, placement, attempt]);

  const launchAr = useCallback(() => {
    const el = elRef.current;
    if (!el?.activateAR) return;
    // Must run synchronously inside the tap: iOS Quick Look requires a user gesture.
    try {
      const result: unknown = el.activateAR();
      cb.current.onArLaunched?.();
      if (result instanceof Promise) result.catch(() => cb.current.onArFailed?.());
    } catch {
      cb.current.onArFailed?.();
    }
  }, []);

  const retry = () => {
    onRetry?.();
    setAttempt((a) => a + 1);
  };

  const percent = Math.round(progress * 100);

  return (
    <div>
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-bg-tertiary">
        <div ref={hostRef} className="absolute inset-0" />

        {state === 'loading' ? (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg-tertiary/80 px-6 text-center"
          >
            <p className="text-sm font-medium text-text-primary">Loading 3D model…</p>
            <div
              role="progressbar"
              aria-label="Model download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-1.5 w-40 overflow-hidden rounded-full bg-border"
            >
              <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : null}

        {state === 'error' ? (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg-tertiary px-6 text-center">
            <p className="text-sm text-text-primary">We couldn’t load this 3D preview.</p>
            <Button size="sm" variant="secondary" onClick={retry}>
              <RefreshCw size={14} aria-hidden="true" /> Try again
            </Button>
          </div>
        ) : null}
      </div>

      <div className="mt-3 space-y-3">
        {state === 'ready' && arChecked && canAr ? (
          <Button className="w-full sm:w-auto" onClick={launchAr}>
            <Smartphone size={16} aria-hidden="true" /> View in your space
          </Button>
        ) : null}
        {state === 'ready' && arChecked && !canAr ? fallback : null}
      </div>
    </div>
  );
}
