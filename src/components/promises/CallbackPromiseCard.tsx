import { useCallback, useEffect, useState } from 'react';
import { PhoneCall } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import {
  UNCONFIGURED_SETTINGS,
  formatWindow,
  parseOptionalCases,
  parseOptionalMinutes,
  parseWindowInput,
  summarizeStats,
  validateSettings,
  type CallbackPromiseSettings,
  type CallbackStats,
} from '@/lib/callbackPromise';
import { loadCallbackSettings, loadCallbackStats, saveCallbackSettings, CALLBACK_STATS_WINDOW_DAYS } from '@/lib/callbackPromiseData';

/**
 * Callback Promise: the owner's rule ("every missed call gets a callback within X") and the real numbers behind it.
 * Rendered above the Promise Tracker list; the promises themselves appear in that list (category "Callback").
 * Only the account owner can change the rule. Nothing here is shown as a number until the database has computed it.
 */
export function CallbackPromiseCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [settings, setSettings] = useState<CallbackPromiseSettings>(UNCONFIGURED_SETTINGS);
  const [stats, setStats] = useState<CallbackStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [windowText, setWindowText] = useState('');
  const [escalateText, setEscalateText] = useState('');
  const [optIn, setOptIn] = useState(false);
  const [minCasesText, setMinCasesText] = useState('');

  const applySettings = useCallback((s: CallbackPromiseSettings) => {
    setSettings(s);
    setEnabled(s.enabled);
    setWindowText(s.windowMinutes === null ? '' : String(s.windowMinutes));
    setEscalateText(s.escalateAfterMinutes === null ? '' : String(s.escalateAfterMinutes));
    setOptIn(s.publicStatOptIn);
    setMinCasesText(s.publicStatMinCases === null ? '' : String(s.publicStatMinCases));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const s = await loadCallbackSettings();
      applySettings(s);
      setStats(s.enabled ? await loadCallbackStats() : null);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    void load();
  }, [load]);

  const windowParsed = windowText.trim() === '' ? null : parseWindowInput(windowText);
  const escalateParsed = parseOptionalMinutes(escalateText);
  const minCasesParsed = parseOptionalCases(minCasesText);
  const windowInvalid = windowText.trim() !== '' && windowParsed === null;
  const escalateInvalid = escalateParsed === undefined;
  const minCasesInvalid = minCasesParsed === undefined;

  const draft: CallbackPromiseSettings = {
    enabled,
    windowMinutes: windowParsed,
    escalateAfterMinutes: escalateParsed === undefined ? null : escalateParsed,
    publicStatOptIn: optIn,
    publicStatMinCases: minCasesParsed === undefined ? null : minCasesParsed,
  };
  const problems = windowInvalid || escalateInvalid || minCasesInvalid ? ['invalid'] : validateSettings(draft);
  const dirty =
    draft.enabled !== settings.enabled ||
    draft.windowMinutes !== settings.windowMinutes ||
    draft.escalateAfterMinutes !== settings.escalateAfterMinutes ||
    draft.publicStatOptIn !== settings.publicStatOptIn ||
    draft.publicStatMinCases !== settings.publicStatMinCases;

  const submit = async () => {
    if (problems.length > 0) return;
    setSaving(true);
    try {
      await saveCallbackSettings(draft);
      toast('Callback promise saved.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the callback promise.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const summary = stats ? summarizeStats(stats) : null;

  return (
    <section aria-label="Callback promise" className="mb-6 rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark sm:p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <PhoneCall size={16} aria-hidden="true" />
        </span>
        <h2 className="text-sm font-semibold text-text-primary">Callback promise</h2>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
        Every missed call, voicemail or call that ended without a booking becomes a promise here. A phone callback attempt inside your window keeps it. Past the window you are alerted, and a person is pulled in if you set an escalation delay.
      </p>

      {loading ? (
        <p className="mt-4 text-xs text-text-secondary" role="status">Loading…</p>
      ) : loadError ? (
        <div className="mt-4 flex items-center gap-3 text-xs text-danger" role="alert">
          <span>Could not load the callback promise.</span>
          <button type="button" onClick={() => void load()} className="focus-ring font-medium text-accent hover:underline">Try again</button>
        </div>
      ) : (
        <>
          {summary && stats && (
            <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={`Callback results, last ${CALLBACK_STATS_WINDOW_DAYS} days`}>
              <div className="rounded-xl border border-border bg-bg-primary p-3">
                <dt className="text-xs font-medium text-text-secondary">Made in time (recorded)</dt>
                <dd className="mt-1 text-xl font-bold text-text-primary">{summary.verifiedRatePct === null ? '—' : `${summary.verifiedRatePct}%`}</dd>
                <p className="mt-0.5 text-[11px] text-text-secondary">{stats.keptSystem} of {stats.decided}</p>
              </div>
              <div className="rounded-xl border border-border bg-bg-primary p-3">
                <dt className="text-xs font-medium text-text-secondary">Still waiting, overdue</dt>
                <dd className="mt-1 text-xl font-bold text-text-primary">{stats.openOverdue}</dd>
              </div>
              <div className="rounded-xl border border-border bg-bg-primary p-3">
                <dt className="text-xs font-medium text-text-secondary">Made late</dt>
                <dd className="mt-1 text-xl font-bold text-text-primary">{stats.late}</dd>
              </div>
              <div className="rounded-xl border border-border bg-bg-primary p-3">
                <dt className="text-xs font-medium text-text-secondary">Median time to callback</dt>
                <dd className="mt-1 text-xl font-bold text-text-primary">{stats.medianMinutesToCallback === null ? '—' : formatWindow(Math.round(stats.medianMinutesToCallback))}</dd>
              </div>
            </dl>
          )}
          {summary && stats && (stats.keptManual > 0 || summary.windowChanged) && (
            <p className="mt-2 text-[11px] text-text-secondary">
              {stats.keptManual > 0 && <>Not counted above: {stats.keptManual} confirmed by hand. </>}
              {summary.windowChanged && <>Your window changed during this period, so earlier and later cases used different limits.</>}
            </p>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-4 sm:col-span-2">
              <span id="cbp-enabled-label" className="text-sm text-text-primary">Promise a callback for every missed call</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-labelledby="cbp-enabled-label"
                disabled={!canEdit}
                onClick={() => setEnabled((v) => !v)}
                className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${enabled ? 'bg-accent' : 'bg-bg-tertiary'}`}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-bg-secondary shadow-sm transition-transform ${enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
              </button>
            </div>

            <div>
              <label htmlFor="cbp-window" className="mb-1.5 block text-xs font-medium text-text-secondary">Call back within (e.g. 30, 45m, 2h)</label>
              <input
                id="cbp-window"
                value={windowText}
                onChange={(e) => setWindowText(e.target.value)}
                disabled={!canEdit}
                inputMode="text"
                aria-invalid={windowInvalid || (enabled && windowParsed === null)}
                aria-describedby="cbp-window-hint"
                className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-60"
              />
              <p id="cbp-window-hint" className={`mt-1.5 text-xs ${windowInvalid || (enabled && windowParsed === null) ? 'text-danger' : 'text-text-secondary'}`}>
                {windowInvalid || (enabled && windowParsed === null) ? 'Enter between 5 minutes and 7 days.' : 'You choose this. Only calls after you turn the promise on are tracked.'}
              </p>
            </div>

            <div>
              <label htmlFor="cbp-escalate" className="mb-1.5 block text-xs font-medium text-text-secondary">Escalate to a person after (optional)</label>
              <input
                id="cbp-escalate"
                value={escalateText}
                onChange={(e) => setEscalateText(e.target.value)}
                disabled={!canEdit}
                inputMode="text"
                aria-invalid={escalateInvalid}
                aria-describedby="cbp-escalate-hint"
                className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-60"
              />
              <p id="cbp-escalate-hint" className={`mt-1.5 text-xs ${escalateInvalid ? 'text-danger' : 'text-text-secondary'}`}>
                {escalateInvalid ? 'Enter between 5 minutes and 7 days, or leave empty.' : 'Time after the deadline. Empty means an overdue alert only.'}
              </p>
            </div>

            <div className="flex items-center justify-between gap-4 sm:col-span-2">
              <span id="cbp-optin-label" className="text-sm text-text-primary">Allow a public callback stat on my Trust Badge</span>
              <button
                type="button"
                role="switch"
                aria-checked={optIn}
                aria-labelledby="cbp-optin-label"
                disabled={!canEdit}
                onClick={() => setOptIn((v) => !v)}
                className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${optIn ? 'bg-accent' : 'bg-bg-tertiary'}`}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-bg-secondary shadow-sm transition-transform ${optIn ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
              </button>
            </div>

            {optIn && (
              <div className="sm:col-span-2">
                <label htmlFor="cbp-mincases" className="mb-1.5 block text-xs font-medium text-text-secondary">Publish only after at least this many cases</label>
                <input
                  id="cbp-mincases"
                  value={minCasesText}
                  onChange={(e) => setMinCasesText(e.target.value)}
                  disabled={!canEdit}
                  inputMode="numeric"
                  aria-invalid={minCasesInvalid || minCasesParsed === null}
                  aria-describedby="cbp-mincases-hint"
                  className="focus-ring w-32 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-60"
                />
                <p id="cbp-mincases-hint" className={`mt-1.5 text-xs ${minCasesInvalid || minCasesParsed === null ? 'text-danger' : 'text-text-secondary'}`}>
                  {minCasesInvalid || minCasesParsed === null ? 'Required: a whole number of at least 1.' : 'Only calls with a recorded callback attempt count toward a published number. Counts and percentages stay hidden below this sample.'}
                </p>
              </div>
            )}
          </div>

          {canEdit ? (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!dirty || problems.length > 0 || saving}
              className="focus-ring mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          ) : (
            <p className="mt-4 text-xs text-text-secondary">Only the account owner can change the callback promise.</p>
          )}
        </>
      )}
    </section>
  );
}
