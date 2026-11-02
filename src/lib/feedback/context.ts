import { sanitizeRoute } from '@/lib/feedback/redact';
import { getLastIncidentId } from '@/lib/feedback/errorTracker';

export interface FeedbackContext {
  route: string;
  app_version: string;
  browser: string;
  os: string;
  viewport: string;
  locale: string;
  theme: string;
  online: string;
  error_id?: string;
}

/** "Chrome 130" / "macOS" - deliberately coarse (no full user-agent string). */
export function parseBrowser(ua: string): { browser: string; os: string } {
  const m =
    /(Edg|OPR|Firefox|Chrome|CriOS|FxiOS)\/(\d+)/.exec(ua) ?? (/Version\/(\d+).*Safari/.exec(ua) ? ['', 'Safari', /Version\/(\d+)/.exec(ua)![1]] : null);
  const names: Record<string, string> = { Edg: 'Edge', OPR: 'Opera', CriOS: 'Chrome', FxiOS: 'Firefox' };
  const browser = m ? `${names[m[1]] ?? m[1]} ${m[2]}` : 'Unknown';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  return { browser, os };
}

export function collectFeedbackContext(pathname: string): FeedbackContext {
  const { browser, os } = parseBrowser(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const errorId = getLastIncidentId();
  return {
    route: sanitizeRoute(pathname),
    app_version: String(import.meta.env.VITE_APP_VERSION || import.meta.env.VITE_COMMIT_SHA || 'unknown').slice(0, 40),
    browser,
    os,
    viewport: typeof window === 'undefined' ? '' : `${window.innerWidth}x${window.innerHeight}`,
    locale: typeof navigator === 'undefined' ? '' : navigator.language,
    theme: typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    online: typeof navigator !== 'undefined' && navigator.onLine ? 'yes' : 'no',
    ...(errorId ? { error_id: errorId } : {}),
  };
}
