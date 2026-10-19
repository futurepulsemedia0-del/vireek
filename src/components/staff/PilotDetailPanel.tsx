import { useState } from 'react';
import { Download, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { ErrorState, Pill, Section, SelectField, formatDateTime, useLoader } from '@/components/vehicles/shared';
import { useToast } from '@/contexts/ToastContext';
import { exportToCsv } from '@/lib/csvExport';
import { exportCaseStudy, getFlaggedCalls, getPilotTrend, listPilotAudit, updatePilot } from '@/lib/pilotManagementApi';
import {
  CALL_FLAG_LABEL, CONSENT_SCOPES, CONSENT_SCOPE_LABEL, CONSENT_STATUSES, CONSENT_STATUS_LABEL, HIGH_SEVERITY_FLAGS, WEEKLY_CSV_COLUMNS,
  barWidth, buildCaseStudyMarkdown, canExport, caseStudyFilename, consentFormsEqual, consentToForm, describeAuditEntry, describeConsent, describeScope,
  downloadTextFile, exportBlockedReason, formatMoney, formatPct, formatWeekRange, maxWeeklyRevenue, parseConsentForm, weekBookingRate, weekMissedPct,
  type ConsentFormValues, type ConsentScope, type ExportFormat, type FieldErrors, type Pilot,
} from '@/lib/pilotManagement';

interface Props {
  pilot: Pilot;
  /** Reload the pilot list (consent and live numbers change after an edit). */
  onChanged: () => void;
}

export function PilotDetailPanel({ pilot, onChanged }: Props) {
  const { toast } = useToast();
  const stamp = `${pilot.id}:${pilot.updated_at}`;
  const trend = useLoader(() => getPilotTrend(pilot.id), stamp);
  const flagged = useLoader(() => getFlaggedCalls(pilot.id, 50), stamp);
  const audit = useLoader(() => listPilotAudit(pilot.id), stamp);

  const [consent, setConsent] = useState<ConsentFormValues>(() => consentToForm(pilot));
  const [consentErrors, setConsentErrors] = useState<FieldErrors>({});
  const [savingConsent, setSavingConsent] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  const weeks = trend.data ?? [];
  const maxRevenue = maxWeeklyRevenue(weeks);
  const blocked = exportBlockedReason(pilot);
  const consentDirty = !consentFormsEqual(consentToForm(pilot), consent);

  const toggleScope = (s: ConsentScope) => {
    setConsent((c) => ({ ...c, scope: c.scope.includes(s) ? c.scope.filter((x) => x !== s) : [...c.scope, s] }));
    setConsentErrors((e) => ({ ...e, scope: '' }));
  };

  const saveConsent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingConsent) return;
    const parsed = parseConsentForm(consent);
    if (!parsed.ok) { setConsentErrors(parsed.errors); return; }
    setSavingConsent(true);
    try {
      await updatePilot(pilot.id, parsed.value);
      toast('Consent saved.', 'success');
      setConsentErrors({});
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save consent.', 'error');
    } finally {
      setSavingConsent(false);
    }
  };

  const runExport = async (format: ExportFormat) => {
    if (exporting) return;
    setExporting(format);
    try {
      // The server re-checks consent and writes the audit row; nothing is built from stale client state.
      const data = await exportCaseStudy(pilot.id, format);
      if (format === 'markdown') {
        downloadTextFile(caseStudyFilename(data, 'md'), buildCaseStudyMarkdown(data), 'text/markdown');
      } else if (format === 'csv') {
        exportToCsv(data.weekly, WEEKLY_CSV_COLUMNS, caseStudyFilename(data, 'csv'));
      } else {
        downloadTextFile(caseStudyFilename(data, 'json'), JSON.stringify(data, null, 2), 'application/json');
      }
      toast('Export downloaded.', 'success');
      void audit.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not export the case study.', 'error');
      onChanged(); // consent may have changed under us: refresh so the buttons reflect it
    } finally {
      setExporting(null);
    }
  };

  const status = describeConsent(pilot.consent.status);

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      {/* Week by week */}
      <Section title="Week by week">
        {trend.loading && !trend.data ? (
          <SkeletonCardList count={1} rows={3} />
        ) : trend.error && !trend.data ? (
          <ErrorState message={trend.error} onRetry={trend.reload} />
        ) : weeks.length === 0 ? (
          <p className="text-sm text-text-secondary">No weeks yet: the pilot has not started.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <caption className="sr-only">Weekly calls, booking rate, revenue and recovered revenue since the pilot started</caption>
                <thead>
                  <tr className="text-xs text-text-secondary">
                    <th scope="col" className="py-1.5 pe-3 text-start font-medium">Week</th>
                    <th scope="col" className="px-3 py-1.5 text-end font-medium">Calls</th>
                    <th scope="col" className="px-3 py-1.5 text-end font-medium">Missed</th>
                    <th scope="col" className="px-3 py-1.5 text-end font-medium">Booking</th>
                    <th scope="col" className="px-3 py-1.5 text-start font-medium">Revenue</th>
                    <th scope="col" className="px-3 py-1.5 text-end font-medium">Recovered</th>
                    <th scope="col" className="ps-3 py-1.5 text-end font-medium">Flagged</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {weeks.map((w) => (
                    <tr key={w.week_index} className={w.is_complete ? '' : 'text-text-secondary'}>
                      <th scope="row" className="py-2 pe-3 text-start font-medium text-text-primary">
                        {w.week_index}
                        <span className="ms-2 text-xs font-normal text-text-secondary">{formatWeekRange(w)}{w.is_complete ? '' : ' · in progress'}</span>
                      </th>
                      <td className="px-3 py-2 text-end tabular-nums">{w.total_calls}</td>
                      <td className="px-3 py-2 text-end tabular-nums">{formatPct(weekMissedPct(w))}</td>
                      <td className="px-3 py-2 text-end tabular-nums">{formatPct(weekBookingRate(w))}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-24 shrink-0 overflow-hidden rounded-full bg-bg-tertiary" aria-hidden="true">
                            <div className="h-full rounded-full bg-accent" style={{ width: `${barWidth(w.revenue_cents, maxRevenue)}%` }} />
                          </div>
                          <span className="tabular-nums">{formatMoney(w.revenue_cents)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums">{formatMoney(w.recovered_cents)}</td>
                      <td className={`ps-3 py-2 text-end tabular-nums ${w.flagged_calls > 0 ? 'font-medium text-warning-500' : ''}`}>{w.flagged_calls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-text-secondary">Weeks are 7-day periods counted from the start date (UTC). The newest week may be incomplete.</p>
          </>
        )}
      </Section>

      {/* Quality flags */}
      <Section title="Call quality flags">
        {flagged.loading && !flagged.data ? (
          <SkeletonCardList count={1} rows={2} />
        ) : flagged.error && !flagged.data ? (
          <ErrorState message={flagged.error} onRetry={flagged.reload} />
        ) : (flagged.data ?? []).length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No flagged calls" description="No low scores, negative sentiment, price mismatches, missed emergencies or unresolved objections since the pilot started." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <caption className="sr-only">Flagged calls since the pilot started, newest first</caption>
                <thead>
                  <tr className="text-xs text-text-secondary">
                    <th scope="col" className="py-1.5 pe-3 text-start font-medium">When</th>
                    <th scope="col" className="px-3 py-1.5 text-end font-medium">Score</th>
                    <th scope="col" className="px-3 py-1.5 text-start font-medium">Outcome</th>
                    <th scope="col" className="px-3 py-1.5 text-start font-medium">Flags</th>
                    <th scope="col" className="ps-3 py-1.5 text-start font-medium">Call ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(flagged.data ?? []).map((c) => (
                    <tr key={c.call_id}>
                      <td className="py-2 pe-3 whitespace-nowrap">{formatDateTime(c.call_datetime)}</td>
                      <td className="px-3 py-2 text-end tabular-nums">{c.call_score ?? '—'}</td>
                      <td className="px-3 py-2">{c.booking_outcome ? c.booking_outcome.replace(/_/g, ' ') : '—'}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1.5">
                          {c.flags.map((f) => <Pill key={f} tone={HIGH_SEVERITY_FLAGS.includes(f) ? 'danger' : 'warning'}>{CALL_FLAG_LABEL[f] ?? f}</Pill>)}
                        </div>
                      </td>
                      <td className="ps-3 py-2 font-mono text-xs text-text-secondary">{c.call_id.slice(0, 8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-text-secondary">
              Showing up to 50 of the newest flagged calls ({pilot.live.flagged_calls} flagged in total). Caller names, numbers and transcripts are deliberately not shown here.
            </p>
          </>
        )}
      </Section>

      {/* Consent + export */}
      <Section
        title="Case study consent & export"
        action={<Pill tone={status.tone}>{status.label}</Pill>}
      >
        <form onSubmit={saveConsent} noValidate className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField label="Consent status" value={consent.status} onChange={(e) => { setConsent((c) => ({ ...c, status: e.target.value as ConsentFormValues['status'] })); setConsentErrors({}); }} error={consentErrors.status || undefined}>
              {CONSENT_STATUSES.map((s) => <option key={s} value={s}>{CONSENT_STATUS_LABEL[s]}</option>)}
            </SelectField>
            <Input label="Evidence" value={consent.evidence} maxLength={500} onChange={(e) => { setConsent((c) => ({ ...c, evidence: e.target.value })); setConsentErrors((x) => ({ ...x, evidence: '' })); }} error={consentErrors.evidence || undefined} placeholder="Email from owner, 12 Jun 2027" helperText="Where the customer’s written agreement is. Required when granted." />
          </div>

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-text-primary">What the customer agreed to</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {CONSENT_SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm text-text-primary">
                  <input type="checkbox" checked={consent.scope.includes(s)} onChange={() => toggleScope(s)} />
                  {CONSENT_SCOPE_LABEL[s]}
                </label>
              ))}
            </div>
            {consentErrors.scope && <p role="alert" className="mt-1.5 text-xs text-danger">{consentErrors.scope}</p>}
          </fieldset>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-text-secondary">
              {pilot.consent.status === 'granted' && pilot.consent.granted_at ? `Granted ${formatDateTime(pilot.consent.granted_at)} · ${describeScope(pilot.consent.scope)}` : 'Consent changes are logged in the history below.'}
            </p>
            <Button type="submit" size="sm" variant="secondary" disabled={savingConsent || !consentDirty}>{savingConsent ? 'Saving…' : 'Save consent'}</Button>
          </div>
        </form>

        <div className="mt-5 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => void runExport('markdown')} disabled={!canExport(pilot) || exporting !== null}>
              <Download size={16} /> {exporting === 'markdown' ? 'Exporting…' : 'Export case study'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void runExport('csv')} disabled={!canExport(pilot) || exporting !== null}>
              {exporting === 'csv' ? 'Exporting…' : 'Weekly data (CSV)'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void runExport('json')} disabled={!canExport(pilot) || exporting !== null}>
              {exporting === 'json' ? 'Exporting…' : 'JSON'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-text-secondary" aria-live="polite">
            {blocked ?? (pilot.consent.scope.includes('company_name') ? 'The export includes the company name.' : 'The company name is left out: the customer did not agree to be named.')}
          </p>
        </div>
      </Section>

      {/* History */}
      <Section title="History">
        {audit.loading && !audit.data ? (
          <SkeletonCardList count={1} rows={2} />
        ) : audit.error && !audit.data ? (
          <ErrorState message={audit.error} onRetry={audit.reload} />
        ) : (audit.data ?? []).length === 0 ? (
          <p className="text-sm text-text-secondary">No history yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {(audit.data ?? []).map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm">
                <span className="text-text-primary">{describeAuditEntry(a)}</span>
                <span className="text-xs text-text-secondary">{a.actor_email ?? 'system'} · {formatDateTime(a.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
