import { Component, type ErrorInfo, type ReactNode } from 'react';
import { generateIncidentId, isChunkLoadError } from '@/lib/incident';
import { captureIncident } from '@/lib/incidentReporting';
import { classifyError, type AppError } from '@/lib/trust/appError';
import { ErrorPanel } from './ErrorPanel';

interface Props {
  children: ReactNode;
  /** Changing any of these values clears the error (e.g. the route or record id). */
  resetKeys?: readonly unknown[];
  className?: string;
}
interface State {
  error: Error | null;
  appError: AppError | null;
}

const sameKeys = (a: readonly unknown[] = [], b: readonly unknown[] = []) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/**
 * Component-level boundary: a crash inside one panel shows a recoverable
 * ErrorPanel in that panel only, instead of taking down the page. The app-wide
 * ErrorBoundary stays as the last resort.
 */
export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { error: null, appError: null };

  static getDerivedStateFromError(error: Error): State {
    const base = classifyError(error, { referenceId: generateIncidentId(), offline: false });
    const chunk = isChunkLoadError(error);
    // A render crash is not a permissions problem: offer Retry (or a reload after a deploy).
    return { error, appError: { ...base, kind: chunk ? 'network' : 'unknown', recovery: chunk ? 'refresh' : 'retry', retryable: true, messageKey: chunk ? 'trust.error.network' : 'trust.error.server' } };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    captureIncident(error, { incidentId: this.state.appError?.referenceId, componentStack: info.componentStack });
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && !sameKeys(prev.resetKeys, this.props.resetKeys)) this.setState({ error: null, appError: null });
  }

  render() {
    const { appError } = this.state;
    if (!appError) return this.props.children;
    return (
      <ErrorPanel
        error={appError}
        className={this.props.className}
        onRetry={() => this.setState({ error: null, appError: null })}
        onRefresh={() => window.location.reload()}
      />
    );
  }
}
