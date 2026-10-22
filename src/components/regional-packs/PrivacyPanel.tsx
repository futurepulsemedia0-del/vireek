import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, ShieldCheck, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import {
  downloadText, exportCustomerData, fetchCustomerConsents, fetchErasurePreview, recordRegionalConsent, searchCustomers,
  type CustomerConsent, type CustomerHit, type ErasurePreview,
} from '@/lib/regionalPacksApi';
import { countriesInPack, getCountry } from '@/lib/regionalPacks/packData';
import {
  REGIMES, computeRequestDeadline, daysUntil, evaluateMarketingConsent, marketingRegimeFor, planErasure, regimesFor,
  serializePortability, type RegimeId,
} from '@/lib/regionalPacks/packPrivacy';
import type { PackCode } from '@/lib/regionalPacks/packTypes';

const inputCls = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent';
const labelCls = 'mb-1 block text-xs font-medium text-text-secondary';
const today = () => new Date().toISOString().slice(0, 10);

export function PrivacyPanel({ enabledPacks, canManage }: { enabledPacks: PackCode[]; canManage: boolean }) {
  const countries = useMemo(() => enabledPacks.flatMap((p) => countriesInPack(p)), [enabledPacks]);
  const [country, setCountry] = useState(countries[0]?.code ?? 'US');
  const [sub, setSub] = useState('');
  if (enabledPacks.length === 0) return <EmptyState icon={ShieldCheck} title="Enable a regional pack first" description="Privacy tooling follows the laws of the countries in your enabled packs." />;
  const profile = getCountry(country);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5" aria-labelledby="pv-h">
        <h2 id="pv-h" className="text-base font-semibold text-text-primary">Customer location</h2>
        <p className="mb-3 text-sm text-text-secondary">The customer’s country decides which privacy and marketing laws apply.</p>
        <div className="grid max-w-xl gap-3 sm:grid-cols-2">
          <div><label className={labelCls} htmlFor="pv-c">Country</label>
            <select id="pv-c" className={inputCls} value={country} onChange={(e) => { setCountry(e.target.value); setSub(''); }}>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div>
          {profile?.subdivisions && (
            <div><label className={labelCls} htmlFor="pv-s">{country === 'CA' ? 'Province' : country === 'AU' ? 'State' : 'State / nation'}</label>
              <select id="pv-s" className={inputCls} value={sub} onChange={(e) => setSub(e.target.value)}><option value="">Not set</option>{Object.entries(profile.subdivisions).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></div>
          )}
        </div>
        <RegimeList country={country} sub={sub} />
      </section>
      <DeadlineCard country={country} sub={sub} />
      <CustomerTools country={country} sub={sub} canManage={canManage} />
    </div>
  );
}

function RegimeList({ country, sub }: { country: string; sub: string }) {
  const ids = regimesFor(country, sub || null);
  if (ids.length === 0) return null;
  return (
    <ul className="mt-4 space-y-2">
      {ids.map((id) => (
        <li key={id} className="rounded-xl border border-border bg-bg-primary p-3">
          <p className="text-sm font-medium text-text-primary">{REGIMES[id].name}</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-text-secondary">{REGIMES[id].notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </li>
      ))}
    </ul>
  );
}

