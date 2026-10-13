// Sentry-backed capture and user reports for incidents. Kept separate from
// incident.ts so the pure helpers stay testable without the Sentry SDK.
import * as Sentry from '@sentry/react';
import { generateIncidentId, truncate } from '@/lib/incident';

/** Reports only go anywhere when Sentry/GlitchTip is configured (same switch as lib/sentry.ts). */
export const reportingEnabled = Boolean(import.meta.env.VITE_SENTRY_DSN);

export interface CapturedIncident { incidentId: string; eventId: string | null }

/**
 * Sends the error to Sentry tagged with the incident ID, so support can search
 * `incident_id:INC-XXXX-XXXX`. Never throws — an error page must not error.
 */
export function captureIncident(
  error: unknown,
  ctx: { incidentId?: string | null; componentStack?: string | null } = {},
): CapturedIncident {
  const incidentId = ctx.incidentId || generateIncidentId();
  let eventId: string | null = null;
  try {
    Sentry.withScope((scope) => {
      scope.setTag('incident_id', incidentId);
      eventId = Sentry.captureException(error, { extra: { incidentId, componentStack: ctx.componentStack ?? undefined } });
    });
  } catch {
    // Reporting is best-effort.
  }
  return { incidentId, eventId };
}

export interface IncidentReportInput { incidentId: string; eventId: string | null; message: string; email: string | null }

/** Sends the user's report, linked to the original event. Rejects if it could not be delivered. */
export async function sendIncidentReport({ incidentId, eventId, message, email }: IncidentReportInput): Promise<void> {
  if (!reportingEnabled) throw new Error('Reporting is not available right now.');
  Sentry.captureFeedback({
    message: truncate(`[${incidentId}] ${message || '(no description)'}`, 1100),
    email: email ?? undefined,
    associatedEventId: eventId ?? undefined,
    source: 'error-page',
  });
  const delivered = await Sentry.flush(3000);
  if (!delivered) throw new Error('Could not send the report. Check your connection and try again.');
}
