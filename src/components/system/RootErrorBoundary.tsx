import { Component, type ErrorInfo, type ReactNode } from 'react';
import { generateIncidentId } from '@/lib/incident';
import { recoverFromChunkError } from '@/lib/chunkRecovery';
import { captureIncident } from '@/lib/incidentReporting';

interface State {
  error: Error | null;
  incidentId: string | null;
}

function safeIncidentId(): string {
  try {
    return generateIncidentId();
  } catch {
    return 'INC-UNKNOWN';
  }
}

/**
 * OUTERMOST safety net (src/main.tsx), wrapping the router and every provider.
 * <ErrorBoundary> only covers what is rendered under the providers; an error thrown by a provider
 * (theme, auth, i18n sync, router...) used to unmount the whole app and leave a blank page.
 * Its fallback depends on nothing (no router, no i18n, no theme context, no Tailwind) so it still renders
 * when those are the thing that broke.
 */
export class RootErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, incidentId: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, incidentId: safeIncidentId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The boot loader is removed by a component that has just unmounted; if it is still there it covers this screen.
    document.getElementById('vrk-boot')?.remove();
    try {
      if (recoverFromChunkError(error)) return;
    } catch {
      /* reload bookkeeping must never throw from here */
    }
    try {
      captureIncident(error, { incidentId: this.state.incidentId, componentStack: info.componentStack });
    } catch {
      /* reporting is best effort */
    }
  }

  render() {
    const { error, incidentId } = this.state;
    if (!error) return this.props.children;

    const html = document.documentElement;
    const dark = html.classList.contains('dark') || html.classList.contains('vrk-native');
    const bg = dark ? '#141413' : '#FAF9F5';
    const ink = dark ? '#FAF9F5' : '#141413';
    const detail = (error.message || String(error)).slice(0, 240);

    return (
      <div
        role="alert"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          zIndex: 2147483000,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          padding: 'calc(24px + env(safe-area-inset-top, 0px)) 24px calc(24px + env(safe-area-inset-bottom, 0px))',
          textAlign: 'center',
          background: bg,
          color: ink,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em' }}>Vireek</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Something went wrong</div>
        <div style={{ fontSize: 14, opacity: 0.75, maxWidth: 320, lineHeight: 1.5 }}>
          Vireek could not finish starting. Reload to try again.
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            minHeight: 48,
            minWidth: 160,
            padding: '0 24px',
            border: 0,
            borderRadius: 12,
            background: ink,
            color: bg,
            fontSize: 16,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
        <div style={{ fontSize: 11, opacity: 0.55, maxWidth: 320, wordBreak: 'break-word', fontFamily: 'ui-monospace, Menlo, monospace' }}>
          {incidentId} · {detail}
        </div>
      </div>
    );
  }
}
