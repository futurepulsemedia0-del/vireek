import { useEffect, useRef, useState } from 'react';
import type { WidgetSettings } from '@/lib/websiteWidgets';

interface EngineApi {
  preview: (container: HTMLElement, payload: unknown, opts?: { contained?: boolean; startOpen?: boolean }) => { destroy: () => void };
}
type EngineWindow = Window & { __vireekWW?: { api?: EngineApi } };

let enginePromise: Promise<EngineApi> | null = null;

/** Loads the REAL embed script once (it exposes a preview API when it has no data-key), so the preview is pixel-faithful. */
export function loadWidgetEngine(): Promise<EngineApi> {
  if (enginePromise) return enginePromise;
  enginePromise = new Promise<EngineApi>((resolve, reject) => {
    const ready = () => (window as EngineWindow).__vireekWW?.api;
    const existing = ready();
    if (existing) return resolve(existing);
    const tag = document.createElement('script');
    tag.src = '/website-widgets.js';
    tag.async = true;
    tag.onload = () => {
      const api = ready();
      if (api) resolve(api);
      else reject(new Error('widget engine missing'));
    };
    tag.onerror = () => reject(new Error('widget engine failed to load'));
    document.head.appendChild(tag);
  }).catch((e) => {
    enginePromise = null;
    throw e;
  });
  return enginePromise;
}

interface Props {
  settings: WidgetSettings;
  data: Record<string, unknown> | null;
  theme: 'light' | 'dark';
}

/** Live preview of the actual widget. Network is stubbed inside the engine; nothing is submitted or counted. */
export function WidgetPreview({ settings, data, theme }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !data) return;
    let handle: { destroy: () => void } | null = null;
    let cancelled = false;
    // Debounced: typing in a field should not rebuild the widget on every keystroke.
    const timer = window.setTimeout(() => {
      loadWidgetEngine().then(
        (api) => {
          if (cancelled) return;
          const { widget_type, ...rest } = settings;
          handle = api.preview(el, { type: widget_type, settings: { ...rest, theme }, data }, { contained: true, startOpen: true });
        },
        () => !cancelled && setFailed(true),
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      handle?.destroy();
    };
  }, [settings, data, theme]);

  return (
    <div
      ref={ref}
      role="region"
      aria-label="Live preview of your widget"
      className={`relative h-[560px] w-full overflow-hidden rounded-2xl border border-border/80 ${theme === 'dark' ? 'bg-slate-800' : 'bg-slate-100'}`}
    >
      {!data && <p className="p-4 text-sm text-text-secondary">Loading preview…</p>}
      {failed && <p role="alert" className="p-4 text-sm text-danger">Preview unavailable — the widget script could not be loaded.</p>}
    </div>
  );
}
