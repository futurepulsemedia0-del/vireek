// Recreated: verify against original intent
import { useCallback, useEffect, useRef, useState } from 'react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useToast } from '@/contexts/ToastContext';
import {
  EMERGENCY_SERVICES_NOTICE,
  PRECAUTIONS,
  REGION_LIMITS,
  RISK_TIERS,
  canTransition,
  completeWellbeing,
  fetchActiveSessions,
  fetchSettings,
  fetchTrends,
  incidentsToCsv,
  listAudits,
  listDeclines,
  listFacts,
  listIncidents,
  managerEndSession,
  resolveDecline,
  reviewAudit,
  reviewFact,
  saveSettings,
  savePolicy,
  setReportable,
  transitionIncident,
  validateSettings,
  INCIDENT_STATUSES,
  type ActiveSession,
  type AuditRow,
  type DeclineRow,
  type FactRowManager,
  type IncidentRow,
  type IncidentStatus,
  type Precaution,
  type RegionProfile,
  type RiskTier,
  type SafetySettings,
  type Trends,
} from '@/lib/siteSafety';

type TabId = 'live' | 'facts' | 'incidents' | 'declines' | 'settings' | 'audits';
const TABS: { id: TabId; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'facts', label: 'Fact review' },
  { id: 'incidents', label: 'Incidents' },
  { id: 'declines', label: 'Declines' },
  { id: 'settings', label: 'Settings' },
  { id: 'audits', label: 'Fairness' },
];

const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const field = 'focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary';
const lab = 'mb-1 block text-xs font-semibold text-text-secondary';
const btn = 'focus-ring min-h-[40px] rounded-lg px-3 text-sm font-semibold disabled:opacity-50';
const primary = `${btn} bg-accent text-white`;
const ghost = `${btn} border border-border text-text-primary`;

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/** Loads once, guards against stale responses, exposes reload. */
function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setError('');
    try {
      const r = await fn();
      if (mine === seq.current) setData(r);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error && e.message ? e.message : 'Could not load.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
    return () => { seq.current++; };
  }, [reload]);
  return { data, error, reload };
}

function Status({ error, loading, retry }: { error: string; loading: boolean; retry: () => void }) {
  if (error) return <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{error} <button type="button" onClick={retry} className="focus-ring font-semibold underline">Try again</button></p>;
  if (loading) return <p role="status" className="py-4 text-sm text-text-secondary">Loading…</p>;
  return null;
}

/** Runs one action at a time and toasts the outcome. */
function useAct(after: () => void | Promise<void>) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'success');
      await after();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Action failed.', 'error');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  return { busy, act };
}

export function SiteSafetyPage() {
  const [tab, setTab] = useState<TabId>('live');
  return (
    <DashboardLayout activeLabel="Site Safety">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-text-primary">Site safety</h1>
        <p className="mt-1 text-sm text-text-secondary">Lone-worker check-ins, site facts and incidents. {EMERGENCY_SERVICES_NOTICE}</p>
      </div>
      <div role="tablist" aria-label="Site safety sections" className="mb-4 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button key={t.id} id={`ss-tab-${t.id}`} role="tab" type="button" aria-selected={tab === t.id} aria-controls={`ss-panel-${t.id}`} onClick={() => setTab(t.id)} className={`focus-ring min-h-[44px] rounded-t-lg px-4 text-sm font-semibold ${tab === t.id ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`ss-panel-${tab}`} aria-labelledby={`ss-tab-${tab}`}>
        {tab === 'live' && <LiveTab />}
        {tab === 'facts' && <FactsTab />}
        {tab === 'incidents' && <IncidentsTab />}
        {tab === 'declines' && <DeclinesTab />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'audits' && <AuditsTab />}
      </div>
    </DashboardLayout>
  );
}

// ------------------------------------------------------------------------------------------------ live

