import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useGrowthT } from '@/i18n/growthNamespace';
import { RevenueTab } from '@/components/staff/growth/RevenueTab';
import { AcquisitionTab } from '@/components/staff/growth/AcquisitionTab';
import { PlansChurnTab } from '@/components/staff/growth/PlansChurnTab';
import { ExperimentsTab } from '@/components/staff/growth/ExperimentsTab';
import { OperationsTab } from '@/components/staff/growth/OperationsTab';

const TABS = ['revenue', 'acquisition', 'plans', 'experiments', 'operations'] as const;
type Tab = (typeof TABS)[number];
const RANGES = ['d30', 'd90', 'd180', 'm3', 'm6'] as const;
type Range = (typeof RANGES)[number];

function resolveRange(r: Range, today: Date): { from: Date; to: Date } {
  const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
  const t0 = utc(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (r === 'm3' || r === 'm6') {
    const n = r === 'm3' ? 3 : 6;
    return { from: utc(t0.getUTCFullYear(), t0.getUTCMonth() - n, 1), to: utc(t0.getUTCFullYear(), t0.getUTCMonth(), 0) };
  }
  const days = r === 'd30' ? 30 : r === 'd90' ? 90 : 180;
  return { from: new Date(t0.getTime() - days * 86_400_000), to: t0 };
}

/** Staff-only founder dashboard. Route guard: <StaffRoute>; the database enforces is_vireek_staff on every RPC. */
export function GrowthAnalyticsPage() {
  const { t } = useGrowthT();
  const [tab, setTab] = useState<Tab>('revenue');
  const [range, setRange] = useState<Range>('m3');
  const { from, to } = useMemo(() => resolveRange(range, new Date()), [range]);
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ revenue: null, acquisition: null, plans: null, experiments: null, operations: null });

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]);
    refs.current[TABS[next]]?.focus();
  };

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-text-primary">{t('page.title')}</h1>
        <p className="text-sm text-text-secondary">{t('page.subtitle')}</p>
        <p className="rounded-xl bg-bg-secondary p-3 text-xs text-text-primary">{t('page.northStar')}</p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label={t('page.sections')} className="flex flex-wrap gap-1">
          {TABS.map((id, i) => (
            <button
              key={id}
              ref={(el) => { refs.current[id] = el; }}
              role="tab"
              id={`tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(e) => onKey(e, i)}
              className={`focus-ring rounded-xl px-3 py-2 text-sm font-semibold ${tab === id ? 'bg-accent text-white' : 'bg-bg-secondary text-text-primary'}`}
            >
              {t(`tabs.${id}`)}
            </button>
          ))}
        </div>
        {tab !== 'experiments' && tab !== 'operations' && (
          <div className="flex items-center gap-2">
            <label htmlFor="g-range" className="text-xs text-text-secondary">{t('page.range')}</label>
            <select id="g-range" value={range} onChange={(e) => setRange(e.target.value as Range)} className="focus-ring rounded-lg border border-border bg-bg-secondary px-2 py-1 text-sm text-text-primary">
              {RANGES.map((r) => <option key={r} value={r}>{t(`ranges.${r}`)}</option>)}
            </select>
          </div>
        )}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="focus-ring rounded-xl">
        {tab === 'revenue' && <RevenueTab from={from} to={to} />}
        {tab === 'acquisition' && <AcquisitionTab from={from} to={to} />}
        {tab === 'plans' && <PlansChurnTab from={from} to={to} />}
        {tab === 'experiments' && <ExperimentsTab />}
        {tab === 'operations' && <OperationsTab />}
      </div>
    </main>
  );
}
