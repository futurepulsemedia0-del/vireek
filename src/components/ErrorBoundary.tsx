import { Component, ReactNode, ErrorInfo } from 'react';
import { generateIncidentId } from '@/lib/incident';
import { recoverFromChunkError } from '@/lib/chunkRecovery';
import { captureIncident } from '@/lib/incidentReporting';
import { ServerErrorView } from '@/components/system/ServerErrorView';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
  incidentId: string | null;
  eventId: string | null;
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
  state: State = { hasError: false, error: null, componentStack: null, incidentId: null, eventId: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error, incidentId: generateIncidentId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (recoverFromChunkError(error)) return;
    const { eventId } = captureIncident(error, { incidentId: this.state.incidentId, componentStack: info.componentStack });
    this.setState({ componentStack: info.componentStack ?? null, eventId });
    if (import.meta.env.DEV) {
      // Dev-only: keep the browser console quiet for real users in
      // production (avoids dumping stack/component-tree details into
      // every visitor's console). Sentry reporting below still runs in
      // every environment.
      // eslint-disable-next-line no-console
      console.error('Unhandled error caught by ErrorBoundary:', error, info);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <ServerErrorView
          incidentId={this.state.incidentId ?? 'INC-UNKNOWN'}
          eventId={this.state.eventId}
          error={this.state.error}
          componentStack={this.state.componentStack}
        />
      );
    }
    return this.props.children;
  }
}
