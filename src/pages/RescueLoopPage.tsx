import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, LifeBuoy, RefreshCw, Settings2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { RescueTimeline } from '@/components/rescue/RescueTimeline';
import {
  DEFAULT_SLA_SETTINGS,
  SLA_META,
  SLA_PRESETS,
  caseTypeLabel,
  evaluateCase,
  filterCases,
  formatDuration,
  formatMoney,
  parseSlaLimitInput,
  summarizeCases,
  type RescueCase,
  type RescueEvent,
  type RescueFilter,
  type RescueSlaSettings,
} from '@/lib/rescueLoop';
import { loadRescueCases, loadRescueEvents, loadRescueSettings, saveRescueSettings } from '@/lib/rescueLoopData';

const REFRESH_MS = 60_000;
const FILTERS: Array<{ id: RescueFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'pending', label: 'Clock running' },
  { id: 'met', label: 'On time' },
  { id: 'excused', label: 'Quiet hours / closed' },
];

function isFilter(v: string | null): v is RescueFilter {
  return FILTERS.some((f) => f.id === v);
}

function timeAgo(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return `${formatDuration(s)} ago`;
}

export function RescueLoopPage() {
  const { toast } = useToast();
  const { isOwner } = useAuth();
  const [params, setParams] = useSearchParams();
  const [cases, setCases] = useState<RescueCase[] | null>(null);
  const [settings, setSettings] = useState<RescueSlaSettings>(DEFAULT_SLA_SETTINGS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [openId, setOpenId] = useState<string | null>(params.get('call'));
  const [events, setEvents] = useState<Record<string, RescueEvent[]>>({});
  const [eventErrors, setEventErrors] = useState<Record<string, string>>({});
  const [eventLoading, setEventLoading] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const rawFilter = params.get('filter');
  const filter: RescueFilter = isFilter(rawFilter) ? rawFilter : 'all';
  const requestSeq = useRef(0);
  const loadedOnce = useRef(false);

  const load = useCallback(
    async (silent = false) => {
      const seq = ++requestSeq.current;
      if (silent) setRefreshing(true);
      try {
        const [c, s] = await Promise.all([loadRescueCases(), loadRescueSettings()]);
        if (seq !== requestSeq.current) return;
        loadedOnce.current = true;
        setCases(c);
        setSettings(s);
        setLoadError(null);
        setEvents({}); // timelines are re-fetched lazily so they never go stale
        setNow(Date.now());
      } catch (err) {
        if (seq !== requestSeq.current) return;
        const message = err instanceof Error ? err.message : 'Could not load the Rescue Loop.';
        if (!loadedOnce.current) setLoadError(message);
        else toast(message, 'error');
      } finally {
        if (seq === requestSeq.current) setRefreshing(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    load();
    const id = window.setInterval(() => load(true), REFRESH_MS);
    const onVisible = () => document.visibilityState === 'visible' && load(true);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const hasRunning = useMemo(() => (cases ?? []).some((c) => evaluateCase(c, settings, now).status === 'pending'), [cases, settings, now]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), hasRunning ? 1000 : 30_000);
    return () => window.clearInterval(id);
  }, [hasRunning]);

  const fetchEvents = useCallback(async (callId: string) => {
    setEventLoading(callId);
    setEventErrors((p) => {
      const next = { ...p };
      delete next[callId];
      return next;
    });
    try {
      const rows = await loadRescueEvents([callId]);
      setEvents((p) => ({ ...p, [callId]: rows }));
    } catch (err) {
      setEventErrors((p) => ({ ...p, [callId]: err instanceof Error ? err.message : 'Could not load the timeline.' }));
    } finally {
      setEventLoading((cur) => (cur === callId ? null : cur));
    }
  }, []);

  useEffect(() => {
    if (openId && events[openId] === undefined && !eventErrors[openId] && eventLoading !== openId && cases?.some((c) => c.callId === openId)) {
      fetchEvents(openId);
    }
  }, [openId, events, eventErrors, eventLoading, cases, fetchEvents]);

  const summary = useMemo(() => (cases ? summarizeCases(cases, settings, now) : null), [cases, settings, now]);
  const visible = useMemo(() => (cases ? filterCases(cases, filter, settings, now) : []), [cases, filter, settings, now]);

  const setFilter = (f: RescueFilter) => {
    const next = new URLSearchParams(params);
    if (f === 'all') next.delete('filter');
    else next.set('filter', f);
    setParams(next, { replace: true });
  };

  const toggle = (callId: string) => {
    const next = openId === callId ? null : callId;
    setOpenId(next);
    const p = new URLSearchParams(params);
    if (next) p.set('call', next);
    else p.delete('call');
    setParams(p, { replace: true });
  };

  const saveSettings = async (s: RescueSlaSettings) => {
    try {
      await saveRescueSettings(s);
      setSettings(s);
      toast('SLA settings saved.', 'success');
      load(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the SLA settings.', 'error');
    }
  };

  return (
    <DashboardLayout activeLabel="Rescue Loop">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <LifeBuoy size={24} />
          </span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Rescue Loop</h1>
            <p className="text-sm text-text-secondary">Every missed call, step by step — from the first text to the payment.</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            aria-expanded={showSettings}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            <Settings2 size={14} /> <span className="hidden sm:inline">SLA</span>
          </button>
          <button
            type="button"
            onClick={() => load(true)}
            disabled={refreshing || cases === null}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> <span className="hidden sm:inline">{refreshing ? 'Updating…' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {showSettings && <SlaSettingsCard settings={settings} canEdit={isOwner} onSave={saveSettings} />}

      {cases === null && !loadError && (
        <div className="space-y-3" aria-busy="true" aria-label="Loading">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl bg-bg-tertiary" />
            ))}
          </div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />
          ))}
        </div>
      )}

      {loadError && (
        <div role="alert" className="rounded-2xl border border-danger-500/30 bg-danger-500/5 p-6 text-center">
          <p className="text-sm text-danger-500">{loadError}</p>
          <button type="button" onClick={() => load()} className="focus-ring mt-3 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-primary">
            Try again
          </button>
        </div>
      )}

      {cases && summary && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Answered within limit" value={summary.complianceRate === null ? '–' : `${Math.round(summary.complianceRate * 100)}%`} hint={`limit ${formatDuration(settings.firstResponseLimitSeconds)}`} />
            <Stat label="Median first response" value={formatDuration(summary.medianResponseSeconds)} />
            <Stat label="Waiting right now" value={String(summary.breached)} tone={summary.breached > 0 ? 'bad' : undefined} />
            <Stat label="Revenue at risk" value={formatMoney(summary.atRiskValueCents)} tone={summary.atRiskValueCents > 0 ? 'bad' : undefined} />
          </div>

          <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Filter cases">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${
                  filter === f.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
              <p className="text-sm text-text-secondary">
                {cases.length === 0
                  ? 'No missed, voicemail or unbooked calls in the last 30 days. When one happens, its rescue timeline will appear here.'
                  : 'Nothing in this filter. Choose “All” to see the rest.'}
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {visible.map((c) => (
                <CaseCard
                  key={c.callId}
                  c={c}
                  settings={settings}
                  now={now}
                  open={openId === c.callId}
                  onToggle={() => toggle(c.callId)}
                  events={events[c.callId]}
                  loading={eventLoading === c.callId || (openId === c.callId && events[c.callId] === undefined && !eventErrors[c.callId])}
                  error={eventErrors[c.callId] ?? null}
                  onRetry={() => fetchEvents(c.callId)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </DashboardLayout>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'bad' }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary px-4 py-3">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-0.5 text-lg font-bold ${tone === 'bad' ? 'text-danger-500' : 'text-text-primary'}`}>{value}</p>
      {hint && <p className="text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

interface CardProps {
  c: RescueCase;
  settings: RescueSlaSettings;
  now: number;
  open: boolean;
  onToggle: () => void;
  events: RescueEvent[] | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

function CaseCard({ c, settings, now, open, onToggle, events, loading, error, onRetry }: CardProps) {
  const ev = evaluateCase(c, settings, now);
  const meta = SLA_META[ev.status];
  const panelId = `rescue-${c.callId}`;

  let slaText = '';
  if (ev.status === 'met' || ev.status === 'late') slaText = `Responded in ${formatDuration(ev.responseSeconds)}`;
  else if (ev.status === 'pending') slaText = `${formatDuration(ev.remainingSeconds)} left to respond`;
  else if (ev.status === 'breached') slaText = `Waiting ${formatDuration(Math.round((now - new Date(c.clockStart).getTime()) / 1000))}`;
  else if (ev.status === 'excused') slaText = 'Text queued until quiet hours end';
  else slaText = 'No response needed';

  return (
    <li className={`rounded-2xl border bg-bg-secondary shadow-card dark:shadow-card-dark ${ev.status === 'breached' ? 'border-danger-500/40' : 'border-border'}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={panelId} className="focus-ring flex w-full items-start justify-between gap-3 rounded-2xl p-4 text-left sm:p-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.className}`}>{meta.label}</span>
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">{caseTypeLabel(c.caseType)}</span>
            {c.bookedAt && <span className="rounded-full bg-success-500/10 px-2 py-0.5 text-xs font-medium text-success-500">Booked</span>}
            {c.paidAt && <span className="rounded-full bg-success-500/10 px-2 py-0.5 text-xs font-medium text-success-500">Paid</span>}
            {c.valueCents > 0 && <span className="text-xs font-semibold text-text-primary">{formatMoney(c.valueCents)}</span>}
          </div>
          <h3 className="mt-1.5 truncate text-sm font-semibold text-text-primary">{c.callerName}</h3>
          <p className="mt-0.5 text-sm text-text-secondary">
            {slaText} · {timeAgo(c.callAt, now)}
          </p>
          {c.callerPhone && <p className="mt-0.5 text-xs text-text-secondary">{c.callerPhone}</p>}
        </div>
        <ChevronDown size={18} className={`mt-1 shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div id={panelId} className="border-t border-border p-4 sm:p-5">
          <RescueTimeline events={events ?? []} clockStart={c.clockStart} limitSeconds={c.limitSeconds} now={now} loading={loading} error={error} onRetry={onRetry} />
        </div>
      )}
    </li>
  );
}

function SlaSettingsCard({ settings, canEdit, onSave }: { settings: RescueSlaSettings; canEdit: boolean; onSave: (s: RescueSlaSettings) => Promise<void> }) {
  const [limitText, setLimitText] = useState(String(settings.firstResponseLimitSeconds));
  const [alertsEnabled, setAlertsEnabled] = useState(settings.alertsEnabled);
  const [excuse, setExcuse] = useState(settings.excuseQuietHours);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLimitText(String(settings.firstResponseLimitSeconds));
    setAlertsEnabled(settings.alertsEnabled);
    setExcuse(settings.excuseQuietHours);
  }, [settings]);

  const parsed = parseSlaLimitInput(limitText);
  const dirty = parsed !== settings.firstResponseLimitSeconds || alertsEnabled !== settings.alertsEnabled || excuse !== settings.excuseQuietHours;

  const submit = async () => {
    if (parsed === null) return;
    setSaving(true);
    await onSave({ firstResponseLimitSeconds: parsed, alertsEnabled, excuseQuietHours: excuse });
    setSaving(false);
  };

  return (
    <section aria-label="SLA settings" className="mb-4 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-text-primary">First-response SLA</h2>
      <p className="mt-0.5 text-xs text-text-secondary">How fast every missed caller must get a text or a call back. You are alerted the moment the limit passes.</p>

      <div className="mt-4">
        <label htmlFor="rescue-limit" className="mb-1.5 block text-xs font-medium text-text-secondary">Limit (e.g. 60, 90s, 2m, 1h)</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="rescue-limit"
            value={limitText}
            onChange={(e) => setLimitText(e.target.value)}
            disabled={!canEdit}
            inputMode="text"
            aria-invalid={parsed === null}
            className="focus-ring w-28 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-60"
          />
          {SLA_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              disabled={!canEdit}
              onClick={() => setLimitText(String(p))}
              className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium disabled:opacity-60 ${parsed === p ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
            >
              {formatDuration(p)}
            </button>
          ))}
        </div>
        {parsed === null && <p className="mt-1.5 text-xs text-danger-500">Enter between 10 seconds and 24 hours.</p>}
      </div>

      <Toggle label="Alert me when the limit is missed" checked={alertsEnabled} disabled={!canEdit} onChange={setAlertsEnabled} />
      <Toggle label="Excuse texts held back by quiet hours" checked={excuse} disabled={!canEdit} onChange={setExcuse} />

      {canEdit ? (
        <button
          type="button"
          onClick={submit}
          disabled={!dirty || parsed === null || saving}
          className="focus-ring mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      ) : (
        <p className="mt-4 text-xs text-text-secondary">Only the account owner can change these settings.</p>
      )}
    </section>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="mt-3 flex items-center justify-between gap-4">
      <span className="text-sm text-text-primary">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}
