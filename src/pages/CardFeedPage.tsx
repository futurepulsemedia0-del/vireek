import { useMemo, useState } from 'react';
import { AlertTriangle, CreditCard, Receipt } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { CardReceiptDialog } from '@/components/cardfeed/CardReceiptDialog';
import { CardsPanel, ImportPanel, PurchasesPanel, SettingsPanel } from '@/components/cardfeed/CardFeedManagerPanels';
import { ErrorState, Pill, SelectField, Stat, formatDateTime, useLoader } from '@/components/vehicles/shared';
import { useAuth } from '@/contexts/AuthContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useToast } from '@/contexts/ToastContext';
import { formatMoney } from '@/lib/currency';
import { fetchCardFeed, type CardFeedOverview } from '@/lib/cardFeedApi';
import { KIND_LABELS, RECEIPT_STATE_META, isOpenReceipt, receiptState, summarizeCardTxns, type CardTransaction } from '@/lib/cardFeed';

const EMPTY: CardFeedOverview = { transactions: [], cards: [], settings: null, imports: [], vehicles: [], technicians: [], bankAccounts: [] };
const RANGES = [30, 90, 365] as const;
type TabId = 'mine' | 'purchases' | 'import' | 'cards' | 'settings';

export function CardFeedPage() {
  const { isOwner, permissions, profile, teamMember, user } = useAuth();
  const { currency } = useCurrency();
  const { toast } = useToast();

  // Same gate as Expenses: owners and people with billing access manage; everyone else files their own receipts.
  const isManager = isOwner || permissions.can_view_billing;
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const uid = user?.id ?? null;

  const [tab, setTab] = useState<TabId>('mine');
  const [days, setDays] = useState<number>(90);
  const [capture, setCapture] = useState<CardTransaction | null>(null);

  const overview = useLoader(
    () => (accountOwnerId ? fetchCardFeed(days, isManager) : Promise.resolve(EMPTY)),
    `${accountOwnerId ?? 'none'}:${isManager}:${days}`,
  );
  const data = overview.data ?? EMPTY;
  const money = (cents: number) => formatMoney(cents / 100, currency);

  // Managers work from the open items; a technician already only receives their own purchases (RLS).
  const mine = useMemo(
    () => (isManager ? data.transactions.filter((t) => isOpenReceipt(receiptState(t))) : data.transactions),
    [data.transactions, isManager],
  );
  const summary = useMemo(() => summarizeCardTxns(data.transactions), [data.transactions]);
  const unknownLast4 = useMemo(
    () => [...new Set(data.transactions.filter((t) => t.flags.includes('unregistered_card') && t.card_last4).map((t) => t.card_last4 as string))].sort(),
    [data.transactions],
  );

  const tabs: { id: TabId; label: string }[] = isManager
    ? [{ id: 'mine', label: 'Receipts' }, { id: 'purchases', label: 'All purchases' }, { id: 'import', label: 'Import' }, { id: 'cards', label: 'Cards' }, { id: 'settings', label: 'Settings' }]
    : [{ id: 'mine', label: 'My receipts' }];
  const activeTab: TabId = tabs.some((t) => t.id === tab) ? tab : 'mine';

  const onTabKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === activeTab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (next == null) return;
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    setTab(target.id);
    document.getElementById(`cf-tab-${target.id}`)?.focus();
  };

  const header = (
    <div className="mb-6 flex items-center gap-3">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><CreditCard size={24} /></span>
      <div>
        <h1 className="text-xl font-bold text-text-primary">Card Purchases &amp; Receipts</h1>
        <p className="text-sm text-text-secondary">Every company-card purchase matched to a technician, with a receipt on file.</p>
      </div>
    </div>
  );

  if (!accountOwnerId || !uid || (overview.loading && !overview.data)) {
    return <DashboardLayout activeLabel="Card Purchases">{header}<SkeletonStatGrid className="mb-6" /><SkeletonCardList count={4} rows={2} /></DashboardLayout>;
  }
  if (overview.error && !overview.data) {
    return <DashboardLayout activeLabel="Card Purchases">{header}<ErrorState message={overview.error} onRetry={overview.reload} /></DashboardLayout>;
  }

  const reload = () => overview.reload();
  const sorted = [...mine].sort((a, b) => Number(isOpenReceipt(receiptState(b))) - Number(isOpenReceipt(receiptState(a))) || b.transaction_at.localeCompare(a.transaction_at));

  return (
    <DashboardLayout activeLabel="Card Purchases">
      {header}

      {overview.error && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span>Couldn't refresh: {overview.error}</span>
          <Button size="sm" variant="ghost" onClick={overview.reload}>Retry</Button>
        </div>
      )}

      <div className="mb-3 max-w-xs">
        <SelectField label="Period" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
          {RANGES.map((r) => <option key={r} value={r}>Last {r} days</option>)}
        </SelectField>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Card spend" value={money(summary.spendCents)} hint={`${summary.total.toLocaleString()} purchases`} />
        <Stat label="Receipts needed" value={summary.needReceipt} tone={summary.overdue ? 'danger' : summary.needReceipt ? 'warning' : 'success'} hint={`${summary.overdue} overdue · ${summary.rejected} rejected`} />
        {isManager && <Stat label="Unassigned" value={summary.unassigned} tone={summary.unassigned ? 'warning' : 'success'} hint="No technician matched" />}
        {isManager && <Stat label="Matched" value={summary.matchRate == null ? '—' : `${summary.matchRate}%`} tone={summary.matchRate != null && summary.matchRate < 90 ? 'warning' : 'neutral'} hint={`${data.cards.length} cards registered`} />}
      </div>

      <div role="tablist" aria-label="Card purchase sections" onKeyDown={onTabKey} className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id} id={`cf-tab-${t.id}`} type="button" role="tab" aria-selected={activeTab === t.id} aria-controls={`cf-panel-${t.id}`}
            tabIndex={activeTab === t.id ? 0 : -1} onClick={() => setTab(t.id)}
            className={`focus-ring -mb-px min-h-[44px] whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${activeTab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
          >
            {t.label}
            {t.id === 'mine' && summary.needReceipt > 0 && <span className="ms-1.5 rounded-full bg-danger/10 px-1.5 py-0.5 text-xs text-danger">{summary.needReceipt}</span>}
          </button>
        ))}
      </div>

      <div id={`cf-panel-${activeTab}`} role="tabpanel" aria-labelledby={`cf-tab-${activeTab}`}>
        {activeTab === 'mine' && (
          sorted.length === 0 ? (
            <EmptyState icon={Receipt} title="No card purchases to show" description={isManager ? 'Import a CSV or sync your bank feed to get started.' : 'When a company-card purchase is matched to you, it will appear here and you will be asked for the receipt.'} action={isManager ? { label: 'Import purchases', onClick: () => setTab('import') } : undefined} />
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border bg-bg-secondary">
              {sorted.map((t) => {
                const st = receiptState(t);
                const meta = RECEIPT_STATE_META[st];
                return (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">{t.merchant ?? 'Card purchase'}</p>
                      <p className="text-xs text-text-secondary">{formatDateTime(t.transaction_at)} · {KIND_LABELS[t.kind]}{t.card_last4 ? ` ••${t.card_last4}` : ''}{isManager && t.technician_name ? ` · ${t.technician_name}` : ''}</p>
                      {st === 'rejected' && t.expense?.review_note && <p className="mt-1 flex items-center gap-1 text-xs text-danger"><AlertTriangle size={12} /> {t.expense.review_note}</p>}
                      {t.receipt_due_at && isOpenReceipt(st) && <p className="text-xs text-text-secondary">Due {formatDateTime(t.receipt_due_at)}</p>}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold text-text-primary">{money(t.amount_cents)}</span>
                      <Pill tone={meta.tone}>{meta.label}</Pill>
                      {isOpenReceipt(st) && <Button size="sm" onClick={() => setCapture(t)}>{st === 'rejected' ? 'Resubmit' : 'Add receipt'}</Button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        )}
        {isManager && activeTab === 'purchases' && <PurchasesPanel rows={data.transactions} vehicles={data.vehicles} technicians={data.technicians} onChanged={reload} />}
        {isManager && activeTab === 'import' && <ImportPanel data={data} onChanged={reload} onOpenSettings={() => setTab('settings')} />}
        {isManager && activeTab === 'cards' && <CardsPanel cards={data.cards} vehicles={data.vehicles} technicians={data.technicians} unknownLast4={unknownLast4} onChanged={reload} />}
        {isManager && activeTab === 'settings' && <SettingsPanel key={data.settings?.last_bank_import_at ?? 'settings'} data={data} onChanged={reload} />}
      </div>

      {capture && (
        <CardReceiptDialog
          txn={capture} ownerId={accountOwnerId} uid={uid}
          onClose={() => setCapture(null)}
          onDone={() => { setCapture(null); toast('Receipt submitted for review.', 'success'); void reload(); }}
        />
      )}
    </DashboardLayout>
  );
}
