/**
 * Country & Regional Packs — /dashboard/settings/regional-packs
 *
 * Per-tenant switchboard for the US, Canada, UK, EU and Australia packs: tax (VAT/GST/HST/PST/QST), local
 * currencies and payment methods, phone/address/tax-id validation, holiday calendars and GDPR/CASL tooling.
 * Pure logic: lib/regionalPacks/*. Persistence + permissions: lib/regionalPacksApi.ts and
 * supabase/migrations/20271021000000_regional_packs.sql.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Globe, ShieldAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { BackButton } from '@/components/ui/BackButton';
import { Button } from '@/components/ui/Button';
import { TaxPanel } from '@/components/regional-packs/TaxPanel';
import { CalendarPanel } from '@/components/regional-packs/CalendarPanel';
import { PrivacyPanel } from '@/components/regional-packs/PrivacyPanel';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRegionalPacks } from '@/hooks/useRegionalPacks';
import { PACKS, PAYMENT_METHODS, billingCurrencies, countriesInPack, getCountry } from '@/lib/regionalPacks/packData';
import { parsePhone, validateAddress, validateTaxId } from '@/lib/regionalPacks/packValidation';
import { PACK_CODES, type PackCode } from '@/lib/regionalPacks/packTypes';

type Tab = 'packs' | 'tax' | 'calendars' | 'privacy';
const TABS: { id: Tab; label: string }[] = [
  { id: 'packs', label: 'Packs' }, { id: 'tax', label: 'Tax' }, { id: 'calendars', label: 'Calendars' }, { id: 'privacy', label: 'Privacy' },
];

const inputCls = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent';
const labelCls = 'mb-1 block text-xs font-medium text-text-secondary';

export function RegionalPacksSettingsPage() {
  const { isOwner, permissions, profile, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();
  const { packs, status, error, reload, toggle, isEnabled } = useRegionalPacks();
  const [tab, setTab] = useState<Tab>('packs');
  const [busy, setBusy] = useState<PackCode | null>(null);
  const [confirm, setConfirm] = useState<PackCode | null>(null);
  const canManage = isOwner || permissions.can_edit_business_profile;

  const flip = async (code: PackCode, enabled: boolean) => {
    setBusy(code);
    try {
      await toggle(code, enabled);
      toast(`${PACKS[code].name} pack ${enabled ? 'enabled' : 'disabled'}.`, 'success');
    } catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); }
    finally { setBusy(null); }
  };

  if (authLoading || profileLoading || !profile) {
    return <DashboardLayout activeLabel="Regional Packs"><div className="mx-auto max-w-5xl" aria-busy="true"><SkeletonCardList count={3} /></div></DashboardLayout>;
  }
  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Regional Packs">
        <div className="mx-auto max-w-3xl">
          <EmptyState icon={ShieldAlert} title="You don't have access to regional packs" description="Managing regional packs needs the “edit business profile” permission. Ask your account owner to grant it." />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Regional Packs">
      <div className="mx-auto max-w-5xl">
        <BackButton fallback="/dashboard/settings" label="Settings" className="mb-4" />
        <header className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Globe size={22} className="text-accent" aria-hidden="true" /> Country & regional packs</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
            Switch on the countries you operate in. Each pack adds local tax rules, currencies and payment methods, phone and address checks, holiday calendars and privacy tooling.
          </p>
        </header>

        {status === 'error' && (
          <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            <span className="flex items-center gap-2"><AlertTriangle size={16} aria-hidden="true" /> {error}</span>
            <Button variant="secondary" size="sm" onClick={() => void reload()}>Retry</Button>
          </div>
        )}

        <div role="tablist" aria-label="Regional packs sections" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
          {TABS.map((t) => (
            <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} onClick={() => setTab(t.id)}
              className={`min-h-[40px] shrink-0 rounded-lg px-4 text-sm font-semibold transition-colors ${tab === t.id ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary'}`}>{t.label}</button>
          ))}
        </div>

        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {status === 'loading' ? <SkeletonCardList count={3} /> : tab === 'packs' ? (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                {PACK_CODES.map((code) => {
                  const pack = PACKS[code];
                  const on = isEnabled(code);
                  const methods = new Set(countriesInPack(code).flatMap((c) => c.paymentMethods));
                  return (
                    <article key={code} className={`flex flex-col rounded-2xl border p-4 sm:p-5 ${on ? 'border-accent/50 bg-bg-secondary' : 'border-border bg-bg-secondary'}`}>
                      <div className="flex items-start justify-between gap-3">
                        <h2 className="text-base font-semibold text-text-primary"><span aria-hidden="true">{pack.flag}</span> {pack.name}</h2>
                        {on && <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success"><Check size={12} aria-hidden="true" /> On</span>}
                      </div>
                      <p className="mt-2 flex-1 text-sm leading-relaxed text-text-secondary">{pack.summary}</p>
                      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                        <dt className="text-text-secondary">Tax</dt><dd className="text-text-primary">{pack.taxLabel}</dd>
                        <dt className="text-text-secondary">Currencies</dt><dd className="text-text-primary">{billingCurrencies([code]).join(', ')}</dd>
                        <dt className="text-text-secondary">Payments</dt><dd className="text-text-primary">{[...methods].map((m) => PAYMENT_METHODS[m].scheme ?? 'Card').filter((v, i, a) => a.indexOf(v) === i).join(', ')}</dd>
                        <dt className="text-text-secondary">Countries</dt><dd className="text-text-primary">{pack.countries.length}</dd>
                        <dt className="text-text-secondary">Data checked</dt><dd className="text-text-primary">{pack.dataVerifiedAt}</dd>
                      </dl>
                      <Button className="mt-4 w-full" variant={on ? 'secondary' : 'primary'} size="sm" disabled={busy === code}
                        onClick={() => (on ? setConfirm(code) : void flip(code, true))} aria-label={`${on ? 'Disable' : 'Enable'} ${pack.name} pack`}>
                        {busy === code ? 'Working…' : on ? 'Disable pack' : 'Enable pack'}
                      </Button>
                    </article>
                  );
                })}
              </div>
              <ValidatorLab enabled={packs} />
            </div>
          ) : tab === 'tax' ? <TaxPanel enabledPacks={packs} canManage={canManage} />
            : tab === 'calendars' ? <CalendarPanel enabledPacks={packs} canManage={canManage} />
              : <PrivacyPanel enabledPacks={packs} canManage={canManage} />}
        </div>

        <p className="mt-8 text-xs leading-relaxed text-text-secondary">
          Rates and rules are reference data checked on the dates shown; they are not tax or legal advice. Confirm registrations, reduced rates and retention periods with your accountant.
        </p>
      </div>

      <ConfirmDialog
        open={!!confirm} title={`Disable the ${confirm ? PACKS[confirm].name : ''} pack?`}
        description="Existing invoices and records are not changed. New quotes and invoices will stop using this pack's tax rules, validators and calendars."
        confirmLabel="Disable" onConfirm={() => { const c = confirm; setConfirm(null); if (c) void flip(c, false); }} onCancel={() => setConfirm(null)}
      />
    </DashboardLayout>
  );
}

/** Try the validators live: phone, address and tax id for any enabled country. */
function ValidatorLab({ enabled }: { enabled: PackCode[] }) {
  const countries = useMemo(() => enabled.flatMap((p) => countriesInPack(p)), [enabled]);
  const [country, setCountry] = useState('');
  const code = country || countries[0]?.code || '';
  const profile = getCountry(code);
  const [phone, setPhone] = useState('');
  const [addr, setAddr] = useState({ line1: '', city: '', subdivision: '', postalCode: '' });
  const [taxId, setTaxId] = useState('');

  if (countries.length === 0) return null;
  const p = phone ? parsePhone(phone, code) : null;
  const a = addr.line1 || addr.city || addr.postalCode ? validateAddress({ ...addr, country: code }, { serviceSite: true }) : null;
  const t = taxId ? validateTaxId(code, taxId) : null;

  return (
    <section aria-labelledby="lab-h" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <h2 id="lab-h" className="text-base font-semibold text-text-primary">Try the validators</h2>
      <p className="mb-3 text-sm text-text-secondary">Checks format and rules offline — it cannot prove a number is in service or an address exists.</p>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-3">
          <div><label className={labelCls} htmlFor="lab-c">Country</label>
            <select id="lab-c" className={inputCls} value={code} onChange={(e) => setCountry(e.target.value)}>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div>
          <div><label className={labelCls} htmlFor="lab-p">Phone</label><input id="lab-p" className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
            {p && <p className={`mt-1 text-xs ${p.ok ? 'text-success' : 'text-danger'}`}>{p.ok ? `${p.international} · ${p.type}` : p.reason}</p>}</div>
          <div><label className={labelCls} htmlFor="lab-t">Tax ID (VAT / ABN / GST)</label><input id="lab-t" className={inputCls} value={taxId} onChange={(e) => setTaxId(e.target.value)} />
            {t && <p className={`mt-1 text-xs ${t.valid ? 'text-success' : 'text-danger'}`}>{t.valid ? (t.warnings[0] ?? 'Valid format.') : t.reason}</p>}</div>
        </div>
        <div className="space-y-3 md:col-span-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><label className={labelCls} htmlFor="lab-l1">Street address</label><input id="lab-l1" className={inputCls} value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} /></div>
            <div><label className={labelCls} htmlFor="lab-ci">City</label><input id="lab-ci" className={inputCls} value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} /></div>
            <div><label className={labelCls} htmlFor="lab-su">{profile?.subdivisions ? 'State / province' : 'Region (optional)'}</label><input id="lab-su" className={inputCls} value={addr.subdivision} onChange={(e) => setAddr({ ...addr, subdivision: e.target.value })} /></div>
            <div><label className={labelCls} htmlFor="lab-po">{profile?.postal.label ?? 'Postal code'}</label><input id="lab-po" className={inputCls} value={addr.postalCode} placeholder={profile?.postal.example} onChange={(e) => setAddr({ ...addr, postalCode: e.target.value })} /></div>
          </div>
          {a && (
            <ul className="text-xs" aria-live="polite">
              {a.valid && <li className="text-success">Looks valid → {[a.normalized.line1, a.normalized.city, a.normalized.subdivision, a.normalized.postalCode].filter(Boolean).join(', ')}</li>}
              {a.issues.map((i) => <li key={i.code + i.field} className={i.severity === 'error' ? 'text-danger' : 'text-warning-500'}>{i.message}</li>)}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
