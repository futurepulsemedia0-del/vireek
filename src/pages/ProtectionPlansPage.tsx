/**
 * Service Protection Plans — /dashboard/protection-plans
 *
 * Sell extended-warranty / protection plans on quotes (customer checkout) and invoices, link them to
 * covered equipment, run the claims workflow (rows in warranty_claims), renew, and see premium /
 * reserve accounting. Every read is scoped to the account by RLS; money-moving actions are
 * SECURITY DEFINER RPCs. The page is gated on `can_view_billing` — that gate is UX, the database
 * enforces the same rule.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ClaimsPanel, FileClaimDialog } from '@/components/protection/ClaimsPanel';
import { ContractsPanel } from '@/components/protection/ContractsPanel';
import { FinancialsPanel } from '@/components/protection/FinancialsPanel';
import { PlanCatalog } from '@/components/protection/PlanCatalog';
import { Kpi } from '@/components/protection/ui';
import {
  effectiveStatus,
  fetchContracts,
  fetchFinancials,
  fetchPlanClaims,
  fetchTemplates,
  formatMoney,
  isOpenClaim,
  parseFinancials,
  protectionErrorMessage,
  renewalState,
  runLifecycle,
  type PlanClaim,
  type PlanTemplate,
  type ProtectionContract,
  type ProtectionFinancials,
} from '@/lib/protectionPlans';

type TabKey = 'plans' | 'claims' | 'catalog' | 'financials';
type LoadState = 'loading' | 'ready' | 'error';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'plans', label: 'Sold plans' },
  { key: 'claims', label: 'Claims' },
  { key: 'catalog', label: 'Plan catalog' },
  { key: 'financials', label: 'Financials' },
];

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <DashboardLayout activeLabel="Protection Plans">
      <div className="mx-auto max-w-6xl space-y-5">{children}</div>
    </DashboardLayout>
  );
}

export function ProtectionPlansPage() {
  const { isOwner, permissions, profile, teamMember, profileLoading } = useAuth();
  const { toast } = useToast();

  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canView = isOwner || permissions.can_view_billing;

  const [tab, setTab] = useState<TabKey>('plans');
  const [state, setState] = useState<LoadState>('loading');
  const [templates, setTemplates] = useState<PlanTemplate[]>([]);
  const [contracts, setContracts] = useState<ProtectionContract[]>([]);
  const [claims, setClaims] = useState<PlanClaim[]>([]);
  const [financials, setFinancials] = useState<ProtectionFinancials>(() => parseFinancials(null));
  const [fileClaimFor, setFileClaimFor] = useState<string | null | undefined>(undefined);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!canView || !ownerId) return;
      if (!opts.silent) setState('loading');
      try {
        await runLifecycle();
        const [t, c, k, f] = await Promise.all([fetchTemplates(), fetchContracts(), fetchPlanClaims(), fetchFinancials()]);
        setTemplates(t);
        setContracts(c);
        setClaims(k);
        setFinancials(f);
        setState('ready');
      } catch (e) {
        if (opts.silent) toast(protectionErrorMessage(e, 'Could not refresh.'), 'error');
        else setState('error');
      }
    },
    [canView, ownerId, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    const active = contracts.filter((c) => {
      const s = effectiveStatus(c);
      return s === 'active' || s === 'scheduled';
    }).length;
    return {
      active,
      pending: contracts.filter((c) => c.status === 'pending_payment').length,
      openClaims: claims.filter((c) => isOpenClaim(c.status)).length,
      renewals: contracts.filter((c) => renewalState(c, contracts) === 'due').length,
    };
  }, [contracts, claims]);

  if (profileLoading) {
    return (
      <Shell>
        <div className="h-40 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" />
      </Shell>
    );
  }

  if (!canView || !ownerId) {
    return (
      <Shell>
        <EmptyState icon={Lock} title="Billing access required" description="Protection plans involve pricing and payouts. Ask the account owner for billing permission." />
      </Shell>
    );
  }

  return (
    <Shell>
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
          <ShieldCheck size={24} className="text-accent" /> Protection Plans
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          Extended-warranty plans sold on quotes and invoices, linked to the customer’s equipment, with claims, renewals and reserve accounting.
        </p>
      </header>

      {state === 'error' && (
        <EmptyState
          icon={ShieldCheck}
          title="Could not load protection plans"
          description="If this is the first time, make sure the Protection Plans database migration has been applied."
          action={{ label: 'Try again', onClick: () => void load() }}
        />
      )}

      {state === 'loading' && (
        <div className="space-y-3" aria-busy="true" aria-label="Loading protection plans">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-secondary" />
            ))}
          </div>
          <div className="h-64 animate-pulse rounded-2xl bg-bg-secondary" />
        </div>
      )}

      {state === 'ready' && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Active plans" value={String(summary.active)} sub={`${formatMoney(financials.unearned_cents)} unearned`} />
            <Kpi label="Awaiting payment" value={String(summary.pending)} tone={summary.pending > 0 ? 'warn' : 'default'} />
            <Kpi label="Open claims" value={String(summary.openClaims)} tone={summary.openClaims > 0 ? 'warn' : 'default'} />
            <Kpi label="Renewals due" value={String(summary.renewals)} tone={summary.renewals > 0 ? 'warn' : 'default'} />
          </div>

          <div role="tablist" aria-label="Protection plan sections" className="flex gap-1 overflow-x-auto border-b border-border">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                id={`pp-tab-${t.key}`}
                aria-selected={tab === t.key}
                aria-controls={`pp-panel-${t.key}`}
                type="button"
                onClick={() => setTab(t.key)}
                className={`focus-ring -mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                  tab === t.key ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`pp-panel-${tab}`} aria-labelledby={`pp-tab-${tab}`}>
            {tab === 'plans' && (
              <ContractsPanel
                contracts={contracts}
                claims={claims}
                templates={templates}
                canManage
                onChanged={() => void load({ silent: true })}
                onFileClaim={(id) => setFileClaimFor(id)}
              />
            )}
            {tab === 'claims' && (
              <ClaimsPanel claims={claims} contracts={contracts} canManage onChanged={() => void load({ silent: true })} onFile={() => setFileClaimFor(null)} />
            )}
            {tab === 'catalog' && <PlanCatalog templates={templates} ownerId={ownerId} canManage onChanged={() => void load({ silent: true })} />}
            {tab === 'financials' && <FinancialsPanel data={financials} />}
          </div>
        </>
      )}

      {fileClaimFor !== undefined && (
        <FileClaimDialog
          contracts={contracts}
          claims={claims}
          initialContractId={fileClaimFor ?? undefined}
          onClose={() => setFileClaimFor(undefined)}
          onDone={() => {
            setFileClaimFor(undefined);
            toast('Claim filed', 'success');
            setTab('claims');
            void load({ silent: true });
          }}
        />
      )}
    </Shell>
  );
}
