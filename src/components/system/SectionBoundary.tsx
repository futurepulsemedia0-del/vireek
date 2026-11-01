import { Component, type ErrorInfo, type ReactNode } from 'react';
import * as Sentry from '@sentry/react';
import { withTranslation, type WithTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { generateIncidentId, isChunkLoadError } from '@/lib/incident';
import { captureIncident } from '@/lib/incidentReporting';

export type BoundaryLevel = 'route' | 'section' | 'widget';

interface OwnProps {
  /** Stable name used as a Sentry tag, e.g. "dashboard.revenue-chart". */
  name: string;
  level?: BoundaryLevel;
  children: ReactNode;
  /** When any of these change, a failed boundary tries again (e.g. [customerId]). */
  resetKeys?: readonly unknown[];
  /** Replace the default fallback (e.g. a silent null for non-critical decoration). */
  fallback?: (ctx: { retry: () => void; incidentId: string }) => ReactNode;
}
type Props = OwnProps & WithTranslation;
interface State {
  error: Error | null;
  incidentId: string | null;
}

const sameKeys = (a: readonly unknown[] = [], b: readonly unknown[] = []) =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Granular boundary: one broken section/widget must not blank the page. Reports to Sentry with context + a user-safe ID. */
class SectionBoundaryBase extends Component<Props, State> {
  state: State = { error: null, incidentId: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, incidentId: generateIncidentId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const { name, level = 'section' } = this.props;
    Sentry.withScope((scope) => {
      scope.setTag('boundary', name);
      scope.setTag('boundary_level', level);
      captureIncident(error, { incidentId: this.state.incidentId, componentStack: info.componentStack });
    });
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && !sameKeys(prev.resetKeys, this.props.resetKeys)) this.setState({ error: null, incidentId: null });
  }

  private retry = () => {
    // A failed lazy chunk is cached as failed by React.lazy: only a real reload can refetch it.
    if (isChunkLoadError(this.state.error)) window.location.reload();
    else this.setState({ error: null, incidentId: null });
  };

  render() {
    const { error, incidentId } = this.state;
    if (!error) return this.props.children;
    const id = incidentId ?? 'INC-UNKNOWN';
    if (this.props.fallback) return this.props.fallback({ retry: this.retry, incidentId: id });
    const { t } = this.props;
    return (
      <div role="alert" className="rounded-2xl border border-border bg-bg-secondary p-5 text-start">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-warning-500" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">{t('net.section.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t('net.section.body')}</p>
            <p className="mt-2 font-mono text-xs text-text-secondary">{t('net.section.errorId', { id })}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={this.retry}
                className="focus-ring rounded-lg bg-cta px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110"
              >
                {t('net.section.retry')}
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-tertiary"
              >
                {t('net.section.reload')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

export const SectionBoundary = withTranslation()(SectionBoundaryBase);
