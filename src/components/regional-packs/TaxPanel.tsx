import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Pencil, Plus, ReceiptText, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  deleteTaxRegistration, fetchTaxRegistrations, saveTaxRegistration, type TaxRegistrationRow,
} from '@/lib/regionalPacksApi';
import { countriesInPack, getCountry } from '@/lib/regionalPacks/packData';
import { formatMinor, toMinor } from '@/lib/regionalPacks/packMoney';
import { computeTax } from '@/lib/regionalPacks/packTax';
import { validateTaxId } from '@/lib/regionalPacks/packValidation';
import type { PackCode, RateCategory, TaxScheme } from '@/lib/regionalPacks/packTypes';

const SCHEME_LABEL: Record<TaxScheme, string> = {
  VAT: 'VAT', GST_HST: 'GST/HST', QST: 'QST (Quebec)', PST_BC: 'PST (BC)', PST_SK: 'PST (SK)', RST_MB: 'RST (MB)', AU_GST: 'GST (ABN)', US_SALES_TAX: 'US sales-tax permit',
};

function schemesFor(country: string): TaxScheme[] {
  switch (getCountry(country)?.pack) {
    case 'EU': case 'GB': return ['VAT'];
    case 'CA': return ['GST_HST', 'QST', 'PST_BC', 'PST_SK', 'RST_MB'];
    case 'AU': return ['AU_GST'];
    case 'US': return ['US_SALES_TAX'];
    default: return [];
  }
}

const inputCls = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent';
const labelCls = 'mb-1 block text-xs font-medium text-text-secondary';

interface Props { enabledPacks: PackCode[]; canManage: boolean }

