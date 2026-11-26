import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { listIncidents, type IncidentRow } from '@/lib/siteSafety';
import {
  CLASSIFICATIONS, CLASSIFICATION_LABEL, ILLNESS_LABEL, ILLNESS_TYPES, MAX_COUNTED_DAYS, PRIVACY_REASONS, PRIVACY_REASON_LABEL,
  caseDraftFromIncident, isPastRetention, logName, logToCsv, parseWholeNumber, summaryMissingLabels, summaryToCsv, validateCaseInput,
  type OshaCaseInput, type OshaCaseRow, type OshaSummaryExport,
} from '@/lib/osha/core';
import {
  certifyOshaSummary, createOshaCase, exportOshaLog, exportOshaSummary, getOshaSettings, listCasesPastRetention, listOshaCases,
  saveOshaSettings, saveOshaSummaryInputs, voidOshaCase, type OshaSettings,
} from '@/lib/oshaApi';

const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const field = 'focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary';
const lab = 'mb-1 block text-xs font-semibold text-text-secondary';
const btn = 'focus-ring min-h-[40px] rounded-lg px-3 text-sm font-semibold disabled:opacity-50';
const primary = `${btn} bg-accent text-on-accent`;
const ghost = `${btn} border border-border text-text-primary`;

const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}\r\n`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const BLANK: OshaCaseInput = {
  employee_name: '', job_title: '', description: '', date_of_injury: '', classification: 'other_recordable',
  illness_type: 'injury', days_away: 0, days_restricted: 0, privacy_case: false,
};

/**
 * OSHA 300 / 300A / 301 recordkeeping. Managers only (the database enforces it; this panel is a convenience).
 * It records and exports data. It does not decide what is recordable and it is not legal advice.
 */
export function OshaRecordkeepingPanel() {
  const { toast } = useToast();
  const [year, setYear] = useState(new Date().getFullYear());
  const [cases, setCases] = useState<OshaCaseRow[] | null>(null);
  const [settings, setSettings] = useState<OshaSettings | null>(null);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [pastRetention, setPastRetention] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError('');
    try {
      const [c, s, inc, past] = await Promise.all([listOshaCases(year), getOshaSettings(), listIncidents(), listCasesPastRetention()]);
      if (mine !== seq.current) return;
      setCases(c);
      setSettings(s);
      setIncidents(inc.filter((i) => i.category === 'injury'));
      setPastRetention(past.length);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error && e.message ? e.message : 'Could not load OSHA records.');
    }
  }, [year]);
  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, fn: () => Promise<void>, ok?: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Action failed.', 'error');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const promoted = new Set((cases ?? []).map((c) => c.incident_id).filter(Boolean));
  const candidates = incidents.filter((i) => !promoted.has(i.id));

  return (
    <div className="space-y-4">
      <section className={card} aria-labelledby="osha-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="osha-title" className="text-lg font-semibold text-text-primary">OSHA injury and illness records</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Keeps the Form 300 log, Form 300A summary and Form 301 details for your establishment. Only managers can see this tab.
              Vireek records and exports what you enter; it does not decide whether a case is recordable.
            </p>
          </div>
          <div>
            <label htmlFor="osha-year" className={lab}>Year</label>
            <select id="osha-year" className={`${field} w-28`} value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {Array.from({ length: 8 }, (_, i) => new Date().getFullYear() - i).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        {pastRetention > 0 && (
          <p role="status" className="mt-3 rounded-lg border border-border bg-bg-primary p-3 text-sm text-text-secondary">
            {pastRetention} case{pastRetention === 1 ? ' is' : 's are'} past the retention date you configured. Nothing is deleted automatically.
          </p>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      </section>

      <SettingsCard settings={settings} busy={busy} act={act} onSaved={load} />

      <CasesCard
        year={year} cases={cases} candidates={candidates} busy={busy} act={act} onChanged={load}
        retentionYears={settings?.retention_years ?? 5}
      />

      <SummaryCard year={year} busy={busy} act={act} onChanged={load} />
    </div>
  );
}

type Act = (key: string, fn: () => Promise<void>, ok?: string) => Promise<void>;

function SettingsCard({ settings, busy, act, onSaved }: { settings: OshaSettings | null; busy: string | null; act: Act; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ establishment_name: '', street: '', city: '', state: '', zip: '', industry_description: '', naics_code: '', retention_years: '5' });
  useEffect(() => {
    if (!settings) return;
    setF({
      establishment_name: settings.establishment_name ?? '', street: settings.street ?? '', city: settings.city ?? '', state: settings.state ?? '',
      zip: settings.zip ?? '', industry_description: settings.industry_description ?? '', naics_code: settings.naics_code ?? '',
      retention_years: String(settings.retention_years),
    });
  }, [settings]);
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const years = parseWholeNumber(f.retention_years, 30);
  const valid = years !== null && years >= 5 && (f.naics_code === '' || /^\d{2,6}$/.test(f.naics_code));
  const items: Array<[keyof typeof f, string, number]> = [
    ['establishment_name', 'Establishment name', 200], ['street', 'Street address', 200], ['city', 'City', 100], ['state', 'State', 50],
    ['zip', 'ZIP code', 12], ['industry_description', 'Industry description', 200], ['naics_code', 'NAICS code', 6],
  ];
  return (
    <section className={card} aria-labelledby="osha-est">
      <h3 id="osha-est" className="text-sm font-semibold text-text-primary">Establishment</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {items.map(([k, label, max]) => (
          <div key={k}>
            <label htmlFor={`osha-${k}`} className={lab}>{label}</label>
            <input id={`osha-${k}`} className={field} value={f[k]} maxLength={max} onChange={set(k)} />
          </div>
        ))}
        <div>
          <label htmlFor="osha-ret" className={lab}>Keep records for (years after the case year)</label>
          <input id="osha-ret" className={field} inputMode="numeric" value={f.retention_years} onChange={set('retention_years')} aria-describedby="osha-ret-help" />
          <p id="osha-ret-help" className="mt-1 text-xs text-text-secondary">Minimum 5. {/* TODO(counsel): confirm the period. */}Confirm the period with your counsel.</p>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" className={primary} disabled={!valid || busy !== null}
          onClick={() => void act('settings', async () => {
            await saveOshaSettings({
              establishment_name: f.establishment_name, street: f.street, city: f.city, state: f.state, zip: f.zip,
              industry_description: f.industry_description, naics_code: f.naics_code, retention_years: years ?? 5,
            });
            await onSaved();
          }, 'Establishment saved.')}>
          {busy === 'settings' ? 'Saving…' : 'Save establishment'}
        </button>
      </div>
    </section>
  );
}

function CasesCard({ year, cases, candidates, busy, act, onChanged, retentionYears }: {
  year: number; cases: OshaCaseRow[] | null; candidates: IncidentRow[]; busy: string | null; act: Act; onChanged: () => Promise<void>; retentionYears: number;
}) {
  const [draft, setDraft] = useState<OshaCaseInput | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [voiding, setVoiding] = useState<{ id: string; reason: string } | null>(null);
  const today = todayIso();
  const patch = (p: Partial<OshaCaseInput>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const submit = () => {
    if (!draft) return;
    const errs = validateCaseInput(draft);
    setErrors(errs);
    if (errs.length) return;
    void act('create', async () => {
      const res = await createOshaCase(draft);
      setDraft(null);
      await onChanged();
      if (res.existing) throw new Error(`This incident is already recorded as case ${res.case_no}.`);
    }, 'Case recorded.');
  };

  const exportLog = () => void act('log', async () => {
    const r = await exportOshaLog(year);
    download(`osha-300-log-${year}.csv`, logToCsv(r.rows));
  });

  return (
    <section className={card} aria-labelledby="osha-cases">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="osha-cases" className="text-sm font-semibold text-text-primary">Form 300 log — {year}</h3>
        <div className="flex gap-2">
          <button type="button" className={ghost} disabled={busy !== null} onClick={() => setDraft({ ...BLANK })}>Add case</button>
          <button type="button" className={ghost} disabled={busy !== null || !cases?.length} onClick={exportLog}>{busy === 'log' ? 'Exporting…' : 'Export CSV'}</button>
        </div>
      </div>

      {candidates.length > 0 && (
        <div className="mt-3 rounded-lg border border-border bg-bg-primary p-3">
          <p className="text-xs font-semibold text-text-secondary">Injury reports not yet on the log</p>
          <ul className="mt-2 space-y-2">
            {candidates.slice(0, 10).map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-primary">
                <span className="min-w-0 truncate">#{i.case_number} · {i.occurred_at.slice(0, 10)} · {i.description.slice(0, 80)}</span>
                <button type="button" className={ghost} disabled={busy !== null} onClick={() => setDraft({ ...BLANK, ...caseDraftFromIncident(i) })}>Review for the log</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {draft && (
        <form className="mt-4 rounded-lg border border-border bg-bg-primary p-3" aria-label="New OSHA case" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label htmlFor="oc-name" className={lab}>Employee name</label><input id="oc-name" className={field} value={draft.employee_name} maxLength={120} onChange={(e) => patch({ employee_name: e.target.value })} /></div>
            <div><label htmlFor="oc-title" className={lab}>Job title</label><input id="oc-title" className={field} value={draft.job_title} maxLength={120} onChange={(e) => patch({ job_title: e.target.value })} /></div>
            <div><label htmlFor="oc-date" className={lab}>Date of injury or onset</label><input id="oc-date" type="date" className={field} max={today} value={draft.date_of_injury} onChange={(e) => patch({ date_of_injury: e.target.value })} /></div>
            <div><label htmlFor="oc-where" className={lab}>Where the event occurred</label><input id="oc-where" className={field} value={draft.location_where ?? ''} maxLength={200} onChange={(e) => patch({ location_where: e.target.value })} /></div>
            <div className="sm:col-span-2"><label htmlFor="oc-desc" className={lab}>Describe the injury or illness and the body part</label><textarea id="oc-desc" rows={3} className={`${field} py-2`} value={draft.description} maxLength={2000} onChange={(e) => patch({ description: e.target.value })} /></div>
            <div>
              <label htmlFor="oc-class" className={lab}>Most serious outcome</label>
              <select id="oc-class" className={field} value={draft.classification} onChange={(e) => patch({ classification: e.target.value as OshaCaseInput['classification'] })}>
                {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{CLASSIFICATION_LABEL[c]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="oc-type" className={lab}>Type</label>
              <select id="oc-type" className={field} value={draft.illness_type} onChange={(e) => patch({ illness_type: e.target.value as OshaCaseInput['illness_type'] })}>
                {ILLNESS_TYPES.map((t) => <option key={t} value={t}>{ILLNESS_LABEL[t]}</option>)}
              </select>
            </div>
            <div><label htmlFor="oc-away" className={lab}>Days away from work (0–{MAX_COUNTED_DAYS})</label><input id="oc-away" inputMode="numeric" className={field} value={draft.days_away ?? 0} onChange={(e) => patch({ days_away: Number(e.target.value.replace(/\D/g, '') || 0) })} /></div>
            <div><label htmlFor="oc-restr" className={lab}>Days on job transfer or restriction (0–{MAX_COUNTED_DAYS})</label><input id="oc-restr" inputMode="numeric" className={field} value={draft.days_restricted ?? 0} onChange={(e) => patch({ days_restricted: Number(e.target.value.replace(/\D/g, '') || 0) })} /></div>
            {draft.classification === 'death' && (
              <div><label htmlFor="oc-died" className={lab}>Date of death</label><input id="oc-died" type="date" className={field} max={today} value={draft.died_on ?? ''} onChange={(e) => patch({ died_on: e.target.value })} /></div>
            )}
            <div className="flex items-center gap-2 sm:col-span-2">
              <input id="oc-priv" type="checkbox" className="h-4 w-4" checked={draft.privacy_case === true} onChange={(e) => patch({ privacy_case: e.target.checked, privacy_reason: e.target.checked ? draft.privacy_reason : null })} />
              <label htmlFor="oc-priv" className="text-sm text-text-primary">Privacy case (the name is replaced by “Privacy Case” on exports)</label>
            </div>
            {draft.privacy_case && (
              <div>
                <label htmlFor="oc-pr" className={lab}>Privacy reason</label>
                <select id="oc-pr" className={field} value={draft.privacy_reason ?? ''} onChange={(e) => patch({ privacy_reason: (e.target.value || null) as OshaCaseInput['privacy_reason'] })}>
                  <option value="">Not specified</option>
                  {PRIVACY_REASONS.map((r) => <option key={r} value={r}>{PRIVACY_REASON_LABEL[r]}</option>)}
                </select>
              </div>
            )}
          </div>
          <details className="mt-3">
            <summary className="focus-ring cursor-pointer text-sm font-semibold text-text-primary">More details for Form 301</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div><label htmlFor="oc-act" className={lab}>What was the employee doing just before?</label><input id="oc-act" className={field} value={draft.activity_before ?? ''} maxLength={1000} onChange={(e) => patch({ activity_before: e.target.value })} /></div>
              <div><label htmlFor="oc-how" className={lab}>What happened?</label><input id="oc-how" className={field} value={draft.how_occurred ?? ''} maxLength={2000} onChange={(e) => patch({ how_occurred: e.target.value })} /></div>
              <div><label htmlFor="oc-nat" className={lab}>What was the injury or illness?</label><input id="oc-nat" className={field} value={draft.injury_nature ?? ''} maxLength={500} onChange={(e) => patch({ injury_nature: e.target.value })} /></div>
              <div><label htmlFor="oc-obj" className={lab}>Object or substance that harmed the employee</label><input id="oc-obj" className={field} value={draft.object_substance ?? ''} maxLength={300} onChange={(e) => patch({ object_substance: e.target.value })} /></div>
              <div><label htmlFor="oc-fac" className={lab}>Treatment facility</label><input id="oc-fac" className={field} value={draft.treatment_facility ?? ''} maxLength={200} onChange={(e) => patch({ treatment_facility: e.target.value })} /></div>
              <div><label htmlFor="oc-doc" className={lab}>Physician or health care professional</label><input id="oc-doc" className={field} value={draft.physician_name ?? ''} maxLength={120} onChange={(e) => patch({ physician_name: e.target.value })} /></div>
            </div>
          </details>
          {errors.length > 0 && (
            <ul role="alert" className="mt-3 list-disc ps-5 text-sm text-danger">{errors.map((m) => <li key={m}>{m}</li>)}</ul>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={ghost} disabled={busy !== null} onClick={() => { setDraft(null); setErrors([]); }}>Cancel</button>
            <button type="submit" className={primary} disabled={busy !== null}>{busy === 'create' ? 'Saving…' : 'Record case'}</button>
          </div>
        </form>
      )}

      <div className="mt-4 overflow-x-auto">
        {cases === null ? (
          <p className="text-sm text-text-secondary" aria-busy="true">Loading…</p>
        ) : cases.length === 0 ? (
          <p className="text-sm text-text-secondary">No cases recorded for {year}.</p>
        ) : (
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">OSHA cases for {year}</caption>
            <thead><tr className="text-xs text-text-secondary">
              <th scope="col" className="py-2 pe-3">Case</th><th scope="col" className="pe-3">Employee</th><th scope="col" className="pe-3">Date</th>
              <th scope="col" className="pe-3">Outcome</th><th scope="col" className="pe-3">Retain until</th><th scope="col"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} className="border-t border-border align-top text-text-primary">
                  <td className="py-2 pe-3 font-medium">{c.case_no}</td>
                  <td className="pe-3">{logName(c)}<span className="block text-xs text-text-secondary">{c.job_title}</span></td>
                  <td className="pe-3">{c.date_of_injury}</td>
                  <td className="pe-3">{c.voided_at ? 'Voided' : CLASSIFICATION_LABEL[c.classification]}</td>
                  <td className="pe-3">{c.retain_until}{isPastRetention(c.retain_until, today) && <span className="ms-1 text-xs text-text-secondary">(past)</span>}</td>
                  <td>
                    {!c.voided_at && (voiding?.id === c.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <label htmlFor={`void-${c.id}`} className="sr-only">Reason for voiding case {c.case_no}</label>
                        <input id={`void-${c.id}`} className={`${field} min-h-[40px] w-48`} placeholder="Reason (5+ characters)" value={voiding.reason} maxLength={500} onChange={(e) => setVoiding({ id: c.id, reason: e.target.value })} />
                        <button type="button" className={ghost} disabled={busy !== null || voiding.reason.trim().length < 5}
                          onClick={() => void act('void', async () => { await voidOshaCase(c.id, voiding.reason); setVoiding(null); await onChanged(); }, 'Case voided. The record is kept.')}>Confirm</button>
                        <button type="button" className={ghost} onClick={() => setVoiding(null)}>Cancel</button>
                      </div>
                    ) : (
                      <button type="button" className={ghost} disabled={busy !== null} onClick={() => setVoiding({ id: c.id, reason: '' })} aria-label={`Void case ${c.case_no}`}>Void</button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="mt-3 text-xs text-text-secondary">Records are kept until {`Dec 31 of the case year + ${retentionYears} years`}. Voiding keeps the row. {/* TODO(counsel): amendment and employee-access procedures. */}</p>
    </section>
  );
}

function SummaryCard({ year, busy, act, onChanged }: { year: number; busy: string | null; act: Act; onChanged: () => Promise<void> }) {
  const [summary, setSummary] = useState<OshaSummaryExport | null>(null);
  const [employees, setEmployees] = useState('');
  const [hours, setHours] = useState('');
  const [cert, setCert] = useState({ name: '', title: '', phone: '' });
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    setErr('');
    try {
      const s = await exportOshaSummary(year);
      setSummary(s);
      setEmployees(s.avg_employees === null ? '' : String(s.avg_employees));
      setHours(s.total_hours === null ? '' : String(s.total_hours));
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : 'Could not load the summary.');
    }
  }, [year]);
  useEffect(() => { setSummary(null); setAck(false); void refresh(); }, [refresh]);

  const emp = parseWholeNumber(employees, 10_000_000);
  const hrs = parseWholeNumber(hours, 100_000_000_000);
  const certified = summary?.certification != null;
  const t = summary?.totals;

  return (
    <section className={card} aria-labelledby="osha-sum">
      <h3 id="osha-sum" className="text-sm font-semibold text-text-primary">Form 300A summary — {year}</h3>
      {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
      {t && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
          {([['Deaths', t.deaths], ['Days-away cases', t.days_away_cases], ['Transfer / restriction cases', t.job_transfer_cases], ['Other recordable cases', t.other_recordable_cases],
            ['Days away', t.total_days_away], ['Days on transfer / restriction', t.total_days_restricted]] as const).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-border py-1"><dt className="text-text-secondary">{k}</dt><dd className="font-semibold tabular-nums text-text-primary">{v}</dd></div>
          ))}
        </dl>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div><label htmlFor="osha-emp" className={lab}>Annual average number of employees</label><input id="osha-emp" className={field} inputMode="numeric" value={employees} disabled={certified} onChange={(e) => setEmployees(e.target.value)} /></div>
        <div><label htmlFor="osha-hrs" className={lab}>Total hours worked by all employees</label><input id="osha-hrs" className={field} inputMode="numeric" value={hours} disabled={certified} onChange={(e) => setHours(e.target.value)} /></div>
      </div>
      {!certified && (
        <div className="mt-3 flex justify-end">
          <button type="button" className={ghost} disabled={busy !== null || emp === null || hrs === null}
            onClick={() => void act('sum-save', async () => { await saveOshaSummaryInputs(year, emp as number, hrs as number); await refresh(); }, 'Summary inputs saved.')}>Save inputs</button>
        </div>
      )}
      {summary && summary.missing.length > 0 && (
        <p role="status" className="mt-3 text-sm text-text-secondary">Still needed: {summaryMissingLabels(summary.missing).join(', ')}.</p>
      )}
      {certified ? (
        <p className="mt-3 text-sm text-text-primary">Certified by {summary?.certification?.name}, {summary?.certification?.title}, on {summary?.certification?.at.slice(0, 10)}. The figures are frozen.</p>
      ) : (
        <fieldset className="mt-4 rounded-lg border border-border p-3">
          <legend className="px-1 text-xs font-semibold text-text-secondary">Certification</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><label htmlFor="osha-cn" className={lab}>Name</label><input id="osha-cn" className={field} value={cert.name} maxLength={120} onChange={(e) => setCert({ ...cert, name: e.target.value })} /></div>
            <div><label htmlFor="osha-ct" className={lab}>Title</label><input id="osha-ct" className={field} value={cert.title} maxLength={120} onChange={(e) => setCert({ ...cert, title: e.target.value })} /></div>
            <div><label htmlFor="osha-cp" className={lab}>Phone (optional)</label><input id="osha-cp" className={field} value={cert.phone} maxLength={40} onChange={(e) => setCert({ ...cert, phone: e.target.value })} /></div>
          </div>
          <div className="mt-3 flex items-start gap-2">
            <input id="osha-ack" type="checkbox" className="mt-0.5 h-4 w-4" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            {/* TODO(counsel): approve this attestation wording and who may certify. */}
            <label htmlFor="osha-ack" className="text-sm text-text-primary">I have reviewed the log and this summary and I am the person who is authorized to certify it.</label>
          </div>
          <div className="mt-3 flex justify-end">
            <button type="button" className={primary} disabled={busy !== null || !ack || !cert.name.trim() || !cert.title.trim() || (summary?.missing.length ?? 1) > 0}
              onClick={() => void act('sum-cert', async () => { await certifyOshaSummary(year, cert.name, cert.title, cert.phone || undefined); await refresh(); await onChanged(); }, 'Summary certified.')}>
              {busy === 'sum-cert' ? 'Certifying…' : 'Certify summary'}
            </button>
          </div>
        </fieldset>
      )}
      <div className="mt-4 flex justify-end">
        <button type="button" className={ghost} disabled={busy !== null || !summary}
          onClick={() => void act('sum-export', async () => { const s = await exportOshaSummary(year); download(`osha-300a-summary-${year}.csv`, summaryToCsv(s)); })}>Export CSV</button>
      </div>
    </section>
  );
}
