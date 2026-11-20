import { Component, ErrorInfo, ReactNode } from 'react';
import { generateIncidentId } from '@/lib/incident';
import { recoverFromChunkError } from '@/lib/chunkRecovery';
import { captureIncident } from '@/lib/incidentReporting';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * Isolates optional floating widgets (support agent, live chat, accessibility,
 * consent). If one crashes it disappears silently and the incident is reported,
 * instead of replacing the whole page with the app-wide error screen.
 */
export class WidgetBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (recoverFromChunkError(error)) return;
    captureIncident(error, { incidentId: generateIncidentId(), componentStack: info.componentStack });
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