export function TaxPanel({ enabledPacks, canManage }: Props) {
  const { toast } = useToast();
  const countries = useMemo(() => enabledPacks.flatMap((p) => countriesInPack(p)), [enabledPacks]);
  const [rows, setRows] = useState<TaxRegistrationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<TaxRegistrationRow> | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRows(await fetchTaxRegistrations()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load registrations.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const check = editing?.country && editing.number ? validateTaxId(editing.country, editing.number, editing.scheme) : null;

  const submit = async () => {
    if (!editing?.country || !editing.scheme || !editing.number) return;
    if (check && !check.valid) { toast(check.reason ?? 'That number looks wrong.', 'error'); return; }
    setBusy(true);
    try {
      await saveTaxRegistration({
        id: editing.id, scheme: editing.scheme, country: editing.country, subdivision: editing.subdivision,
        number: check?.normalized ?? editing.number, legalName: editing.legalName, validFrom: editing.validFrom, validTo: editing.validTo, status: editing.status ?? 'active',
      });
      toast('Registration saved.', 'success');
      setEditing(null);
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save.', 'error'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    const id = confirmId;
    setConfirmId(null);
    if (!id) return;
    try { await deleteTaxRegistration(id); toast('Registration removed.', 'success'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not delete.', 'error'); }
  };

  if (enabledPacks.length === 0) {
    return <EmptyState icon={ReceiptText} title="Enable a regional pack first" description="Tax registrations and the tax calculator appear once at least one pack is on." />;
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="regs-h" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="regs-h" className="text-base font-semibold text-text-primary">Your tax registrations</h2>
            <p className="text-sm text-text-secondary">Tax is only charged for schemes you are registered under. No registration means no tax is added.</p>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setEditing({ country: countries[0]?.code, scheme: schemesFor(countries[0]?.code ?? '')[0], status: 'active' })}>
              <Plus size={16} aria-hidden="true" /> Add registration
            </Button>
          )}
        </div>

        {error && <p role="alert" className="mb-3 flex items-center gap-2 text-sm text-danger"><AlertTriangle size={16} aria-hidden="true" /> {error} <button className="underline" onClick={() => void load()}>Retry</button></p>}
        {!rows && !error && <SkeletonCardList count={2} />}
        {rows && rows.length === 0 && <p className="rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">No registrations yet. Under the registration threshold? Leave this empty and no tax is added.</p>}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{SCHEME_LABEL[r.scheme]} · {r.country}{r.subdivision ? `-${r.subdivision}` : ''}</p>
                  <p className="truncate text-xs text-text-secondary">{r.number}{r.legalName ? ` · ${r.legalName}` : ''} · {r.status}</p>
                </div>
                {canManage && (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" aria-label={`Edit ${SCHEME_LABEL[r.scheme]} registration`} onClick={() => setEditing(r)}><Pencil size={16} aria-hidden="true" /></Button>
                    <Button variant="ghost" size="sm" aria-label={`Delete ${SCHEME_LABEL[r.scheme]} registration`} onClick={() => setConfirmId(r.id)}><Trash2 size={16} aria-hidden="true" /></Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {editing && (
          <div role="group" aria-label="Registration form" className="mt-4 grid gap-3 rounded-xl border border-border bg-bg-primary p-4 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="rg-country">Country</label>
              <select id="rg-country" className={inputCls} value={editing.country ?? ''} disabled={!!editing.id}
                onChange={(e) => setEditing({ ...editing, country: e.target.value, scheme: schemesFor(e.target.value)[0] })}>
                {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="rg-scheme">Scheme</label>
              <select id="rg-scheme" className={inputCls} value={editing.scheme ?? ''} onChange={(e) => setEditing({ ...editing, scheme: e.target.value as TaxScheme })}>
                {schemesFor(editing.country ?? '').map((s) => <option key={s} value={s}>{SCHEME_LABEL[s]}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="rg-number">Registration number</label>
              <input id="rg-number" className={inputCls} value={editing.number ?? ''} maxLength={40} onChange={(e) => setEditing({ ...editing, number: e.target.value })} aria-describedby="rg-help" />
              <p id="rg-help" className={`mt-1 flex items-start gap-1 text-xs ${check && !check.valid ? 'text-danger' : 'text-text-secondary'}`}>
                {check?.valid ? <CheckCircle2 size={14} className="mt-0.5 text-success" aria-hidden="true" /> : null}
                {check ? (check.valid ? (check.warnings[0] ?? 'Format looks right.') : check.reason) : 'We check the format and, where one exists, the checksum.'}
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor="rg-from">Registered from (optional)</label>
              <input id="rg-from" type="date" className={inputCls} value={editing.validFrom ?? ''} onChange={(e) => setEditing({ ...editing, validFrom: e.target.value || null })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="rg-status">Status</label>
              <select id="rg-status" className={inputCls} value={editing.status ?? 'active'} onChange={(e) => setEditing({ ...editing, status: e.target.value as TaxRegistrationRow['status'] })}>
                <option value="active">Active</option><option value="pending">Applied, not issued yet</option><option value="deregistered">Deregistered</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button size="sm" onClick={() => void submit()} disabled={busy || !editing.number}>{busy ? 'Saving…' : 'Save'}</Button>
              <Button size="sm" variant="secondary" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
            </div>
          </div>
        )}
      </section>

      <TaxPreview enabledPacks={enabledPacks} registrations={rows ?? []} />
      <ConfirmDialog
        open={!!confirmId} title="Delete this registration?" description="Tax for this scheme will stop being added to new invoices."
        confirmLabel="Delete" onConfirm={() => void remove()} onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}

function TaxPreview({ enabledPacks, registrations }: { enabledPacks: PackCode[]; registrations: TaxRegistrationRow[] }) {
  const countries = useMemo(() => enabledPacks.flatMap((p) => countriesInPack(p)), [enabledPacks]);
  const [site, setSite] = useState(countries[0]?.code ?? 'US');
  const [sub, setSub] = useState('');
  const [seller, setSeller] = useState(countries[0]?.code ?? 'US');
  const [amount, setAmount] = useState('100.00');
  const [category, setCategory] = useState<RateCategory>('standard');
  const [reduced, setReduced] = useState(0);
  const [business, setBusiness] = useState(false);
  const [taxId, setTaxId] = useState('');
  const [assume, setAssume] = useState(true);

  const profile = getCountry(site);
  const currency = profile?.currency ?? 'USD';
  const net = Number.parseFloat(amount);
  const valid = Number.isFinite(net) && net >= 0 && net < 10_000_000;

  const result = useMemo(() => {
    if (!valid || !profile) return null;
    try {
      return computeTax({
        currency, sellerCountry: seller, siteCountry: site, siteSubdivision: sub || null, customerIsBusiness: business,
        customerTaxId: taxId || null, assumeRegistered: assume, registrations,
      }, [{ id: 'job', netMinor: toMinor(net, currency), category, reducedIndex: reduced }]);
    } catch (e) { return e instanceof Error ? e.message : 'Could not calculate.'; }
  }, [valid, profile, currency, seller, site, sub, business, taxId, assume, registrations, net, category, reduced]);

  return (
    <section aria-labelledby="calc-h" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <h2 id="calc-h" className="text-base font-semibold text-text-primary">Tax calculator</h2>
      <p className="mb-4 text-sm text-text-secondary">Try a job before you invoice it. Work on a property is taxed where the property is.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div><label className={labelCls} htmlFor="tp-site">Job site country</label>
          <select id="tp-site" className={inputCls} value={site} onChange={(e) => { setSite(e.target.value); setSub(''); setReduced(0); }}>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div>
        {profile?.subdivisions && (
          <div><label className={labelCls} htmlFor="tp-sub">{site === 'CA' ? 'Province' : site === 'AU' ? 'State' : site === 'GB' ? 'Nation' : 'State'}</label>
            <select id="tp-sub" className={inputCls} value={sub} onChange={(e) => setSub(e.target.value)}><option value="">Select…</option>{Object.entries(profile.subdivisions).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></div>
        )}
        <div><label className={labelCls} htmlFor="tp-seller">Your business is in</label>
          <select id="tp-seller" className={inputCls} value={seller} onChange={(e) => setSeller(e.target.value)}>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div>
        <div><label className={labelCls} htmlFor="tp-amt">Net amount ({currency})</label>
          <input id="tp-amt" inputMode="decimal" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!valid} /></div>
        <div><label className={labelCls} htmlFor="tp-cat">Rate</label>
          <select id="tp-cat" className={inputCls} value={category} onChange={(e) => setCategory(e.target.value as RateCategory)}>
            <option value="standard">Standard</option>{(profile?.vat?.reduced.length ?? 0) > 0 && <option value="reduced">Reduced</option>}<option value="zero">Zero-rated</option><option value="exempt">Exempt</option></select></div>
        {category === 'reduced' && profile?.vat && (
          <div><label className={labelCls} htmlFor="tp-red">Reduced rate</label>
            <select id="tp-red" className={inputCls} value={reduced} onChange={(e) => setReduced(Number(e.target.value))}>{profile.vat.reduced.map((r, i) => <option key={r} value={i}>{r}%</option>)}</select></div>
        )}
        <label className="flex items-center gap-2 self-end text-sm text-text-primary"><input type="checkbox" checked={business} onChange={(e) => setBusiness(e.target.checked)} /> Business customer</label>
        {business && <div><label className={labelCls} htmlFor="tp-tid">Customer tax ID</label><input id="tp-tid" className={inputCls} value={taxId} onChange={(e) => setTaxId(e.target.value)} /></div>}
        <label className="flex items-center gap-2 self-end text-sm text-text-primary"><input type="checkbox" checked={assume} onChange={(e) => setAssume(e.target.checked)} /> Assume I am registered</label>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-bg-primary p-4" aria-live="polite">
        {!valid && <p className="text-sm text-danger">Enter a valid amount.</p>}
        {typeof result === 'string' && <p className="text-sm text-danger">{result}</p>}
        {result && typeof result !== 'string' && (
          <div className="space-y-2 text-sm">
            <dl className="grid grid-cols-2 gap-1">
              <dt className="text-text-secondary">Net</dt><dd className="text-right text-text-primary">{formatMinor(result.netMinor, currency, profile?.locale)}</dd>
              {result.breakdown.map((b) => (<div key={`${b.code}${b.ratePct}`} className="col-span-2 flex justify-between"><dt className="text-text-secondary">{b.label} {b.ratePct}%</dt><dd className="text-text-primary">{formatMinor(b.taxMinor, currency, profile?.locale)}</dd></div>))}
              {result.reverseCharge && <dt className="col-span-2 font-medium text-success">Reverse charge — customer accounts for the tax</dt>}
              <dt className="font-semibold text-text-primary">Total</dt><dd className="text-right font-semibold text-text-primary">{formatMinor(result.grossMinor, currency, profile?.locale)}</dd>
            </dl>
            {[...result.warnings].map((w) => <p key={w.code + w.message} className="flex items-start gap-2 text-xs text-warning-500"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" /> {w.message}</p>)}
            {result.notes.map((n) => <p key={n} className="text-xs text-text-secondary">{n}</p>)}
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-text-secondary">Reference calculator, not tax advice. US sales tax comes from your Sales Tax settings, so the US preview shows “needs rate”.</p>
    </section>
  );
}
