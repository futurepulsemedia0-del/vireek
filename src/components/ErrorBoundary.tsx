import { Component, ReactNode, ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * App-wide safety net. Without this, any uncaught render error anywhere in
 * the tree (Onboarding, Dashboard, etc.) unmounts the whole app and leaves
 * the visitor looking at a blank white page with no way forward — which is
 * exactly what was happening after OTP verification and after "Go to
 * Dashboard". This catches that error, logs it, and shows a real recovery
 * screen instead of a silent blank page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Unhandled error caught by ErrorBoundary:', error, info);
  }

  handleReload = () => {
    this.setState({ hasError: false });
    window.location.href = '/dashboard';
  };

  render() {
    if (this.state.hasError) {
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
        </div>
      );
    }
    return this.props.children;
  }
}
