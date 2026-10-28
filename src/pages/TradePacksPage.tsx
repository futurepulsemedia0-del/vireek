import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, PackageCheck, Power, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { friendlyTradePackError, installPack, updatePack, useTradePacks } from '@/lib/tradePacksApi';
import { TRADE_PACKS, type TradePack } from '@/lib/tradePacks';
import { ComplianceLogPanel } from '@/components/tradePacks/ComplianceLogPanel';
import { PlansPricingPanel } from '@/components/tradePacks/PlansPricingPanel';
import { ProductRegisterPanel } from '@/components/tradePacks/ProductRegisterPanel';
import { RoutesPanel } from '@/components/tradePacks/RoutesPanel';
import { UsageReportsPanel } from '@/components/tradePacks/UsageReportsPanel';
import { Pill } from '@/components/tradePacks/shared';

type Tab = 'overview' | 'log' | 'products' | 'routes' | 'plans' | 'reports';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'log', label: 'Compliance log' },
  { key: 'products', label: 'Products' },
  { key: 'routes', label: 'Routes' },
  { key: 'plans', label: 'Plans & pricing' },
  { key: 'reports', label: 'Usage reports' },
];

function Overview({ pack }: { pack: TradePack }) {
  return (
    <div className="space-y-4 text-sm">
      <p className="text-text-secondary">{pack.complianceNote}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2 p-5">
          <h3 className="font-semibold text-text-primary">Custom fields added</h3>
          <ul className="space-y-1 text-text-secondary">
            {pack.customFields.map((f) => (
              <li key={f.key}>{f.label} <span className="text-xs">({f.entity})</span></li>
            ))}
          </ul>
          <Link to="/dashboard/custom-fields" className="text-accent hover:underline">Manage custom fields</Link>
        </Card>
        <Card className="space-y-2 p-5">
          <h3 className="font-semibold text-text-primary">Forms &amp; checklists added</h3>
          <ul className="space-y-1 text-text-secondary">
            {pack.forms.map((f) => (
              <li key={f.slug}>{f.title} <span className="text-xs">({f.kind})</span></li>
            ))}
          </ul>
          <Link to="/dashboard/form-builder" className="text-accent hover:underline">Open Form Builder</Link>
        </Card>
        <Card className="space-y-2 p-5">
          <h3 className="font-semibold text-text-primary">Record types</h3>
          <ul className="space-y-1 text-text-secondary">
            {pack.logTypes.map((t) => (
              <li key={t.key}>{t.label} — kept {t.retentionYears} years{t.requiredCredentials.length ? ', licence checked' : ''}</li>
            ))}
          </ul>
        </Card>
        <Card className="space-y-2 p-5">
          <h3 className="font-semibold text-text-primary">Scheduling</h3>
          <p className="text-text-secondary">Plans use your existing Recurring Jobs engine, so visits are created automatically and respect double-booking rules.</p>
          <Link to="/dashboard/recurring-jobs" className="text-accent hover:underline">Open Recurring Jobs</Link>
        </Card>
      </div>
    </div>
  );
}

