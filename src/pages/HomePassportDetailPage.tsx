// Recreated: verify against original intent
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, ShieldAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useToast } from '@/contexts/ToastContext';
import {
  EVENT_LABELS,
  EVENT_TYPES,
  PASSPORT_SCOPES,
  SCOPE_LABELS,
  addPassportEvent,
  attestEvent,
  createGrant,
  getPassport,
  listGrants,
  passportErrorMessage,
  revokeGrant,
  setPassportSharing,
  syncPassport,
  type ManualEventType,
  type PassportDetail,
  type PassportEvent,
  type PassportGrant,
  type PassportScope,
} from '@/lib/homePassportNetwork';

const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const field = 'focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary';
const lab = 'mb-1 block text-xs font-semibold text-text-secondary';
const btn = 'focus-ring min-h-[40px] rounded-lg px-3 text-sm font-semibold disabled:opacity-50';
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

/** One passport by code: identity, trust signals, history (with confirm / dispute), contribute, sync, and time-boxed access links. */
export function HomePassportDetailPage() {
  const { code: rawCode = '' } = useParams<{ code: string }>();
  const code = decodeURIComponent(rawCode);
  const { toast } = useToast();
  const [data, setData] = useState<PassportDetail | null>(null);
  const [grants, setGrants] = useState<PassportGrant[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const seq = useRef(0);

  // add event
  const [evType, setEvType] = useState<ManualEventType>('note');
  const [evTitle, setEvTitle] = useState('');
  const [evDetail, setEvDetail] = useState('');
  const [evRestricted, setEvRestricted] = useState(false);
  // new grant
  const [gScopes, setGScopes] = useState<PassportScope[]>(['identity']);
  const [gHours, setGHours] = useState('72');
  const [gUses, setGUses] = useState('1');
  const [gLabel, setGLabel] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError('');
    try {
      const d = await getPassport(code);
      if (mine !== seq.current) return;
      setData(d);
      if (d.found && d.access === 'member') {
        const g = await listGrants(code).catch(() => [] as PassportGrant[]);
        if (mine === seq.current) setGrants(g);
      }
    } catch (e) {
      if (mine === seq.current) setError(passportErrorMessage(e, 'Could not load this passport.'));
    }
  }, [code]);

  useEffect(() => {
    setData(null);
    void load();
    return () => { seq.current++; };
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'success');
      await load();
    } catch (e) {
      toast(passportErrorMessage(e), 'error');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const hours = /^\d{1,4}$/.test(gHours.trim()) ? Number(gHours) : NaN;
  const uses = /^\d{1,2}$/.test(gUses.trim()) ? Number(gUses) : NaN;
  const grantOk = gScopes.length > 0 && hours >= 1 && hours <= 2160 && uses >= 1 && uses <= 25;

  const back = <Link to="/dashboard/home-passports" className="focus-ring mb-4 inline-flex items-center gap-1 rounded text-sm font-semibold text-accent"><ArrowLeft size={14} aria-hidden="true" /> All passports</Link>;

  if (error) return <DashboardLayout activeLabel="Home Passports">{back}<p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{error} <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">Try again</button></p></DashboardLayout>;
  if (!data) return <DashboardLayout activeLabel="Home Passports">{back}<p role="status" className="py-6 text-sm text-text-secondary">Loading…</p></DashboardLayout>;
  if (!data.found || !data.passport) return <DashboardLayout activeLabel="Home Passports">{back}<p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">No passport matches that code.</p></DashboardLayout>;

  const p = data.passport;
  const member = data.access === 'member';
  const stats = data.stats;
  const events: PassportEvent[] = data.events ?? [];
  const link = data.link;
  const address = [p.address_line, p.city, p.region, p.postal_code].filter(Boolean).join(', ') || [p.city, p.region].filter(Boolean).join(', ') || 'Address hidden';

  return (
    <DashboardLayout activeLabel="Home Passports">
      {back}
      <div className="mb-4">
        <h1 className="break-words text-2xl font-bold text-text-primary">{address}</h1>
        <p className="mt-1 text-sm text-text-secondary">Code {p.code} · {p.status}{p.property_type ? ` · ${p.property_type}` : ''}{p.year_built ? ` · built ${p.year_built}` : ''}</p>
      </div>

      {!member && <p role="status" className="mb-4 rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-secondary"><ShieldAlert size={14} className="me-1 inline" aria-hidden="true" /> Your company is not verified for this passport, so only summary signals are shown. Verify it with the code from the Home Passports page.</p>}

      {stats && (
        <dl className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {[['Records', String(stats.event_count)], ['Contributors', String(stats.contributor_count)], ['Service visits', String(stats.service_count)], ['Evidence-backed', String(stats.evidence_backed_count)]].map(([k, v]) => (
            <div key={k} className={card}><dt className="text-xs font-semibold text-text-secondary">{k}</dt><dd className="mt-1 text-xl font-bold text-text-primary">{v}</dd></div>
          ))}
        </dl>
      )}
      {stats && <p className="mb-4 text-xs text-text-secondary">First record {day(stats.first_event_at)} · last {day(stats.last_event_at)}{stats.avg_confidence !== null ? ` · average confidence ${Math.round(stats.avg_confidence * 100)}%` : ''}. Each record is chained to the one before it, so edits to history can be detected.</p>}

      {member && (
        <div className="space-y-4">
          <section className={card} aria-labelledby="hp-actions">
            <h2 id="hp-actions" className="text-base font-semibold text-text-primary">Your access</h2>
            <p className="mt-1 text-xs text-text-secondary">Role {link?.role ?? 'servicer'} · verified by {link?.verified_via ?? 'code'} · you can see: {(data.scopes ?? []).map((s) => SCOPE_LABELS[s] ?? s).join(', ') || 'nothing'}.</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" className={`${btn} border border-border text-text-primary`} disabled={busy !== null} onClick={() => void act('sync', async () => { const r = await syncPassport(code); toast(r.events_added > 0 ? `Added ${r.events_added} record(s) from your history.` : 'Already up to date.', 'info'); })}>{busy === 'sync' ? 'Syncing…' : 'Sync my service history'}</button>
              <label className="flex items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" checked={link?.show_contractor_publicly ?? true} disabled={busy !== null} onChange={(e) => void act('share', () => setPassportSharing(code, e.target.checked), 'Updated.')} />
                Show my company name on records I add
              </label>
            </div>
          </section>

          <section className={card} aria-labelledby="hp-history">
            <h2 id="hp-history" className="text-base font-semibold text-text-primary">History</h2>
            {events.length === 0 ? <p className="mt-2 text-sm text-text-secondary">No records you can see yet.</p> : (
              <ol className="mt-3 divide-y divide-border rounded-xl border border-border">
                {events.map((e) => (
                  <li key={e.id} className="px-3 py-3 text-sm">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-text-primary">
                      {e.title}
                      <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">{EVENT_LABELS[e.event_type] ?? e.event_type}</span>
                      {e.provenance.verification_level !== 'self_reported' && <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-success-500"><BadgeCheck size={11} aria-hidden="true" />{e.provenance.verification_level.replace(/_/g, ' ')}</span>}
                      {e.visibility === 'restricted' && <span className="text-[11px] font-semibold text-text-secondary">Restricted</span>}
                      {e.superseded && <span className="text-[11px] font-semibold text-warning-500">Corrected later</span>}
                    </p>
                    {e.detail && <p className="mt-1 whitespace-pre-wrap break-words text-text-secondary">{e.detail}</p>}
                    <p className="mt-1 text-xs text-text-secondary">{day(e.occurred_at)}{e.contributor_name ? ` · ${e.contributor_name}` : ''} · {e.provenance.source_type.replace(/_/g, ' ')} · confidence {Math.round(e.provenance.confidence * 100)}% · {e.provenance.confirmations} confirm / {e.provenance.disputes} dispute</p>
                    {!e.is_mine && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button type="button" disabled={busy !== null || e.provenance.my_stance === 'confirm'} className={`${btn} border border-border text-text-primary`} onClick={() => void act(`c-${e.id}`, () => attestEvent(e.id, 'confirm'), 'Confirmed.')}>{e.provenance.my_stance === 'confirm' ? 'You confirmed' : 'Confirm'}</button>
                        <button type="button" disabled={busy !== null || e.provenance.my_stance === 'dispute'} className={`${btn} border border-border text-text-primary`} onClick={() => void act(`d-${e.id}`, () => attestEvent(e.id, 'dispute'), 'Dispute recorded.')}>{e.provenance.my_stance === 'dispute' ? 'You disputed' : 'Dispute'}</button>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {(data.equipment?.length ?? 0) > 0 && (
            <section className={card} aria-labelledby="hp-eq">
              <h2 id="hp-eq" className="text-base font-semibold text-text-primary">Equipment</h2>
              <ul className="mt-3 divide-y divide-border rounded-xl border border-border text-sm">
                {data.equipment!.map((q, i) => (
                  <li key={`${q.code ?? i}`} className="px-3 py-2"><p className="font-medium text-text-primary">{[q.make, q.model].filter(Boolean).join(' ') || q.equipment_type || 'Equipment'}</p><p className="text-xs text-text-secondary">{q.equipment_type ?? ''} · {q.status} · installed {day(q.install_date)} · warranty to {day(q.warranty_expires_at)}</p></li>
                ))}
              </ul>
            </section>
          )}

          <section className={card} aria-labelledby="hp-add">
            <h2 id="hp-add" className="text-base font-semibold text-text-primary">Add a record</h2>
            <p className="mt-1 text-xs text-text-secondary">Records are added to the history and cannot be edited later. To fix a mistake, add a correction.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div><label htmlFor="ev-type" className={lab}>Type</label><select id="ev-type" value={evType} onChange={(e) => setEvType(e.target.value as ManualEventType)} className={field}>{EVENT_TYPES.map((t) => <option key={t} value={t}>{EVENT_LABELS[t]}</option>)}</select></div>
              <div><label htmlFor="ev-title" className={lab}>Title</label><input id="ev-title" value={evTitle} maxLength={200} onChange={(e) => setEvTitle(e.target.value)} className={field} /></div>
            </div>
            <label htmlFor="ev-detail" className={`${lab} mt-3`}>Details (optional)</label>
            <textarea id="ev-detail" value={evDetail} maxLength={2000} rows={3} onChange={(e) => setEvDetail(e.target.value)} className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
            <label className="mt-2 flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={evRestricted} onChange={(e) => setEvRestricted(e.target.checked)} />Only my company can see this record</label>
            <div className="mt-3"><button type="button" className={`${btn} bg-accent text-white`} disabled={busy !== null || !evTitle.trim()} onClick={() => void act('add', async () => { await addPassportEvent({ code, type: evType, title: evTitle, detail: evDetail, restricted: evRestricted }); setEvTitle(''); setEvDetail(''); setEvRestricted(false); }, 'Record added.')}>{busy === 'add' ? 'Adding…' : 'Add record'}</button></div>
          </section>

          <section className={card} aria-labelledby="hp-grants">
            <h2 id="hp-grants" className="text-base font-semibold text-text-primary">Share access</h2>
            <p className="mt-1 text-xs text-text-secondary">Create a time-limited link another company can use. You can only share access you hold, and you can revoke it at any time. Only share with the homeowner’s consent.</p>
            <fieldset className="mt-3"><legend className={lab}>What they can see</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {PASSPORT_SCOPES.filter((s) => (data.scopes ?? []).includes(s)).map((s) => (
                  <label key={s} className="flex items-center gap-1.5 text-sm text-text-primary"><input type="checkbox" checked={gScopes.includes(s)} onChange={(e) => setGScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))} />{SCOPE_LABELS[s]}</label>
                ))}
              </div>
            </fieldset>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div><label htmlFor="g-h" className={lab}>Expires after (hours, up to 2160)</label><input id="g-h" inputMode="numeric" value={gHours} onChange={(e) => setGHours(e.target.value)} className={field} /></div>
              <div><label htmlFor="g-u" className={lab}>Uses (1–25)</label><input id="g-u" inputMode="numeric" value={gUses} onChange={(e) => setGUses(e.target.value)} className={field} /></div>
              <div><label htmlFor="g-l" className={lab}>Label (optional)</label><input id="g-l" value={gLabel} maxLength={80} onChange={(e) => setGLabel(e.target.value)} className={field} /></div>
            </div>
            <div className="mt-3"><button type="button" className={`${btn} bg-accent text-white`} disabled={busy !== null || !grantOk} onClick={() => void act('grant', async () => { const r = await createGrant({ code, scopes: gScopes, ttlHours: hours, maxUses: uses, label: gLabel }); setNewToken(r.token); setGLabel(''); }, 'Access link created.')}>{busy === 'grant' ? 'Creating…' : 'Create access link'}</button></div>
            {newToken && (
              <div role="status" className="mt-3 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm">
                <p className="font-semibold text-text-primary">Copy this token now. It is shown only once.</p>
                <code className="mt-1 block break-all rounded bg-bg-primary p-2 text-xs text-text-primary">{newToken}</code>
                <button type="button" className={`${btn} mt-2 border border-border text-text-primary`} onClick={() => { void navigator.clipboard?.writeText(newToken).then(() => toast('Copied.', 'success'), () => toast('Could not copy. Select the text instead.', 'error')); }}>Copy</button>
                <button type="button" className={`${btn} mt-2 ms-2 text-text-secondary`} onClick={() => setNewToken(null)}>Hide</button>
              </div>
            )}
            {grants.length > 0 && (
              <ul className="mt-4 divide-y divide-border rounded-xl border border-border text-sm">
                {grants.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <div><p className="font-medium text-text-primary">{g.label ?? 'Access link'} <span className="text-xs font-normal text-text-secondary">· {g.state}</span></p><p className="text-xs text-text-secondary">{g.scopes.map((s) => SCOPE_LABELS[s] ?? s).join(', ')} · used {g.uses}/{g.max_uses} · expires {day(g.expires_at)}</p></div>
                    {g.state === 'active' && <button type="button" className={`${btn} border border-border text-text-primary`} disabled={busy !== null} onClick={() => void act(`r-${g.id}`, () => revokeGrant(g.id), 'Access revoked.')}>Revoke</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </DashboardLayout>
  );
}
