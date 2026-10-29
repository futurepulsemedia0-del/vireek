import { Calculator, Lock } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { AccountingConnectorsPanel } from '@/components/integrations/AccountingConnectorsPanel';
import { ACCT_PROVIDERS, PROVIDER_META, useCanManageAccounting } from '@/lib/accounting';

/** /dashboard/accounting: one card per accounting system, each linking to its sync page. */
export function AccountingHubPage() {
  const canManage = useCanManageAccounting();

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Accounting Sync">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">Permission required</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">Accounting sync moves financial records, so it is limited to people who can edit the business profile and view billing. Ask your account owner for access.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Accounting Sync">
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary sm:text-2xl">Accounting sync</h1>
          <p className="text-sm text-text-secondary">Keep customers, items, invoices and payments identical in Vireek and your accounting system. You decide what syncs, in which direction, and who wins a conflict.</p>
        </div>
        <ul className="grid gap-4 md:grid-cols-3">
          {ACCT_PROVIDERS.map((p) => (
            <li key={p} className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"><Calculator size={18} /></span>
                <h2 className="text-base font-semibold text-text-primary">{PROVIDER_META[p].label}</h2>
              </div>
              <p className="mt-3 text-sm text-text-secondary">{PROVIDER_META[p].tagline}</p>
              <AccountingConnectorsPanel provider={p} />
            </li>
          ))}
        </ul>
        <p className="text-sm text-text-secondary">Using QuickBooks? Its sync lives at <span className="font-medium text-text-primary">/dashboard/quickbooks</span> and is unchanged.</p>
      </div>
    </DashboardLayout>
  );
}
