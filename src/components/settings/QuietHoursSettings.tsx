import { useCallback, useEffect, useMemo, useState } from 'react';
import { MoonStar, Loader2, Trash2, Send } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  DEFAULT_QUIET_HOURS,
  US_TIMEZONES,
  cancelDeferred,
  listDeferred,
  loadQuietHours,
  previewByZone,
  releaseDeferred,
  saveQuietHours,
  validateSettings,
  type Channel,
  type DeferredMessage,
  type QuietHoursSettings as Settings,
} from '@/lib/quietHoursApi';

const CHANNELS: Array<{ id: Channel; label: string }> = [
  { id: 'sms', label: 'SMS' },
  { id: 'email', label: 'Email' },
  { id: 'call', label: 'Calls' },
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtWhen(iso: string, tz?: string | null): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz || undefined }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Dashboard card: per-business quiet hours, holiday blackouts, timezone-aware sending,
 * and the queue of messages currently held. Mount next to EscalationSettings in
 * BusinessProfilePage.tsx. Enforcement lives server-side in
 * supabase/functions/_shared/messaging/quietHours.ts.
 */
export function QuietHoursSettings() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [settings, setSettings] = useState<Settings>(DEFAULT_QUIET_HOURS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [hasProfile, setHasProfile] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newDate, setNewDate] = useState('');
  const [queue, setQueue] = useState<DeferredMessage[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refreshQueue = useCallback(async () => {
    try {
      setQueue(await listDeferred());
    } catch {
      toast('Could not load held messages.', 'error');
    } finally {
      setQueueLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await loadQuietHours(user.id);
        if (cancelled) return;
        setSettings(r.settings);
        setHasProfile(r.hasProfile);
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void refreshQueue();
    return () => {
      cancelled = true;
    };
  }, [user, refreshQueue]);

  const preview = useMemo(() => previewByZone(settings), [settings]);

  const update = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setDirty(true);
  };

  const toggleChannel = (c: Channel) =>
    update({ channels: settings.channels.includes(c) ? settings.channels.filter((x) => x !== c) : [...settings.channels, c] });
  const toggleDay = (d: number) =>
    update({ quietWeekdays: settings.quietWeekdays.includes(d) ? settings.quietWeekdays.filter((x) => x !== d) : [...settings.quietWeekdays, d].sort() });

  const addDate = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate) || settings.blackoutDates.includes(newDate)) return;
    update({ blackoutDates: [...settings.blackoutDates, newDate].sort() });
    setNewDate('');
  };

  const handleSave = async () => {
    if (!user) return;
    const problem = validateSettings(settings);
    if (problem) {
      toast(problem, 'error');
      return;
    }
    setSaving(true);
    try {
      const ok = await saveQuietHours(user.id, settings);
      if (!ok) {
        toast('Save your business profile first, then set quiet hours.', 'error');
      } else {
        toast('Quiet hours saved.', 'success');
        setDirty(false);
      }
    } catch {
      toast('Could not save quiet hours. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRelease = async (m: DeferredMessage) => {
    const reason = window.prompt('Send now outside quiet hours? Enter the reason (kept in the audit log):');
    if (!reason?.trim()) return;
    setBusyId(m.id);
    try {
      const ok = await releaseDeferred(m.id, reason.trim());
      toast(ok ? 'Released — it will send within a few minutes.' : 'This message cannot be released early.', ok ? 'success' : 'error');
      await refreshQueue();
    } catch {
      toast('Could not release the message.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleCancel = async (m: DeferredMessage) => {
    if (!window.confirm('Cancel this held message? It will not be sent.')) return;
    setBusyId(m.id);
    try {
      await cancelDeferred(m.id);
      await refreshQueue();
    } catch {
      toast('Could not cancel the message.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-indigo-50 p-2">
          <MoonStar className="h-5 w-5 text-indigo-600" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-slate-900">Quiet hours &amp; timezone-aware sending</h3>
          <p className="mt-1 text-sm text-slate-500">
            Texts, emails, calls and campaigns are held outside your window and sent when it is a good time for the
            customer — judged in the customer&apos;s own timezone. Texts and calls are never sent outside 8am–9pm
            customer time. Emergencies can override. This is a configuration aid, not legal advice.
          </p>

          {loading ? (
            <div className="mt-6 flex items-center gap-2 text-sm text-slate-500" role="status">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : loadError ? (
            <p className="mt-6 text-sm text-red-600" role="alert">Could not load quiet hours settings. Refresh to try again.</p>
          ) : (
            <>
              {!hasProfile && (
                <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                  Save your business profile first — these settings attach to it.
                </p>
              )}

              <label className="mt-5 flex items-center gap-3">
                <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-indigo-600" />
                <span className="text-sm font-medium text-slate-800">Enable business quiet hours</span>
              </label>

              <div className={`mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3 ${settings.enabled ? '' : 'opacity-50'}`}>
                <label className="text-sm text-slate-700">
                  Business timezone
                  <select value={settings.timezone} disabled={!settings.enabled} onChange={(e) => update({ timezone: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                    {!US_TIMEZONES.some((z) => z.value === settings.timezone) && <option value={settings.timezone}>{settings.timezone}</option>}
                    {US_TIMEZONES.map((z) => (
                      <option key={z.value} value={z.value}>{z.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-slate-700">
                  Quiet from
                  <input type="time" value={settings.start} disabled={!settings.enabled} onChange={(e) => update({ start: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                </label>
                <label className="text-sm text-slate-700">
                  Quiet until
                  <input type="time" value={settings.end} disabled={!settings.enabled} onChange={(e) => update({ end: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                </label>
              </div>

              <fieldset className={`mt-4 ${settings.enabled ? '' : 'opacity-50'}`} disabled={!settings.enabled}>
                <legend className="text-sm font-medium text-slate-700">Applies to</legend>
                <div className="mt-2 flex flex-wrap gap-3">
                  {CHANNELS.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={settings.channels.includes(c.id)} onChange={() => toggleChannel(c.id)} className="h-4 w-4 rounded border-slate-300 text-indigo-600" />
                      {c.label}
                    </label>
                  ))}
                </div>
                <p className="mt-4 text-sm font-medium text-slate-700">Fully quiet days</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {WEEKDAYS.map((d, i) => (
                    <button key={d} type="button" onClick={() => toggleDay(i)} aria-pressed={settings.quietWeekdays.includes(i)} className={`rounded-full border px-3 py-1 text-xs font-medium ${settings.quietWeekdays.includes(i) ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 text-slate-700'}`}>
                      {d}
                    </button>
                  ))}
                </div>
              </fieldset>

              <div className="mt-4 space-y-3">
                <label className="flex items-center gap-3 text-sm text-slate-700">
                  <input type="checkbox" checked={settings.useFederalHolidays} onChange={(e) => update({ useFederalHolidays: e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-indigo-600" />
                  Skip US federal holidays
                </label>
                <label className="flex items-center gap-3 text-sm text-slate-700">
                  <input type="checkbox" checked={settings.allowEmergencyOverride} onChange={(e) => update({ allowEmergencyOverride: e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-indigo-600" />
                  Allow emergency messages to override quiet hours
                </label>
                <div>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="text-sm text-slate-700">
                      Extra blackout date
                      <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <button type="button" onClick={addDate} disabled={!newDate} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50">Add</button>
                  </div>
                  {settings.blackoutDates.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {settings.blackoutDates.map((d) => (
                        <span key={d} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">
                          {d}
                          <button type="button" aria-label={`Remove ${d}`} onClick={() => update({ blackoutDates: settings.blackoutDates.filter((x) => x !== d) })} className="text-slate-500 hover:text-red-600">×</button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-5 rounded-xl bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Right now, a marketing text would…</p>
                <ul className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
                  {preview.map((p) => (
                    <li key={p.timezone} className="flex justify-between gap-2">
                      <span className="text-slate-600">{p.label}</span>
                      <span className={p.decision.allowed ? 'font-medium text-emerald-700' : 'font-medium text-amber-700'}>
                        {p.decision.allowed ? 'send now' : `wait until ${fmtWhen(p.decision.sendAt, p.timezone)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <button type="button" onClick={handleSave} disabled={!dirty || saving} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save quiet hours
              </button>

              <div className="mt-8 border-t border-slate-200 pt-5">
                <h4 className="text-sm font-semibold text-slate-900">Held messages</h4>
                {queueLoading ? (
                  <p className="mt-2 text-sm text-slate-500">Loading…</p>
                ) : queue.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">Nothing is waiting. Messages held by quiet hours or holidays appear here until they send.</p>
                ) : (
                  <ul className="mt-3 divide-y divide-slate-100">
                    {queue.map((m) => (
                      <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-800">{m.channel.toUpperCase()} → {m.to_address}</p>
                          <p className="text-xs text-slate-500">Sends {fmtWhen(m.send_after, m.timezone)} · {m.purpose}{m.defer_reason ? ` · ${m.defer_reason.toLowerCase().replace('_', ' ')}` : ''}</p>
                        </div>
                        <div className="flex gap-2">
                          {m.purpose !== 'marketing' && (
                            <button type="button" disabled={busyId === m.id} onClick={() => handleRelease(m)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 disabled:opacity-50">
                              <Send className="h-3 w-3" /> Send now
                            </button>
                          )}
                          <button type="button" disabled={busyId === m.id} onClick={() => handleCancel(m)} className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-xs font-medium text-red-600 disabled:opacity-50">
                            <Trash2 className="h-3 w-3" /> Cancel
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
