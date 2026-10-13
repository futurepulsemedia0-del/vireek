import { useState } from 'react';
import { Check, Copy, Mail, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import {
  REPORT_NOTE_MAX, buildSupportMailto, formatErrorDetails, isChunkLoadError, parseReportForm, safeUrl,
  type FieldErrors,
} from '@/lib/incident';
import { reportingEnabled, sendIncidentReport, type IncidentReportInput } from '@/lib/incidentReporting';

export interface IncidentReporter {
  enabled: boolean;
  send: (input: IncidentReportInput) => Promise<void>;
}

const defaultReporter: IncidentReporter = { enabled: reportingEnabled, send: sendIncidentReport };

interface Props {
  incidentId: string;
  /** Sentry event id of the original error, when there was one (links the user's report to it). */
  eventId?: string | null;
  error?: Error | null;
  componentStack?: string | null;
  /** Injectable for tests; defaults to Sentry-backed reporting. */
  reporter?: IncidentReporter;
}

type CopyState = 'idle' | 'copied' | 'failed';
type SendState = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * The friendly 500 screen. Used by ErrorBoundary (where it must keep working
 * even if the app is broken) and by the /error route, so it deliberately has
 * no router, auth or other context dependencies and navigates with plain
 * window.location.
 */
export function ServerErrorView({ incidentId, eventId = null, error = null, componentStack = null, reporter = defaultReporter }: Props) {
  const [time] = useState(() => new Date().toISOString());
  const [url] = useState(() => (typeof window === 'undefined' ? '' : safeUrl(window.location.href)));
  const [idCopy, setIdCopy] = useState<CopyState>('idle');
  const [detailsCopy, setDetailsCopy] = useState<CopyState>('idle');
  const [reportOpen, setReportOpen] = useState(false);
  const [note, setNote] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [sendState, setSendState] = useState<SendState>('idle');
  const [sendError, setSendError] = useState('');

  const chunkError = isChunkLoadError(error);
  const mailto = buildSupportMailto({ incidentId, url, time, message: error?.message });

  const copy = async (text: string, set: (s: CopyState) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      set('copied');
    } catch {
      set('failed'); // clipboard can be blocked; the text stays selectable on screen
    }
    window.setTimeout(() => set('idle'), 2500);
  };

  const submitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sendState === 'sending') return;
    const parsed = parseReportForm({ note, email });
    if (!parsed.ok) { setErrors(parsed.errors); return; }
    setErrors({});
    setSendState('sending');
    setSendError('');
    try {
      await reporter.send({ incidentId, eventId, message: parsed.value.note, email: parsed.value.email });
      setSendState('sent');
    } catch (err) {
      setSendState('failed');
      setSendError(err instanceof Error ? err.message : 'Could not send the report.');
    }
  };

  const copyLabel = idCopy === 'copied' ? 'Copied' : idCopy === 'failed' ? 'Select to copy' : 'Copy';

  return (
    <section aria-labelledby="server-error-title" className="mx-auto flex w-full max-w-lg flex-col items-center text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-danger/10 text-danger">
        <TriangleAlert size={28} aria-hidden="true" />
      </span>
      <p className="mt-6 text-sm font-semibold uppercase tracking-[0.2em] text-danger">500</p>
      <h1 id="server-error-title" className="mt-2 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
        Something went wrong on our side.
      </h1>
      <p className="mt-4 text-base leading-7 text-text-secondary">
        {chunkError
          ? 'Vireek was just updated and this page is out of date. Reloading will load the latest version.'
          : `That wasn’t supposed to happen.${reporter.enabled ? ' Our team has been notified automatically.' : ''} Try again, and if it keeps happening, tell us with the incident ID below.`}
      </p>

      <div className="mt-6 w-full rounded-2xl border border-border bg-bg-secondary p-4">
        <p className="text-xs font-medium text-text-secondary">Incident ID</p>
        <div className="mt-1 flex items-center justify-between gap-3">
          <code data-testid="incident-id" className="min-w-0 select-all break-all font-mono text-lg font-semibold tracking-wider text-text-primary">{incidentId}</code>
          <Button type="button" size="sm" variant="secondary" onClick={() => copy(incidentId, setIdCopy)} aria-label={`Copy incident ID ${incidentId}`}>
            {idCopy === 'copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            <span aria-live="polite">{copyLabel}</span>
          </Button>
        </div>
      </div>

      <div className="mt-6 flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
        <Button type="button" size="lg" className="w-full sm:w-auto" onClick={() => window.location.reload()}>Try again</Button>
        <Button type="button" size="lg" variant="secondary" className="w-full sm:w-auto" onClick={() => window.location.assign('/dashboard')}>Go to dashboard</Button>
      </div>

      <div className="mt-6 w-full text-start">
        {sendState === 'sent' ? (
          <p role="status" className="rounded-xl border border-success-500/30 bg-success-500/10 px-4 py-3 text-sm text-success-500">
            Thanks, your report was sent. If you contact us, quote {incidentId}.
          </p>
        ) : (
          <>
            {reporter.enabled && (
              <div className="text-center">
                <Button type="button" variant="ghost" size="sm" aria-expanded={reportOpen} aria-controls="incident-report-form" onClick={() => setReportOpen((o) => !o)}>
                  Report this problem
                </Button>
              </div>
            )}
            {reporter.enabled && reportOpen && (
              <form id="incident-report-form" onSubmit={submitReport} noValidate className="mt-3 space-y-4 rounded-2xl border border-border bg-bg-secondary p-4">
                <Textarea label="What were you doing?" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={REPORT_NOTE_MAX} error={errors.note || undefined} helperText="Optional, but it helps us fix this faster." disabled={sendState === 'sending'} />
                <Input label="Email (optional)" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email || undefined} helperText="Only if you’d like us to follow up." disabled={sendState === 'sending'} />
                {sendState === 'failed' && <p role="alert" className="text-sm text-danger">{sendError}</p>}
                <div className="flex flex-wrap justify-end gap-3">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setReportOpen(false)} disabled={sendState === 'sending'}>Cancel</Button>
                  <Button type="submit" size="sm" disabled={sendState === 'sending'}>{sendState === 'sending' ? 'Sending…' : 'Send report'}</Button>
                </div>
              </form>
            )}
            <p className="mt-3 text-center text-sm text-text-secondary">
              <a href={mailto} className="focus-ring inline-flex items-center gap-1.5 rounded font-semibold text-accent underline-offset-4 hover:underline">
                <Mail size={14} aria-hidden="true" /> {reporter.enabled ? 'Or email support' : 'Email support about this'}
              </a>
            </p>
          </>
        )}
      </div>

      {error && (
        <details className="mt-6 w-full text-start">
          <summary className="cursor-pointer select-none text-xs font-medium text-text-secondary hover:text-text-primary">Technical details (share these if the problem keeps happening)</summary>
          <div className="mt-2 space-y-2 rounded-xl border border-border bg-bg-secondary p-3">
            <p className="break-words font-mono text-xs text-danger">{error.message}</p>
            {componentStack && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-text-secondary">{componentStack.trim()}</pre>}
            <Button type="button" size="sm" variant="secondary" onClick={() => copy(formatErrorDetails({ incidentId, error, componentStack, url, time }), setDetailsCopy)}>
              {detailsCopy === 'copied' ? 'Copied' : detailsCopy === 'failed' ? 'Copy failed' : 'Copy error details'}
            </Button>
          </div>
        </details>
      )}
    </section>
  );
}
