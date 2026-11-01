import type { Metric } from 'web-vitals';
import { hasAnalyticsConsent, onAnalyticsConsent } from '@/lib/analytics';
import { isNative } from '@/lib/native/platform';
import {
  buildPayloads,
  connClassFor,
  deviceClassFor,
  type BufferedMetric,
  type NavType,
  type VitalName,
  type VitalsPayload,
} from '@/lib/perf/vitals';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const RELEASE = (import.meta.env.VITE_RELEASE as string | undefined) ?? 'dev';
const SAMPLE_RATE = Number(import.meta.env.VITE_RUM_SAMPLE_RATE ?? (import.meta.env.PROD ? 0.25 : 0));

interface NavigatorWithConnection extends Navigator {
  connection?: { effectiveType?: string };
}

const buffer: BufferedMetric[] = [];
let started = false;

function send(payload: VitalsPayload): void {
  const url = `${SUPABASE_URL}/functions/v1/rum-ingest`;
  const body = JSON.stringify(payload);
  const type = 'text/plain;charset=UTF-8'; // CORS-safelisted: no preflight, so it survives page unload
  try {
    if (navigator.sendBeacon?.(url, new Blob([body], { type }))) return;
  } catch {
    // fall through to fetch
  }
  void fetch(url, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': type } }).catch(() => undefined);
}

function flush(): void {
  if (buffer.length === 0) return;
  const items = buffer.splice(0, buffer.length);
  if (!hasAnalyticsConsent()) return; // consent withdrawn since collection: drop, never send
  const conn = (navigator as NavigatorWithConnection).connection?.effectiveType;
  buildPayloads(items, { release: RELEASE, device: deviceClassFor(window.innerWidth), conn: connClassFor(conn) }).forEach(send);
}

async function start(): Promise<void> {
  if (started) return;
  started = true;
  if (Math.random() >= SAMPLE_RATE) return;
  const { onCLS, onFCP, onINP, onLCP, onTTFB } = await import('web-vitals');
  const record = (m: Metric) =>
    buffer.push({ route: window.location.pathname, nav: m.navigationType as NavType, metric: { name: m.name as VitalName, value: m.value } });
  [onLCP, onCLS, onINP, onFCP, onTTFB].forEach((observe) => observe(record));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}

/** Anonymous, sampled, consent-gated (analytics category). Call once at boot. */
export function initWebVitals(): void {
  if (isNative() || typeof window === 'undefined' || !SUPABASE_URL) return;
  if (hasAnalyticsConsent()) void start();
  else onAnalyticsConsent(() => void start());
}
