import * as Sentry from '@sentry/react';

const DSN = import.meta.env.VITE_SENTRY_DSN;

/** Call once, as early as possible (before the app renders). */
export function initSentry() {
  if (!DSN) return; // no DSN set (e.g. local dev) — skip silently, no crash

  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.MODE,
    tracesSampleRate: import.meta.env.MODE === 'production' ? 0.2 : 0,
    integrations: [Sentry.browserTracingIntegration()],
    ignoreErrors: [
      // Noise that isn't an actionable bug — keeps the dashboard signal-only.
      'ResizeObserver loop limit exceeded',
      'Non-Error promise rejection captured',
    ],
    beforeSend(event) {
      // Strip anything that could carry PII before it leaves the browser.
      if (event.request) delete event.request.cookies;
      return event;
    },
  });
}

/** Call after login/logout so errors can be traced to an account — id only, no PII. */
export function setSentryUser(user: { id: string } | null) {
  Sentry.setUser(user ? { id: user.id } : null);
}

/** Manual capture — use in catch blocks for handled errors worth tracking. */
export function captureError(error: unknown, context?: Record<string, unknown>) {
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
