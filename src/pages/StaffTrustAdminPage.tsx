/**
 * Trust admin — /staff/trust-admin (Vireek staff only, wrapped in <StaffRoute>)
 *
 * Publishes the content behind the security portal and runs the Trust Pack operations:
 * pentest summaries, sub-processor notices, SLA incidents/policies, region availability,
 * region-change approvals (+ data migration) and dedicated-tenant provisioning.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { Badge, Card, Field, PanelError, PanelSkeleton, Spinner, fmtDate, inputClass, useLoader } from '@/components/trust-pack/ui';
import {
  fetchNotices, fetchPentests, fetchRegions, staffCompleteChange, staffCreateNotice, staffCreatePentest, staffDecideChange,
  staffDispatchNotice, staffListChangeRequests, staffListDedicated, staffListIncidents, staffMigrate, staffPublishPentest,
  staffSaveIncident, staffSetRegionAvailability, staffUpdateDedicated, staffUpdateIncident, staffUpsertSlaPolicy, staffWithdrawNotice,
} from '@/lib/trustPack/api';
import { INCIDENT_KINDS, type IncidentKind } from '@/lib/trustPack/sla';
import { NOTICE_CHANGE_TYPES, SEVERITIES, emptyCounts, validateNoticeInput, validatePentestInput, type SeverityCounts } from '@/lib/trustPack/notices';
import { REGION_CODES, REGIONS, regionLabel, type RegionCode } from '@/lib/trustPack/regions';

const isoLocal = (v: string) => (v ? new Date(v).toISOString() : '');

function useAction() {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  return {
    busy,
    async run(tag: string, fn: () => Promise<string | void>, ok: string, after?: () => void) {
      setBusy(tag);
      try { const m = await fn(); toast(m || ok, 'success'); after?.(); }
      catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); }
      finally { setBusy(null); }
    },
  };
}

function Section<T>({ title, loader, children }: { title: string; loader: ReturnType<typeof useLoader<T>>; children: (d: T) => ReactNode }) {
  return (
    <Card title={title}>
      {loader.status === 'loading' ? <PanelSkeleton /> : loader.status === 'error' || !loader.data ? <PanelError message={loader.error || 'Could not load.'} onRetry={loader.retry} /> : children(loader.data)}
    </Card>
  );
}

// ---------------------------------------------------------------- pentests
function PentestSection() {
  const loader = useLoader(fetchPentests);
  const { busy, run } = useAction();
  const [f, setF] = useState({ title: '', tester: '', performed_on: '', scope: '', methodology: '', summary: '' });
  const [found, setFound] = useState<SeverityCounts>(emptyCounts());
  const [rem, setRem] = useState<SeverityCounts>(emptyCounts());
  const [errs, setErrs] = useState<Record<string, string | undefined>>({});

  function submit(publish: boolean) {
    const input = { ...f, found, remediated: rem };
    const e = validatePentestInput(input, Date.now());
    setErrs(e);
    if (Object.keys(e).length) return;
    void run('pt', () => staffCreatePentest(input, publish), publish ? 'Published' : 'Saved as draft', () => { setF({ title: '', tester: '', performed_on: '', scope: '', methodology: '', summary: '' }); setFound(emptyCounts()); setRem(emptyCounts()); void loader.reload(); });
  }
  const text = (k: keyof typeof f, label: string, area = false) => (
    <Field label={label} error={errs[k]}>
      {area ? <textarea className={inputClass} rows={2} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        : <input className={inputClass} type={k === 'performed_on' ? 'date' : 'text'} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}
    </Field>
  );
  const counts = (label: string, v: SeverityCounts, set: (c: SeverityCounts) => void) => (
    <fieldset><legend className="mb-1 text-sm font-medium text-text-primary">{label}</legend>
      <div className="grid grid-cols-5 gap-2">{SEVERITIES.map((s) => (
        <label key={s} className="text-xs text-text-secondary">{s}<input className={inputClass} type="number" min={0} value={v[s]} onChange={(e) => set({ ...v, [s]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></label>
      ))}</div></fieldset>
  );
  return (
    <Section title="Pentest summaries" loader={loader}>
      {(rows) => (
        <div className="space-y-4">
          <ul className="divide-y divide-border text-sm">
            {rows.length === 0 && <li className="py-2 text-text-secondary">None yet.</li>}
            {rows.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                <span className="text-text-primary">{p.title} <span className="text-xs text-text-secondary">· {fmtDate(p.performed_on)}</span></span>
                {p.published_at ? <Badge tone="ok">Published</Badge> : <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => run(`p${p.id}`, () => staffPublishPentest(p.id), 'Published', () => void loader.reload())}>Publish</Button>}
              </li>
            ))}
          </ul>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e: FormEvent) => e.preventDefault()} noValidate>
            {text('title', 'Title')}{text('tester', 'Tester / firm')}{text('performed_on', 'Performed on')}
            <div />{text('scope', 'Scope', true)}{text('methodology', 'Methodology', true)}
            <div className="sm:col-span-2">{text('summary', 'Public summary', true)}</div>
            {counts('Findings', found, setFound)}{counts('Remediated', rem, setRem)}
            {errs.remediated && <p role="alert" className="text-xs text-red-500 sm:col-span-2">{errs.remediated}</p>}
            <div className="flex gap-2 sm:col-span-2">
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => submit(false)}>Save draft</Button>
              <Button size="sm" disabled={busy !== null} onClick={() => submit(true)}>{busy === 'pt' ? <Spinner /> : null} Publish</Button>
            </div>
          </form>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- notices
function NoticeSection() {
  const loader = useLoader(fetchNotices);
  const { busy, run } = useAction();
  const blank = { processor_name: '', change_type: 'add', replaces_name: '', purpose: '', location: '', data_types: '', summary: '', effective_at: '', emergency: false };
  const [f, setF] = useState(blank);
  const [errs, setErrs] = useState<Record<string, string | undefined>>({});
  const set = <K extends keyof typeof blank>(k: K, v: (typeof blank)[K]) => setF({ ...f, [k]: v });
  const txt = (k: 'processor_name' | 'replaces_name' | 'purpose' | 'location' | 'data_types' | 'summary', label: string) => (
    <Field label={label} error={errs[k]}><input className={inputClass} value={f[k]} onChange={(e) => set(k, e.target.value)} /></Field>
  );

  function submit() {
    const input = { ...f, effective_at: f.effective_at ? isoLocal(f.effective_at) : '' };
    const e = validateNoticeInput(input, Date.now());
    setErrs(e);
    if (Object.keys(e).length) return;
    void run('nt', async () => { const id = await staffCreateNotice(input); await staffDispatchNotice(id).catch(() => undefined); return 'Notice posted — emails are being sent'; }, 'Posted', () => { setF(blank); void loader.reload(); });
  }

  return (
    <Section title="Sub-processor notices" loader={loader}>
      {(rows) => (
        <div className="space-y-4">
          <ul className="divide-y divide-border text-sm">
            {rows.length === 0 && <li className="py-2 text-text-secondary">None yet.</li>}
            {rows.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-text-primary">{n.processor_name} <span className="text-xs text-text-secondary">· effective {fmtDate(n.effective_at)}</span></span>
                <span className="flex gap-2">
                  {n.withdrawn_at ? <Badge>Withdrawn</Badge> : (
                    <>
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run(`d${n.id}`, async () => { const r = await staffDispatchNotice(n.id); return `Sent ${r.sent}, failed ${r.failed}, already sent ${r.skipped}`; }, 'Done')}>Re-send</Button>
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run(`w${n.id}`, () => staffWithdrawNotice(n.id), 'Withdrawn', () => void loader.reload())}>Withdraw</Button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-secondary">Remember to update <code>src/lib/subprocessors.ts</code> and its date when the change goes live.</p>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} noValidate>
            {txt('processor_name', 'Processor')}
            <Field label="Change type" error={errs.change_type}>
              <select className={inputClass} value={f.change_type} onChange={(e) => set('change_type', e.target.value)}>{NOTICE_CHANGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
            </Field>
            {f.change_type === 'replace' && txt('replaces_name', 'Replaces')}
            {txt('purpose', 'Purpose')}{txt('location', 'Location')}{txt('data_types', 'Data types')}
            <div className="sm:col-span-2">{txt('summary', 'Summary for customers')}</div>
            <Field label="Effective on" error={errs.effective_at}><input className={inputClass} type="datetime-local" value={f.effective_at} onChange={(e) => set('effective_at', e.target.value)} /></Field>
            <label className="flex items-center gap-2 pt-6 text-sm text-text-primary"><input type="checkbox" checked={f.emergency} onChange={(e) => set('emergency', e.target.checked)} /> Emergency change (skips the 30-day window)</label>
            <div className="sm:col-span-2"><Button size="sm" disabled={busy !== null} onClick={submit}>{busy === 'nt' ? <Spinner /> : null} Post and notify</Button></div>
          </form>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- incidents + SLA policy
function SlaSection() {
  const loader = useLoader(staffListIncidents);
  const { busy, run } = useAction();
  const [inc, setInc] = useState({ title: '', kind: 'outage' as IncidentKind, scope: 'all', started_at: '', announced_at: '' });
  const [pol, setPol] = useState({ userId: '', fee: '', auto: true });

  const addIncident = () => {
    if (inc.title.trim().length < 3 || !inc.started_at) return;
    void run('inc', () => staffSaveIncident({
      title: inc.title.trim(), kind: inc.kind, scope: inc.scope as 'all' | RegionCode, started_at: isoLocal(inc.started_at),
      announced_at: inc.announced_at ? isoLocal(inc.announced_at) : null, confirmed: false, tenant_id: null, ended_at: null,
    }), 'Incident saved (unconfirmed)', () => { setInc({ ...inc, title: '' }); void loader.reload(); });
  };
  const savePolicy = () => {
    const cents = pol.fee ? Math.round(Number(pol.fee) * 100) : null;
    if (!/^[0-9a-f-]{36}$/i.test(pol.userId.trim()) || (cents !== null && !(cents > 0))) return;
    void run('pol', () => staffUpsertSlaPolicy(pol.userId.trim(), { monthly_fee_cents: cents, auto_credit: pol.auto }), 'SLA policy saved');
  };

  return (
    <Section title="SLA incidents & policies" loader={loader}>
      {(rows) => (
        <div className="space-y-5">
          <ul className="divide-y divide-border text-sm">
            {rows.length === 0 && <li className="py-2 text-text-secondary">No incidents.</li>}
            {rows.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-text-primary">{i.title} <span className="text-xs text-text-secondary">· {i.kind} · {i.scope} · {fmtDate(i.started_at)}{i.ended_at ? '' : ' · ongoing'}</span></span>
                <span className="flex gap-2">
                  {!i.ended_at && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run(`e${i.id}`, () => staffUpdateIncident(i.id, { ended_at: new Date().toISOString() }), 'Marked resolved', () => void loader.reload())}>Resolve now</Button>}
                  {i.confirmed ? <Badge tone="ok">Confirmed</Badge> : <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => run(`c${i.id}`, () => staffUpdateIncident(i.id, { confirmed: true }), 'Confirmed — counts toward SLA', () => void loader.reload())}>Confirm</Button>}
                </span>
              </li>
            ))}
          </ul>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Title"><input className={inputClass} value={inc.title} onChange={(e) => setInc({ ...inc, title: e.target.value })} /></Field>
            <Field label="Kind"><select className={inputClass} value={inc.kind} onChange={(e) => setInc({ ...inc, kind: e.target.value as IncidentKind })}>{INCIDENT_KINDS.map((k) => <option key={k}>{k}</option>)}</select></Field>
            <Field label="Scope"><select className={inputClass} value={inc.scope} onChange={(e) => setInc({ ...inc, scope: e.target.value })}><option value="all">all</option>{REGION_CODES.map((r) => <option key={r}>{r}</option>)}</select></Field>
            <Field label="Started"><input className={inputClass} type="datetime-local" value={inc.started_at} onChange={(e) => setInc({ ...inc, started_at: e.target.value })} /></Field>
            {inc.kind === 'maintenance' && <Field label="Customers notified at"><input className={inputClass} type="datetime-local" value={inc.announced_at} onChange={(e) => setInc({ ...inc, announced_at: e.target.value })} /></Field>}
            <div className="flex items-end"><Button size="sm" disabled={busy !== null} onClick={addIncident}>{busy === 'inc' ? <Spinner /> : null} Add incident</Button></div>
          </div>
          <p className="text-xs text-text-secondary">Only confirmed incidents count. Run <code>sla-credit-run</code> to settle a month (it also runs on its schedule).</p>
          <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-3">
            <Field label="Account owner id (contracted SLA)"><input className={inputClass} value={pol.userId} onChange={(e) => setPol({ ...pol, userId: e.target.value })} placeholder="uuid" /></Field>
            <Field label="Monthly fee (major units)"><input className={inputClass} type="number" min="0" step="0.01" value={pol.fee} onChange={(e) => setPol({ ...pol, fee: e.target.value })} /></Field>
            <label className="flex items-center gap-2 pt-6 text-sm text-text-primary"><input type="checkbox" checked={pol.auto} onChange={(e) => setPol({ ...pol, auto: e.target.checked })} /> Auto-apply credits</label>
            <div className="sm:col-span-3"><Button size="sm" variant="secondary" disabled={busy !== null} onClick={savePolicy}>Save SLA policy</Button></div>
          </div>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- residency ops
function ResidencySection() {
  const loader = useLoader(async () => {
    const [regions, requests, dedicated] = await Promise.all([fetchRegions(), staffListChangeRequests(), staffListDedicated()]);
    return { regions, requests, dedicated };
  });
  const { busy, run } = useAction();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [ded, setDed] = useState<Record<string, { endpoint: string; ref: string }>>({});

  return (
    <Section title="Regions, region changes & dedicated tenants" loader={loader}>
      {(d) => (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-3">
            {d.regions.map((r) => (
              <label key={r.code} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm text-text-primary">
                <input type="checkbox" checked={r.is_available} disabled={busy !== null} onChange={(e) => run(`r${r.code}`, () => staffSetRegionAvailability(r.code, e.target.checked), 'Updated', () => void loader.reload())} />
                {REGIONS[r.code].label} available
              </label>
            ))}
          </div>
          <p className="text-xs text-text-secondary">Only enable a region after its Supabase project exists, runs the migration, <code>init_data_plane('{'{region}'}')</code> was executed, and the REGION_&lt;CODE&gt;_* secrets are set.</p>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-text-primary">Region change requests</h3>
            {d.requests.length === 0 ? <p className="text-sm text-text-secondary">Nothing pending.</p> : (
              <ul className="space-y-3">
                {d.requests.map((r) => (
                  <li key={r.id} className="rounded-xl border border-border p-3 text-sm">
                    <p className="text-text-primary">{regionLabel(r.from_region)} → {regionLabel(r.to_region)} <Badge tone={r.status === 'approved' ? 'ok' : 'warn'}>{r.status}</Badge></p>
                    <p className="text-xs text-text-secondary">Account {r.user_id} · {r.reason}</p>
                    {r.status === 'pending' ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <input className={`${inputClass} sm:max-w-xs`} placeholder="Note to customer" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
                        <Button size="sm" disabled={busy !== null} onClick={() => run(`a${r.id}`, () => staffDecideChange(r.id, true, notes[r.id] ?? ''), 'Approved', () => void loader.reload())}>Approve</Button>
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run(`n${r.id}`, () => staffDecideChange(r.id, false, notes[r.id] ?? ''), 'Rejected', () => void loader.reload())}>Reject</Button>
                      </div>
                    ) : (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => run(`m${r.id}`, async () => { const m = await staffMigrate(r.user_id); return `Moved ${m.moved}, ${m.remaining} remaining${m.failed ? `, ${m.failed} failed` : ''}`; }, 'Done')}>Move data (batch)</Button>
                        <Button size="sm" disabled={busy !== null} onClick={() => run(`f${r.id}`, () => staffCompleteChange(r.id), 'Region changed', () => void loader.reload())}>Complete (old region is clean)</Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-text-primary">Dedicated tenant requests</h3>
            {d.dedicated.length === 0 ? <p className="text-sm text-text-secondary">Nothing pending.</p> : (
              <ul className="space-y-3">
                {d.dedicated.map((t) => {
                  const v = ded[t.user_id] ?? { endpoint: '', ref: '' };
                  return (
                    <li key={t.user_id} className="rounded-xl border border-border p-3 text-sm">
                      <p className="text-text-primary">{t.user_id} · {regionLabel(t.region)} <Badge tone="warn">{t.status}</Badge></p>
                      {t.request_note && <p className="text-xs text-text-secondary">{t.request_note}</p>}
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <input className={inputClass} placeholder="https://<project>.supabase.co" value={v.endpoint} onChange={(e) => setDed({ ...ded, [t.user_id]: { ...v, endpoint: e.target.value } })} />
                        <input className={inputClass} placeholder="SECRET_REF (env DEDICATED_KEY_<REF>)" value={v.ref} onChange={(e) => setDed({ ...ded, [t.user_id]: { ...v, ref: e.target.value.toUpperCase() } })} />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => run(`p${t.user_id}`, () => staffUpdateDedicated(t.user_id, { status: 'provisioning' }), 'Marked provisioning', () => void loader.reload())}>Provisioning</Button>
                        <Button size="sm" disabled={busy !== null || !v.endpoint || !v.ref} onClick={() => run(`x${t.user_id}`, () => staffUpdateDedicated(t.user_id, { status: 'active', endpoint_url: v.endpoint.trim(), secret_ref: v.ref.trim() }), 'Activated — now run Move data', () => void loader.reload())}>Activate</Button>
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run(`d${t.user_id}`, () => staffUpdateDedicated(t.user_id, { status: 'declined' }), 'Declined', () => void loader.reload())}>Decline</Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

export function StaffTrustAdminPage() {
  return (
    <main className="min-h-screen bg-bg-primary p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold text-text-primary">Trust admin</h1>
          <Link to="/trust/security" className="focus-ring rounded-lg text-sm font-medium text-accent hover:underline">View public portal</Link>
        </header>
        <PentestSection />
        <NoticeSection />
        <SlaSection />
        <ResidencySection />
      </div>
    </main>
  );
}
