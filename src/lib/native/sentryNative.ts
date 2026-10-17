// src/lib/native/sentryNative.ts — Sentry for the installed app: JavaScript errors AND native
// crashes (Swift / Kotlin / NDK), ANRs and app-start sessions, in the same project as the website.
// Loaded only by initSentry() when isNative(), so the web bundle never contains it.

import * as SentryCapacitor from '@sentry/capacitor';
import * as SentryReact from '@sentry/react';

export function initNativeSentry(dsn: string): void {
  SentryCapacitor.init(
    {
      dsn,
      environment: import.meta.env.MODE,
      enableNative: true,
      enableNativeCrashHandling: true,
      enableAutoSessionTracking: true,
      tracesSampleRate: import.meta.env.MODE === 'production' ? 0.2 : 0,
      integrations: [SentryReact.browserTracingIntegration()],
      ignoreErrors: ['ResizeObserver loop limit exceeded', 'Non-Error promise rejection captured'],
      beforeSend(event) {
        if (event.request) delete event.request.cookies;
        return event;
      },
    },
    SentryReact.init,
  );
}
