import { useSearchParams } from 'react-router-dom';
import { Percent } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { TaxRatesTab } from '@/components/tax/TaxRatesTab';
import { TaxClassesTab } from '@/components/tax/TaxClassesTab';
import { TaxExemptionsTab } from '@/components/tax/TaxExemptionsTab';
import { TaxReportsTab } from '@/components/tax/TaxReportsTab';

const TABS = [
  { key: 'rates', label: 'Rates & registrations' },
  { key: 'classes', label: 'Tax classes' },
  { key: 'exemptions', label: 'Exemptions' },
  { key: 'reports', label: 'Reports' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export function TaxCenterPage() {
  const { permissions } = useAuth();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: TabKey = TABS.some((t) => t.key === requested) ? (requested as TabKey) : 'rates';

  if (!permissions.can_view_billing) {
    return (
      <DashboardLayout activeLabel="Sales Tax">
        <div className="p-6 text-sm text-text-secondary">You don't have permission to view sales tax settings.</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Sales Tax">
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-2">
          <Percent className="text-cta" size={20} />
          <p className="text-sm font-semibold text-text-primary">Sales Tax</p>
        </div>

        <div role="tablist" className="flex flex-wrap gap-1 border-b border-border print:hidden">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setParams({ tab: t.key })}
              className={`focus-ring -mb-px border-b-2 px-3 py-2 text-xs font-medium ${tab === t.key ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'rates' && <TaxRatesTab />}
        {tab === 'classes' && <TaxClassesTab />}
        {tab === 'exemptions' && <TaxExemptionsTab initialCustomerId={params.get('customer')} />}
        {tab === 'reports' && <TaxReportsTab />}
      </div>
    </DashboardLayout>
  );
}