function LiveTab() {
  const { data, error, reload } = useLoad<ActiveSession[]>(() => fetchActiveSessions());
  const { busy, act } = useAct(reload);
  const trends = useLoad<Trends>(() => fetchTrends(6));

  useEffect(() => {
    const id = window.setInterval(() => { void reload(); }, 30_000);
    return () => window.clearInterval(id);
  }, [reload]);

  return (
    <div className="space-y-4">
      <div className={card}>
        <h2 className="text-base font-semibold text-text-primary">Active check-ins</h2>
        <div className="mt-3"><Status error={error} loading={!data} retry={() => void reload()} /></div>
        {data && data.length === 0 && <p className="mt-3 text-sm text-text-secondary">No one is checked in right now.</p>}
        {data && data.length > 0 && (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {data.map((s) => (
              <li key={s.session_id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                <div className="min-w-0 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-text-primary">
                    {s.technician_name ?? 'Technician'} · {s.customer_name}
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.status === 'active' ? 'bg-success-500/10 text-success-500' : 'bg-danger/10 text-danger'}`}>{s.status === 'duress' ? 'Duress' : s.status === 'escalating' ? 'Missed check-in' : 'On track'}</span>
                    {s.is_drill && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">Drill</span>}
                  </p>
                  <p className="text-xs text-text-secondary">{s.address ?? 'No address'} · next check-in {fmtTime(s.next_checkin_due_at)} · last seen {fmtTime(s.last_seen_at)}</p>
                  {s.last_location && <p className="text-xs text-text-secondary">Last location {s.last_location.lat.toFixed(4)}, {s.last_location.lng.toFixed(4)} at {fmtTime(s.last_location.recorded_at)}</p>}
                </div>
                <button type="button" className={ghost} disabled={busy !== null} onClick={() => void act(`end-${s.session_id}`, () => managerEndSession(s.session_id, s.status === 'active' ? 'completed' : 'cancelled'), 'Check-in ended.')}>End check-in</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={card}>
        <h2 className="text-base font-semibold text-text-primary">Last 6 months</h2>
        <div className="mt-3"><Status error={trends.error} loading={!trends.data} retry={() => void trends.reload()} /></div>
        {trends.data && (
          trends.data.sessions.length === 0 ? <p className="text-sm text-text-secondary">No check-ins recorded yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-sm">
                <thead className="text-xs text-text-secondary"><tr><th className="py-2 pe-3 font-semibold">Month</th><th className="px-3 font-semibold">Check-ins</th><th className="px-3 font-semibold">Escalated</th><th className="px-3 font-semibold">Duress</th><th className="ps-3 font-semibold">False alarms</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {trends.data.sessions.map((r) => (
                    <tr key={r.month}><th scope="row" className="py-2 pe-3 font-medium text-text-primary">{r.month}</th><td className="px-3 text-text-secondary">{r.total}</td><td className="px-3 text-text-secondary">{r.escalated}</td><td className="px-3 text-text-secondary">{r.duress}</td><td className="ps-3 text-text-secondary">{r.false_alarms}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ facts

function FactsTab() {
  const [filter, setFilter] = useState<FactRowManager['review_status'] | 'all'>('pending_review');
  const { data, error, reload } = useLoad<FactRowManager[]>(() => listFacts(filter), [filter]);
  const { busy, act } = useAct(reload);
  const [notes, setNotes] = useState<Record<string, string>>({});

  return (
    <div className={card}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Fact review</h2>
          <p className="text-xs text-text-secondary">Facts from calls start unconfirmed and never raise a job to the highest tier until a person confirms them. Facts describe events at an exact address only.</p>
        </div>
        <div>
          <label htmlFor="ss-fact-filter" className={lab}>Show</label>
          <select id="ss-fact-filter" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className={field}>
            <option value="pending_review">Waiting for review</option><option value="confirmed">Confirmed</option><option value="disputed">Disputed</option><option value="rejected">Rejected</option><option value="all">All</option>
          </select>
        </div>
      </div>
      <div className="mt-3"><Status error={error} loading={!data} retry={() => void reload()} /></div>
      {data && data.length === 0 && <p className="mt-3 text-sm text-text-secondary">Nothing here.</p>}
      {data && data.length > 0 && (
        <ul className="mt-3 space-y-3">
          {data.map((f) => (
            <li key={f.id} className="rounded-xl border border-border p-3 text-sm">
              <p className="font-semibold text-text-primary">{f.category.replace(/_/g, ' ')} <span className="font-normal text-text-secondary">· {f.source.replace(/_/g, ' ')} · {f.review_status.replace('_', ' ')}</span></p>
              <p className="mt-1 break-words text-text-primary">{f.fact_text}</p>
              {f.quote && <p className="mt-1 break-words text-xs italic text-text-secondary">Caller said: “{f.quote}”</p>}
              <p className="mt-1 text-xs text-text-secondary">Occurred {f.occurred_on} · expires {f.expires_on}</p>
              <label htmlFor={`fn-${f.id}`} className={`${lab} mt-2`}>Note (optional)</label>
              <input id={`fn-${f.id}`} value={notes[f.id] ?? ''} maxLength={300} onChange={(e) => setNotes((p) => ({ ...p, [f.id]: e.target.value }))} className={field} />
              <div className="mt-2 flex flex-wrap gap-2">
                {f.review_status !== 'confirmed' && <button type="button" className={primary} disabled={busy !== null} onClick={() => void act(`c-${f.id}`, () => reviewFact(f.id, 'confirm', { note: notes[f.id] }), 'Fact confirmed.')}>Confirm</button>}
                {f.review_status !== 'rejected' && <button type="button" className={ghost} disabled={busy !== null} onClick={() => void act(`r-${f.id}`, () => reviewFact(f.id, 'reject', { note: notes[f.id] }), 'Fact rejected.')}>Reject</button>}
                {f.review_status === 'confirmed' && <button type="button" className={ghost} disabled={busy !== null} onClick={() => void act(`d-${f.id}`, () => reviewFact(f.id, 'dispute', { note: notes[f.id] }), 'Marked as disputed.')}>Dispute</button>}
                {(f.review_status === 'rejected' || f.review_status === 'disputed') && <button type="button" className={ghost} disabled={busy !== null} onClick={() => void act(`o-${f.id}`, () => reviewFact(f.id, 'reopen', { note: notes[f.id] }), 'Reopened for review.')}>Reopen</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ incidents

function IncidentsTab() {
  const { data, error, reload } = useLoad<IncidentRow[]>(() => listIncidents());
  const { busy, act } = useAct(reload);

  const exportCsv = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([`\uFEFF${incidentsToCsv(data)}\r\n`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `safety-incidents-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-text-primary">Incidents</h2>
        <button type="button" className={ghost} onClick={exportCsv} disabled={!data || data.length === 0}>Export CSV</button>
      </div>
      <div className="mt-3"><Status error={error} loading={!data} retry={() => void reload()} /></div>
      {data && data.length === 0 && <p className="mt-3 text-sm text-text-secondary">No incidents reported.</p>}
      {data && data.length > 0 && (
        <ul className="mt-3 space-y-3">
          {data.map((i) => {
            const next = INCIDENT_STATUSES.filter((s: IncidentStatus) => canTransition(i.status, s));
            return (
              <li key={i.id} className="rounded-xl border border-border p-3 text-sm">
                <p className="font-semibold text-text-primary">#{i.case_number} · {i.category.replace('_', ' ')} · {i.severity} <span className="font-normal text-text-secondary">· {i.status}</span></p>
                <p className="mt-1 whitespace-pre-wrap break-words text-text-primary">{i.description}</p>
                <p className="mt-1 text-xs text-text-secondary">Occurred {fmtTime(i.occurred_at)}{i.attachments.length ? ` · ${i.attachments.length} attachment(s)` : ''}{i.wellbeing_due_at && !i.wellbeing_checked_at ? ` · wellbeing check due ${fmtTime(i.wellbeing_due_at)}` : ''}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {next.map((s) => <button key={s} type="button" className={ghost} disabled={busy !== null} onClick={() => void act(`t-${i.id}-${s}`, () => transitionIncident(i.id, s), `Moved to ${s}.`)}>{s === 'closed' ? 'Close' : `Move to ${s}`}</button>)}
                  {i.wellbeing_due_at && !i.wellbeing_checked_at && <button type="button" className={primary} disabled={busy !== null} onClick={() => void act(`w-${i.id}`, () => completeWellbeing(i.id), 'Wellbeing check recorded.')}>Wellbeing check done</button>}
                  <button type="button" className={ghost} disabled={busy !== null} onClick={() => void act(`p-${i.id}`, () => setReportable(i.id, !i.regulatory_reportable), i.regulatory_reportable ? 'Unmarked as reportable.' : 'Marked reportable.')}>{i.regulatory_reportable ? 'Not reportable' : 'Mark reportable'}</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ declines

function DeclinesTab() {
  const { data, error, reload } = useLoad<DeclineRow[]>(() => listDeclines());
  const { busy, act } = useAct(reload);
  return (
    <div className={card}>
      <h2 className="text-base font-semibold text-text-primary">Decline and reschedule requests</h2>
      <p className="text-xs text-text-secondary">Never used for scoring, pay or retention.</p>
      <div className="mt-3"><Status error={error} loading={!data} retry={() => void reload()} /></div>
      {data && data.length === 0 && <p className="mt-3 text-sm text-text-secondary">No requests.</p>}
      {data && data.length > 0 && (
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm">
              <div>
                <p className="font-medium text-text-primary">{d.action === 'decline' ? 'Declined' : 'Reschedule requested'} · {d.reason_code.replace(/_/g, ' ')}</p>
                <p className="text-xs text-text-secondary">{fmtTime(d.created_at)} · {d.status} · customer notice {d.customer_notice_status}</p>
              </div>
              {d.status === 'open' && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={ghost} disabled={busy !== null} onClick={() => void act(`a-${d.id}`, () => resolveDecline(d.id, 'rescheduled'), 'Marked rescheduled.')}>Rescheduled</button>
                  <button type="button" className={ghost} disabled={busy !== null} onClick={() => void act(`b-${d.id}`, () => resolveDecline(d.id, 'reassigned'), 'Marked reassigned.')}>Reassigned</button>
                  <button type="button" className={ghost} disabled={busy !== null} onClick={() => void act(`c-${d.id}`, () => resolveDecline(d.id, 'closed'), 'Closed.')}>Close</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ settings

const DEFAULTS: SafetySettings = {
  enabled: false, region_profile: 'standard', labor_review_ack: false, monitoring_consent_required: true, notice_version: 1,
  location_sharing_enabled: false, location_visibility: 'on_escalation', location_retention_days: 30,
  checkin_interval_minutes: 60, checkin_grace_minutes: 5, overrun_prompt_minutes: 15, unreachable_minutes: 15,
  escalation_chain: [], dispatcher_phone: null, company_next_phone: null, duress_word_enabled: true, sms_fallback_enabled: true,
  drills_enabled: true, fact_ttl_days: 365, show_unreviewed_call_facts: false, auto_notify_customer_on_decline: true,
  decline_customer_message: null, appeal_contact: null, incident_retention_months: 36, timezone: 'UTC',
};

const VALIDATION_TEXT: Record<string, string> = {
  labor_review_required: 'Confirm that labour / works-council review is done before turning location on.',
  visibility_not_allowed: 'This region profile only allows location to be seen when an alert is raised.',
  retention_out_of_range: 'Location retention is outside the limit for this region profile.',
  interval_out_of_range: 'Check-in interval must be 10–240 minutes.',
  grace_out_of_range: 'Grace period must be 1–30 minutes.',
  overrun_out_of_range: 'Overrun prompt must be 5–240 minutes.',
  unreachable_out_of_range: 'Unreachable time must be 5–120 minutes.',
  region_profile: 'Choose a region profile.',
};

const PHONE_RE = /^\+?[0-9]{6,15}$/;

function SettingsTab() {
  const { toast } = useToast();
  const { data, error, reload } = useLoad(() => fetchSettings());
  const [draft, setDraft] = useState<SafetySettings | null>(null);
  const [policy, setPolicy] = useState<Partial<Record<RiskTier, Precaution[]>>>({});
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);

  useEffect(() => {
    if (data) {
      setDraft(data.settings ?? DEFAULTS);
      setPolicy(data.policy ?? {});
    }
  }, [data]);

  if (error || !data || !draft) return <Status error={error} loading retry={() => void reload()} />;

  const set = <K extends keyof SafetySettings>(k: K, v: SafetySettings[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const num = (v: string) => (/^\d{1,4}$/.test(v.trim()) ? Number(v) : NaN);
  const problems = validateSettings(draft);
  const phoneBad = (draft.dispatcher_phone && !PHONE_RE.test(draft.dispatcher_phone)) || (draft.company_next_phone && !PHONE_RE.test(draft.company_next_phone));
  const lim = REGION_LIMITS[draft.region_profile];
  const canSave = problems.length === 0 && !phoneBad && !saving;

  const save = async () => {
    if (lock.current || !canSave) return;
    lock.current = true;
    setSaving(true);
    try {
      const res = await saveSettings(draft);
      toast(res.notice_bumped ? 'Saved. Technicians will be asked to agree to the updated notice.' : 'Settings saved.', 'success');
      await reload();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not save.', 'error');
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };

  const togglePrecaution = async (tier: RiskTier, p: Precaution) => {
    const cur = policy[tier] ?? [];
    const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p];
    setPolicy((m) => ({ ...m, [tier]: next }));
    try {
      await savePolicy(tier, next);
    } catch (e) {
      setPolicy((m) => ({ ...m, [tier]: cur }));
      toast(e instanceof Error && e.message ? e.message : 'Could not save precautions.', 'error');
    }
  };

  const numField = (id: string, label: string, key: 'checkin_interval_minutes' | 'checkin_grace_minutes' | 'overrun_prompt_minutes' | 'unreachable_minutes' | 'location_retention_days') => (
    <div>
      <label htmlFor={id} className={lab}>{label}</label>
      <input id={id} inputMode="numeric" value={Number.isNaN(draft[key]) ? '' : String(draft[key])} onChange={(e) => set(key, num(e.target.value))} className={field} />
    </div>
  );

  return (
    <div className="space-y-4">
      <section className={card} aria-labelledby="ss-set">
        <h2 id="ss-set" className="text-base font-semibold text-text-primary">Lone-worker settings</h2>
        <p className="mt-1 text-xs text-text-secondary">Region profiles are configurable defaults, not legal advice. Confirm local labour, works-council and privacy requirements with counsel.</p>

        <div className="mt-4 space-y-4">
          <label className="flex items-start gap-2 text-sm text-text-primary"><input type="checkbox" className="mt-1" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} /><span>Turn on lone-worker safety<span className="block text-xs text-text-secondary">Alerts your own team only. It does not contact emergency services.</span></span></label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="ss-region" className={lab}>Region profile</label>
              <select id="ss-region" value={draft.region_profile} onChange={(e) => { const r = e.target.value as RegionProfile; const l = REGION_LIMITS[r]; setDraft((d) => d && ({ ...d, region_profile: r, location_retention_days: Math.min(d.location_retention_days, l.maxLocationRetentionDays), location_visibility: l.allowedLocationVisibility.includes(d.location_visibility) ? d.location_visibility : 'on_escalation' })); }} className={field}>
                <option value="standard">Standard</option><option value="strict_eu">Strict (EU)</option><option value="custom">Custom</option>
              </select>
            </div>
            <label className="flex items-start gap-2 self-end pb-2 text-sm text-text-primary"><input type="checkbox" className="mt-1" checked={draft.monitoring_consent_required} onChange={(e) => set('monitoring_consent_required', e.target.checked)} /><span>Technicians must agree to a monitoring notice</span></label>
            {numField('ss-int', 'Check-in every (minutes)', 'checkin_interval_minutes')}
            {numField('ss-grace', 'Grace before alert (minutes)', 'checkin_grace_minutes')}
            {numField('ss-over', 'Prompt when job overruns (minutes)', 'overrun_prompt_minutes')}
            {numField('ss-unr', 'Treat as unreachable after (minutes)', 'unreachable_minutes')}
            <div>
              <label htmlFor="ss-disp" className={lab}>Dispatcher phone (for alerts)</label>
              <input id="ss-disp" inputMode="tel" value={draft.dispatcher_phone ?? ''} onChange={(e) => set('dispatcher_phone', e.target.value.trim() || null)} className={field} placeholder="+15551234567" />
            </div>
            <div>
              <label htmlFor="ss-next" className={lab}>Company next-step phone</label>
              <input id="ss-next" inputMode="tel" value={draft.company_next_phone ?? ''} onChange={(e) => set('company_next_phone', e.target.value.trim() || null)} className={field} placeholder="+15551234567" />
            </div>
          </div>
          {phoneBad && <p role="alert" className="text-xs text-danger">Use digits only, with an optional leading +.</p>}

          <fieldset className="rounded-xl border border-border p-3">
            <legend className="px-1 text-xs font-semibold text-text-secondary">Location</legend>
            <label className="flex items-start gap-2 text-sm text-text-primary"><input type="checkbox" className="mt-1" checked={draft.location_sharing_enabled} onChange={(e) => set('location_sharing_enabled', e.target.checked)} /><span>Allow technicians to share location during a check-in<span className="block text-xs text-text-secondary">Each technician must also opt in themselves, and location is only stored while a check-in runs.</span></span></label>
            {draft.location_sharing_enabled && (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="ss-vis" className={lab}>Who can see it</label>
                  <select id="ss-vis" value={draft.location_visibility} onChange={(e) => set('location_visibility', e.target.value as SafetySettings['location_visibility'])} className={field}>
                    {lim.allowedLocationVisibility.map((v) => <option key={v} value={v}>{v === 'on_escalation' ? 'Only when an alert is raised' : 'Dispatcher, during the job'}</option>)}
                  </select>
                </div>
                {numField('ss-ret', `Keep for (days, max ${lim.maxLocationRetentionDays})`, 'location_retention_days')}
                {lim.requiresLaborReviewAck && <label className="flex items-start gap-2 text-sm text-text-primary sm:col-span-2"><input type="checkbox" className="mt-1" checked={draft.labor_review_ack} onChange={(e) => set('labor_review_ack', e.target.checked)} /><span>I confirm labour / works-council and privacy review is complete for this region</span></label>}
              </div>
            )}
          </fieldset>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={draft.duress_word_enabled} onChange={(e) => set('duress_word_enabled', e.target.checked)} />Allow a private duress word</label>
            <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={draft.sms_fallback_enabled} onChange={(e) => set('sms_fallback_enabled', e.target.checked)} />Text-message fallback</label>
            <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={draft.drills_enabled} onChange={(e) => set('drills_enabled', e.target.checked)} />Allow practice drills</label>
            <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={draft.auto_notify_customer_on_decline} onChange={(e) => set('auto_notify_customer_on_decline', e.target.checked)} />Tell the customer when a job is rescheduled</label>
          </div>
        </div>

        {problems.length > 0 && <ul role="alert" className="mt-3 list-disc space-y-0.5 ps-5 text-xs text-danger">{problems.map((p) => <li key={p}>{VALIDATION_TEXT[p] ?? p}</li>)}</ul>}
        <div className="mt-4"><button type="button" className={primary} disabled={!canSave} onClick={() => void save()}>{saving ? 'Saving…' : 'Save settings'}</button></div>
      </section>

      <section className={card} aria-labelledby="ss-pol">
        <h2 id="ss-pol" className="text-base font-semibold text-text-primary">Precautions by risk level</h2>
        <p className="mt-1 text-xs text-text-secondary">Shown to technicians in the pre-job brief. Changes save as you tick.</p>
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          {RISK_TIERS.map((tier) => (
            <fieldset key={tier} className="rounded-xl border border-border p-3">
              <legend className="px-1 text-xs font-semibold capitalize text-text-secondary">{tier}</legend>
              {PRECAUTIONS.map((p) => (
                <label key={p} className="flex items-start gap-2 py-0.5 text-sm text-text-primary"><input type="checkbox" className="mt-1" checked={(policy[tier] ?? []).includes(p)} onChange={() => void togglePrecaution(tier, p)} />{p.replace(/_/g, ' ')}</label>
              ))}
            </fieldset>
          ))}
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ audits

function AuditsTab() {
  const { data, error, reload } = useLoad<AuditRow[]>(() => listAudits());
  const { busy, act } = useAct(reload);
  return (
    <div className={card}>
      <h2 className="text-base font-semibold text-text-primary">Weekly fairness screen</h2>
      <p className="text-xs text-text-secondary">It uses no demographic data, so it cannot prove an absence of bias. Findings go to a person for review.</p>
      <div className="mt-3"><Status error={error} loading={!data} retry={() => void reload()} /></div>
      {data && data.length === 0 && <p className="mt-3 text-sm text-text-secondary">No screens have run yet.</p>}
      {data && data.length > 0 && (
        <ul className="mt-3 space-y-3">
          {data.map((a) => (
            <li key={a.id} className="rounded-xl border border-border p-3 text-sm">
              <p className="font-semibold text-text-primary">{a.period_start} to {a.period_end} <span className="font-normal text-text-secondary">· {a.finding_count} finding(s) · {a.status.replace(/_/g, ' ')}</span></p>
              <p className="text-xs text-text-secondary">{a.report.jobs} jobs, {a.report.flagged_jobs} flagged ({Math.round(a.report.overall_flag_rate * 100)}%).</p>
              {a.report.findings.length > 0 && <ul className="mt-1 list-disc ps-5 text-xs text-text-secondary">{a.report.findings.map((f, i) => <li key={`${f.code}:${i}`}>{f.code.replace(/_/g, ' ')}</li>)}</ul>}
              {a.review_note && <p className="mt-1 text-xs text-text-secondary">Note: {a.review_note}</p>}
              {a.status === 'open' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className={ghost} disabled={busy !== null} onClick={() => void act(`n-${a.id}`, () => reviewAudit(a.id, 'reviewed_no_action'), 'Marked reviewed.')}>Reviewed, no action</button>
                  <button type="button" className={ghost} disabled={busy !== null} onClick={() => void act(`r-${a.id}`, () => reviewAudit(a.id, 'action_required'), 'Marked action required.')}>Action required</button>
                </div>
              )}
              {a.status === 'action_required' && <div className="mt-2"><button type="button" className={ghost} disabled={busy !== null} onClick={() => void act(`d-${a.id}`, () => reviewAudit(a.id, 'actioned'), 'Marked actioned.')}>Mark actioned</button></div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