export function TradePacksPage() {
  const { isOwner, permissions, teamMember } = useAuth();
  const { toast } = useToast();
  const { ownerId, installs, enabled, loading, error, reload } = useTradePacks();
  const [selected, setSelected] = useState<string>(TRADE_PACKS[0].key);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);

  const canManage = isOwner || permissions.can_edit_business_profile || teamMember?.role === 'admin';
  const pack = TRADE_PACKS.find((p) => p.key === selected) ?? TRADE_PACKS[0];
  const install = useMemo(() => installs.find((i) => i.pack_key === pack.key), [installs, pack.key]);
  const isOn = enabled.has(pack.key);

  const toggle = async (p: TradePack, on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        const r = await installPack(p);
        toast(`${p.name} is on: ${r.fields_added} fields, ${r.forms_added} forms added${r.fields_skipped ? ` (${r.fields_skipped} fields already existed or hit your field limit)` : ''}.`, 'success');
      } else {
        await updatePack(p.key, { enabled: false });
        toast(`${p.name} is off. Your records are kept.`, 'info');
      }
      await reload();
    } catch (e) {
      toast(friendlyTradePackError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const setEnforce = async (value: boolean) => {
    setBusy(true);
    try {
      await updatePack(pack.key, { enforceCredentials: value });
      await reload();
    } catch (e) {
      toast(friendlyTradePackError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
          <PackageCheck size={24} /> Trade Packs
        </h1>
        <p className="text-sm text-text-secondary">Optional, trade-specific toolkits: fields, forms, checklists, pricing, recurring plans, routes and compliance logs. Turn on only what your business needs.</p>
      </header>

      {loading ? (
        <Skeleton className="h-32 w-full rounded-2xl" />
      ) : (
        <>
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          <div className="grid gap-4 md:grid-cols-2">
            {TRADE_PACKS.map((p) => {
              const on = enabled.has(p.key);
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => { setSelected(p.key); setTab('overview'); }}
                  className={`focus-ring rounded-2xl border p-5 text-left transition-colors ${selected === p.key ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-base font-semibold text-text-primary">{p.name}</span>
                    <Pill tone={on ? 'success' : 'neutral'}>{on ? 'On' : 'Off'}</Pill>
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">{p.tagline}</p>
                </button>
              );
            })}
          </div>

          <Card className="space-y-5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">{pack.name}</h2>
                <p className="text-sm text-text-secondary">{isOn ? 'Active for your account.' : install ? 'Turned off — existing records are kept.' : 'Not installed yet.'}</p>
              </div>
              {canManage ? (
                <Button variant={isOn ? 'secondary' : 'primary'} onClick={() => toggle(pack, !isOn)} disabled={busy}>
                  <Power size={16} /> {isOn ? 'Turn off' : install ? 'Turn on again' : 'Install pack'}
                </Button>
              ) : (
                <Pill>Ask an owner or admin to manage packs</Pill>
              )}
            </div>

            {isOn && install && pack.logTypes.some((t) => t.requiredCredentials.length > 0) && (
              <label className="flex items-start gap-2 text-sm text-text-primary">
                <input type="checkbox" className="mt-1" checked={install.enforce_credentials} disabled={busy || !isOwner} onChange={(e) => setEnforce(e.target.checked)} />
                <span>
                  <span className="flex items-center gap-1 font-medium"><ShieldCheck size={14} /> Require a valid applicator licence to log chemical work</span>
                  <span className="block text-text-secondary">Checks the technician’s credential (Compliance Center) on the date of work. Only the account owner can turn this off.</span>
                </span>
              </label>
            )}

            {isOn && ownerId && install ? (
              <>
                <nav className="flex flex-wrap gap-1 border-b border-border" aria-label="Pack sections">
                  {TABS.filter((t) => t.key !== 'reports' || pack.key === 'pest_control').map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setTab(t.key)}
                      aria-current={tab === t.key ? 'page' : undefined}
                      className={`focus-ring -mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.key ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </nav>
                {tab === 'overview' && <Overview pack={pack} />}
                {tab === 'log' && (
                  <div className="space-y-3">
                    <p className="flex items-center gap-2 text-sm text-text-secondary">
                      <ClipboardList size={14} /> Field entries (chemical, readings, dosing, equipment) are recorded from the job. Stock and regulated-product records can be logged here.
                    </p>
                    <ComplianceLogPanel pack={pack} ownerId={ownerId} install={install} />
                  </div>
                )}
                {tab === 'products' && <ProductRegisterPanel pack={pack} ownerId={ownerId} canManage={canManage} />}
                {tab === 'routes' && <RoutesPanel pack={pack} ownerId={ownerId} canManage={canManage} />}
                {tab === 'plans' && <PlansPricingPanel pack={pack} ownerId={ownerId} install={install} canManage={canManage} onSaved={reload} />}
                {tab === 'reports' && pack.key === 'pest_control' && <UsageReportsPanel ownerId={ownerId} canManage={canManage} />}
              </>
            ) : (
              <Overview pack={pack} />
            )}
          </Card>
        </>
      )}
    </div>
  );
}

export default TradePacksPage;