function DeadlineCard({ country, sub }: { country: string; sub: string }) {
  const ids = regimesFor(country, sub || null).filter((r) => REGIMES[r].responseDays != null || REGIMES[r].responseMonths != null);
  const [regime, setRegime] = useState<RegimeId | ''>('');
  const [received, setReceived] = useState(today());
  const [extended, setExtended] = useState(false);
  const active = (regime && ids.includes(regime) ? regime : ids[0]) as RegimeId | undefined;

  const out = useMemo(() => {
    if (!active) return null;
    try { return computeRequestDeadline({ regime: active, receivedOn: received, country, subdivision: sub || null, extended }); }
    catch { return null; }
  }, [active, received, country, sub, extended]);
  const left = out ? daysUntil(out.dueOn, today()) : null;

  return (
    <section aria-labelledby="dl-h" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <h2 id="dl-h" className="text-base font-semibold text-text-primary">Data-request deadline</h2>
      {!active ? <p className="mt-2 text-sm text-text-secondary">No statutory data-request deadline is recorded for this location.</p> : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div><label className={labelCls} htmlFor="dl-r">Law</label>
              <select id="dl-r" className={inputCls} value={active} onChange={(e) => setRegime(e.target.value as RegimeId)}>{ids.map((r) => <option key={r} value={r}>{REGIMES[r].name}</option>)}</select></div>
            <div><label className={labelCls} htmlFor="dl-d">Verified request received</label><input id="dl-d" type="date" className={inputCls} value={received} max={today()} onChange={(e) => setReceived(e.target.value)} /></div>
            {REGIMES[active].extensionDays > 0 && <label className="flex items-center gap-2 self-end text-sm text-text-primary"><input type="checkbox" checked={extended} onChange={(e) => setExtended(e.target.checked)} /> Complex request (extended)</label>}
          </div>
          {out && (
            <p className="mt-4 text-sm text-text-primary" aria-live="polite">
              Respond by <strong>{out.dueOn}</strong> <span className="text-text-secondary">({out.basis}{out.extended ? ', extended' : ''})</span>
              {left !== null && <span className={left < 0 ? 'ml-2 font-medium text-danger' : left <= 5 ? 'ml-2 font-medium text-warning-500' : 'ml-2 text-text-secondary'}>{left < 0 ? `${-left} days overdue` : left === 0 ? 'due today' : `${left} days left`}</span>}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function CustomerTools({ country, sub, canManage }: { country: string; sub: string; canManage: boolean }) {
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [picked, setPicked] = useState<CustomerHit | null>(null);
  const [consents, setConsents] = useState<CustomerConsent[] | null>(null);
  const [preview, setPreview] = useState<ErasurePreview | null>(null);
  const [purchase, setPurchase] = useState('');
  const [inquiry, setInquiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (picked || q.trim().length < 2) { setHits([]); return; }
    let live = true;
    const t = setTimeout(() => { searchCustomers(q).then((h) => live && setHits(h)).catch(() => live && setHits([])); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, picked]);

  useEffect(() => {
    if (!picked) { setConsents(null); setPreview(null); return; }
    let live = true;
    setErr(null);
    Promise.all([fetchCustomerConsents(picked.id), fetchErasurePreview(picked.id)])
      .then(([c, p]) => { if (live) { setConsents(c); setPreview(p); } })
      .catch((e) => live && setErr(e instanceof Error ? e.message : 'Could not load this customer.'));
    return () => { live = false; };
  }, [picked]);

  const regime = marketingRegimeFor(country);
  const decisions = useMemo(() => {
    if (!regime || !consents) return null;
    const base = { regime, records: consents, lastPurchaseAt: purchase || preview?.last_invoice_on || null, lastInquiryAt: inquiry || null };
    return { email: evaluateMarketingConsent({ ...base, channel: 'email' }), sms: evaluateMarketingConsent({ ...base, channel: 'sms' }) };
  }, [regime, consents, purchase, inquiry, preview]);

  const plan = useMemo(() => (preview ? planErasure({
    country, subdivision: sub || null, hasInvoices: preview.invoiced_jobs > 0, lastInvoiceOn: preview.last_invoice_on,
  }) : null), [preview, country, sub]);

  const exportNow = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const pkg = await exportCustomerData(picked.id);
      const { json } = serializePortability(pkg);
      downloadText(`personal-data-${picked.id.slice(0, 8)}.json`, json, 'application/json');
      toast('Export downloaded. Send it to the requester securely.', 'success');
    } catch (e) { toast(e instanceof Error ? e.message : 'Export failed.', 'error'); }
    finally { setBusy(false); }
  };

  const record = async (channel: 'email' | 'sms', granted: boolean) => {
    if (!picked || !regime) return;
    setBusy(true);
    try {
      await recordRegionalConsent({ customerId: picked.id, channel, granted, regime, basis: granted ? 'express' : 'withdrawn' });
      setConsents(await fetchCustomerConsents(picked.id));
      toast(granted ? 'Consent recorded.' : 'Withdrawal recorded.', 'success');
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not record.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <section aria-labelledby="ct-h" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <h2 id="ct-h" className="text-base font-semibold text-text-primary">Customer privacy tools</h2>
      <div className="mt-3 max-w-md">
        <label className={labelCls} htmlFor="ct-q">Find a customer</label>
        <input id="ct-q" className={inputCls} value={picked ? picked.name : q} placeholder="Name or email" onChange={(e) => { setPicked(null); setQ(e.target.value); }} autoComplete="off" />
        {!picked && hits.length > 0 && (
          <ul className="mt-1 overflow-hidden rounded-xl border border-border bg-bg-primary" role="listbox" aria-label="Matching customers">
            {hits.map((h) => (<li key={h.id}><button role="option" aria-selected={false} className="block w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary" onClick={() => setPicked(h)}>{h.name}{h.email ? <span className="text-text-secondary"> · {h.email}</span> : null}</button></li>))}
          </ul>
        )}
      </div>
      {err && <p role="alert" className="mt-3 flex items-center gap-2 text-sm text-danger"><AlertTriangle size={16} aria-hidden="true" /> {err}</p>}
      {picked && !consents && !err && <p className="mt-4 text-sm text-text-secondary">Loading…</p>}

      {picked && consents && decisions && (
        <div className="mt-5 space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Can we send marketing? <span className="font-normal text-text-secondary">({regime ? REGIMES[regime].name : ''})</span></h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {(['email', 'sms'] as const).map((ch) => {
                const d = decisions[ch];
                return (
                  <div key={ch} className="rounded-xl border border-border bg-bg-primary p-3">
                    <p className={`flex items-center gap-2 text-sm font-medium ${d.allowed ? 'text-success' : 'text-danger'}`}>{d.allowed ? <CheckCircle2 size={16} aria-hidden="true" /> : <XCircle size={16} aria-hidden="true" />}{ch === 'email' ? 'Email' : 'Text'}: {d.allowed ? 'allowed' : 'not allowed'}</p>
                    <p className="mt-1 text-xs text-text-secondary">{d.reason}{d.expiresAt ? ` Valid until ${d.expiresAt.slice(0, 10)}.` : ''}</p>
                    {canManage && <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void record(ch, true)}>Record opt-in</Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void record(ch, false)}>Record withdrawal</Button>
                    </div>}
                  </div>
                );
              })}
            </div>
            <div className="mt-3 grid max-w-md gap-3 sm:grid-cols-2">
              <div><label className={labelCls} htmlFor="ct-p">Last purchase (override)</label><input id="ct-p" type="date" className={inputCls} value={purchase} onChange={(e) => setPurchase(e.target.value)} /></div>
              <div><label className={labelCls} htmlFor="ct-i">Last inquiry</label><input id="ct-i" type="date" className={inputCls} value={inquiry} onChange={(e) => setInquiry(e.target.value)} /></div>
            </div>
            {decisions.email.requirements.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-text-secondary">{decisions.email.requirements.map((r) => <li key={r}>{r}</li>)}</ul>}
          </div>

          {plan && preview && (
            <div>
              <h3 className="text-sm font-semibold text-text-primary">If they ask us to erase their data</h3>
              <p className="text-xs text-text-secondary">{Object.entries(preview.counts).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(' · ')} · {preview.invoiced_jobs} invoiced job(s)</p>
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border bg-bg-primary">
                {plan.items.map((i) => (
                  <li key={i.category} className="flex flex-wrap items-start justify-between gap-2 p-3 text-sm">
                    <span className="text-text-primary">{i.category}<span className="block text-xs text-text-secondary">{i.reason}{i.until ? ` Keep until ${i.until}.` : ''}</span></span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs uppercase tracking-wide text-text-secondary">{i.action}</span>
                  </li>
                ))}
              </ul>
              {plan.notes.map((n) => <p key={n} className="mt-2 text-xs text-text-secondary">{n}</p>)}
              <p className="mt-2 text-xs text-text-secondary">To carry it out, create a “customer record” request in Data Governance — it adds the grace period, legal-hold check and audit trail.</p>
            </div>
          )}

          {canManage && (
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Data portability</h3>
              <p className="mb-2 text-xs text-text-secondary">Downloads this customer’s records (profile, jobs, calls, leads, quotes, consents, preferences) as machine-readable JSON. Internal and secret fields are removed. Each export is logged.</p>
              <Button size="sm" variant="secondary" onClick={() => void exportNow()} disabled={busy}><Download size={16} aria-hidden="true" /> {busy ? 'Working…' : 'Download personal data'}</Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
