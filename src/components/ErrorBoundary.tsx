import { Component, ReactNode, ErrorInfo } from 'react';
import { captureError } from '@/lib/sentry';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

/**
 * App-wide safety net. Without this, any uncaught render error anywhere in
 * the tree (Onboarding, Dashboard, etc.) unmounts the whole app and leaves
 * the visitor looking at a blank white page with no way forward — which is
 * exactly what was happening after OTP verification and after "Go to
 * Dashboard". This catches that error, logs it, and shows a real recovery
 * screen instead of a silent blank page.
 *
 * The technical details block below is deliberately shown to the user (not
 * just console.error'd) — a generic "Something went wrong" with nothing
 * else made this bug effectively undiagnosable from a support conversation,
 * since nobody but the person hitting it could see the browser console.
 * Showing (and letting them copy) the real message/stack turns "it's
 * broken" into an instantly actionable bug report.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    // eslint-disable-next-line no-console
    console.error('Unhandled error caught by ErrorBoundary:', error, info);
    captureError(error, { componentStack: info.componentStack ?? undefined });
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null, componentStack: null });
    window.location.href = '/dashboard';
  };

  handleCopyDetails = () => {
    const { error, componentStack } = this.state;
    const details = [
      `Message: ${error?.message ?? 'unknown'}`,
      error?.stack ? `Stack:\n${error.stack}` : null,
      componentStack ? `Component stack:${componentStack}` : null,
      `URL: ${window.location.href}`,
      `Time: ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    navigator.clipboard?.writeText(details).catch(() => {
      /* Clipboard access can fail silently (permissions/insecure context) —
         the details are still visible on screen to copy by hand. */
    });
  };

  render() {
    if (this.state.hasError) {
      const { error, componentStack } = this.state;
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg-primary px-6 text-center">
          <h1 className="text-xl font-bold text-text-primary">Something went wrong</h1>
          <p className="max-w-sm text-sm text-text-secondary">
            We hit an unexpected error loading this page. Your progress up to this point is
            saved — try again below.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110"
            >
              Go to Dashboard
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-xl border border-border px-5 py-2.5 text-sm font-semibold text-text-primary hover:bg-bg-secondary"
            >
              Reload page
            </button>
          </div>

          {error && (
            <details className="mt-2 w-full max-w-lg text-left">
              <summary className="cursor-pointer select-none text-xs font-medium text-text-secondary hover:text-text-primary">
                Technical details (share this if the problem keeps happening)
              </summary>
              <div className="mt-2 space-y-2 rounded-xl border border-border bg-bg-secondary p-3">
                <p className="break-words font-mono text-xs text-danger">{error.message}</p>
                {componentStack && (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-text-secondary">
                    {componentStack.trim()}
                  </pre>
                )}
                <button
                  type="button"
                  onClick={this.handleCopyDetails}
                  className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
                >
                  Copy error details
                </button>
              </div>
            </details>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
