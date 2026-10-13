import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  Award,
  Briefcase,
  CheckCircle2,
  Clock,
  CreditCard,
  Receipt,
  ShieldCheck,
  Wrench,
  WifiOff,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { formatAmount, formatCents } from '@/lib/customerPortal';
import {
  HISTORY_JOB_STATUS_LABELS,
  INVOICE_DISPLAY_LABELS,
  MEMBERSHIP_STATUS_LABELS,
  equipmentTitle,
  fetchPortalHistory,
  filterInvoices,
  formatHistoryDate,
  getInvoiceLink,
  groupServicesByYear,
  invoiceDisplayStatus,
  membershipPriceLabel,
  nextServiceDue,
  serviceDate,
  warrantyStatus,
  type HistoryEquipment,
  type HistoryInvoice,
  type HistoryJobStatus,
  type HistoryMembership,
  type HistoryService,
  type InvoiceDisplayStatus,
  type InvoiceFilter,
  type PortalHistory,
} from '@/lib/portalHistory';

type TabKey = 'services' | 'invoices' | 'membership' | 'equipment';
const TAB_KEYS: TabKey[] = ['services', 'invoices', 'membership', 'equipment'];
const PAGE_SIZE = 15;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PortalHistory }
  | { kind: 'unavailable' }
  | { kind: 'error' };

type Tone = 'success' | 'warn' | 'danger' | 'accent' | 'neutral';

const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-success-500/10 text-success',
  warn: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger/10 text-danger',
  accent: 'bg-accent/10 text-accent',
  neutral: 'bg-bg-tertiary text-text-secondary',
};

const JOB_TONES: Record<HistoryJobStatus, Tone> = {
  scheduled: 'accent',
  en_route: 'warn',
  in_progress: 'warn',
  completed: 'success',
  cancelled: 'neutral',
  no_show: 'danger',
};

const INVOICE_TONES: Record<InvoiceDisplayStatus, Tone> = {
  paid: 'success',
  due: 'accent',
  overdue: 'danger',
  void: 'neutral',
};

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark sm:p-6';

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

function StatTile({ label, value, hint, tone = 'neutral' }: { label: string; value: string; hint?: string; tone?: Tone }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 truncate text-xl font-bold ${tone === 'warn' ? 'text-warning-500' : 'text-text-primary'}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function ShowMore({ remaining, onClick }: { remaining: number; onClick: () => void }) {
  if (remaining <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring mt-4 min-h-[44px] w-full rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
    >
      Show more ({remaining} remaining)
    </button>
  );
}

// ============================================================
// SERVICES
// ============================================================

function ServiceItem({ s }: { s: HistoryService }) {
  return (
    <li className="rounded-xl border border-border/60 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-text-primary">{s.service_type ?? 'Service visit'}</p>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-text-secondary">
            <Clock size={11} aria-hidden="true" /> {formatHistoryDate(serviceDate(s))}
          </p>
        </div>
        <Pill tone={JOB_TONES[s.job_status] ?? 'neutral'}>{HISTORY_JOB_STATUS_LABELS[s.job_status] ?? s.job_status}</Pill>
      </div>
      {s.equipment.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Equipment serviced">
          {s.equipment.map((e) => (
            <li key={e.id} className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-1 text-[11px] text-text-secondary">
              <Wrench size={10} aria-hidden="true" /> {e.label}
            </li>
          ))}
        </ul>
      )}
      {s.invoice_amount !== null && (
        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs">
          <span className="text-text-secondary">
            {s.invoice_status === 'paid' ? 'Paid' : s.invoice_status === 'sent' ? 'Invoice sent' : 'Not yet invoiced'}
          </span>
          <span className="font-semibold text-text-primary">{formatAmount(s.invoice_amount)}</span>
        </div>
      )}
    </li>
  );
}

function ServicesPanel({ services, total }: { services: HistoryService[]; total: number }) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const groups = useMemo(() => groupServicesByYear(services.slice(0, visible)), [services, visible]);

  if (services.length === 0) {
    return (
      <EmptyState
        icon={Briefcase}
        title="No service history yet"
        description="Completed and upcoming visits will appear here after your first appointment."
      />
    );
  }

  return (
    <div className={CARD}>
      <div className="space-y-6">
        {groups.map((g) => (
          <section key={g.year} aria-labelledby={`year-${g.year}`}>
            <h3 id={`year-${g.year}`} className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              {g.year}
            </h3>
            <ol className="space-y-3">
              {g.items.map((s) => (
                <ServiceItem key={s.id} s={s} />
              ))}
            </ol>
          </section>
        ))}
      </div>
      <ShowMore remaining={services.length - visible} onClick={() => setVisible((v) => v + PAGE_SIZE)} />
      {total > services.length && (
        <p className="mt-4 text-center text-xs text-text-secondary">
          Showing your {services.length} most recent visits of {total}. Contact us for older records.
        </p>
      )}
    </div>
  );
}

// ============================================================
// INVOICES
// ============================================================

const FILTER_LABELS: Record<InvoiceFilter, string> = { all: 'All', outstanding: 'Outstanding', paid: 'Paid' };

function InvoiceItem({ inv }: { inv: HistoryInvoice }) {
  const display = invoiceDisplayStatus(inv);
  const issued = inv.sent_at ?? inv.created_at;
  const actionable = display === 'due' || display === 'overdue';
  return (
    <li>
      <Link
        to={getInvoiceLink(inv.invoice_token)}
        className="focus-ring flex min-h-[44px] items-center justify-between gap-3 rounded-xl border border-border/60 p-3.5 transition-colors hover:bg-bg-tertiary"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">{inv.invoice_number ? `Invoice ${inv.invoice_number}` : 'Invoice'}</p>
          <p className="mt-0.5 text-xs text-text-secondary">
            Issued {formatHistoryDate(issued)}
            {display === 'paid' && inv.paid_at ? ` · Paid ${formatHistoryDate(inv.paid_at)}` : ''}
            {actionable && inv.due_date ? ` · Due ${formatHistoryDate(inv.due_date)}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="text-sm font-semibold text-text-primary">{formatCents(inv.total_cents)}</span>
          <Pill tone={INVOICE_TONES[display]}>
            {actionable && <CreditCard size={11} aria-hidden="true" />}
            {INVOICE_DISPLAY_LABELS[display]}
          </Pill>
        </div>
      </Link>
    </li>
  );
}

function InvoicesPanel({
  invoices,
  filter,
  onFilter,
}: {
  invoices: HistoryInvoice[];
  filter: InvoiceFilter;
  onFilter: (f: InvoiceFilter) => void;
}) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const filtered = useMemo(() => filterInvoices(invoices, filter), [invoices, filter]);

  if (invoices.length === 0) {
    return <EmptyState icon={Receipt} title="No invoices yet" description="Invoices for your completed work will show up here." />;
  }

  return (
    <div className={CARD}>
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter invoices">
        {(Object.keys(FILTER_LABELS) as InvoiceFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => {
              onFilter(f);
              setVisible(PAGE_SIZE);
            }}
            className={`focus-ring min-h-[36px] rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
              filter === f ? 'border-accent bg-accent text-white' : 'border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            {FILTER_LABELS[f]} ({filterInvoices(invoices, f).length})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="flex items-center gap-2 rounded-xl border border-border/60 p-4 text-sm text-text-secondary">
          <CheckCircle2 size={16} className="shrink-0 text-success" aria-hidden="true" />
          {filter === 'outstanding' ? "You're all paid up — nothing outstanding." : 'No paid invoices yet.'}
        </p>
      ) : (
        <>
          <ul className="space-y-3">
            {filtered.slice(0, visible).map((inv) => (
              <InvoiceItem key={inv.id} inv={inv} />
            ))}
          </ul>
          <ShowMore remaining={filtered.length - visible} onClick={() => setVisible((v) => v + PAGE_SIZE)} />
        </>
      )}
    </div>
  );
}

// ============================================================
// MEMBERSHIP
// ============================================================

function MembershipItem({ m }: { m: HistoryMembership }) {
  const price = membershipPriceLabel(m);
  const tone: Tone = m.status === 'active' ? 'success' : m.status === 'offered' ? 'accent' : 'neutral';
  const dateLine =
    m.status === 'cancelled'
      ? `Cancelled ${formatHistoryDate(m.cancelled_at)}`
      : m.status === 'active'
        ? `Member since ${formatHistoryDate(m.started_at)}`
        : `Offered ${formatHistoryDate(m.offered_at)}`;
  return (
    <li className="rounded-xl border border-border/60 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-text-primary">{m.plan_name ?? 'Membership'}</p>
          <p className="mt-0.5 text-xs text-text-secondary">
            {dateLine}
            {price ? ` · ${price}` : ''}
          </p>
        </div>
        <Pill tone={tone}>{MEMBERSHIP_STATUS_LABELS[m.status] ?? m.status}</Pill>
      </div>
      {m.benefits && m.benefits.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-border/60 pt-3">
          {m.benefits.map((b) => (
            <li key={b} className="flex items-start gap-2 text-xs text-text-secondary">
              <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
              <span className="min-w-0 break-words">{b}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function MembershipPanel({ memberships, businessName }: { memberships: HistoryMembership[]; businessName: string | null }) {
  if (memberships.length === 0) {
    return (
      <EmptyState
        icon={Award}
        title="No membership on file"
        description={`Ask ${businessName ?? 'us'} about a maintenance plan with priority scheduling and member pricing.`}
      />
    );
  }
  const current = memberships.filter((m) => m.status !== 'cancelled');
  const past = memberships.filter((m) => m.status === 'cancelled');
  return (
    <div className="space-y-4">
      {current.length > 0 && (
        <div className={CARD}>
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Current</h2>
          <ul className="space-y-3">{current.map((m) => <MembershipItem key={m.id} m={m} />)}</ul>
        </div>
      )}
      {past.length > 0 && (
        <div className={CARD}>
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Past</h2>
          <ul className="space-y-3">{past.map((m) => <MembershipItem key={m.id} m={m} />)}</ul>
        </div>
      )}
    </div>
  );
}

// ============================================================
// EQUIPMENT
// ============================================================

function EquipmentItem({ eq }: { eq: HistoryEquipment }) {
  const warranty = warrantyStatus(eq.warranty_expires_at);
  const next = nextServiceDue(eq);
  const now = Date.now();
  const nextTone: Tone = !next ? 'neutral' : next.getTime() < now ? 'danger' : next.getTime() - now <= 60 * 86400000 ? 'warn' : 'neutral';
  return (
    <li className="rounded-xl border border-border/60 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-text-primary">{equipmentTitle(eq)}</p>
          <p className="mt-0.5 text-xs text-text-secondary">{eq.equipment_type}</p>
        </div>
        {eq.status === 'replaced' ? (
          <Pill tone="neutral">Replaced</Pill>
        ) : (
          <Pill tone={warranty.tone === 'expired' ? 'danger' : warranty.tone === 'warn' ? 'warn' : 'success'}>
            <ShieldCheck size={11} aria-hidden="true" /> {warranty.label}
          </Pill>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-xs">
        <div>
          <dt className="text-text-secondary">Installed</dt>
          <dd className="font-medium text-text-primary">{formatHistoryDate(eq.install_date)}</dd>
        </div>
        <div>
          <dt className="text-text-secondary">Last serviced</dt>
          <dd className="font-medium text-text-primary">{formatHistoryDate(eq.last_service_date, 'Not yet')}</dd>
        </div>
        <div>
          <dt className="text-text-secondary">Services on record</dt>
          <dd className="font-medium text-text-primary">{eq.service_count}</dd>
        </div>
        {next && (
          <div>
            <dt className="text-text-secondary">Next service</dt>
            <dd className={`font-medium ${nextTone === 'danger' ? 'text-danger' : nextTone === 'warn' ? 'text-warning-500' : 'text-text-primary'}`}>
              {formatHistoryDate(next.toISOString())}
              {nextTone === 'danger' ? ' (overdue)' : nextTone === 'warn' ? ' (due soon)' : ''}
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}

function EquipmentPanel({ equipment }: { equipment: HistoryEquipment[] }) {
  if (equipment.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No equipment on file"
        description="Equipment we install or service for you will be tracked here with warranty and service dates."
      />
    );
  }
  return (
    <div className={CARD}>
      <ul className="space-y-3">{equipment.map((eq) => <EquipmentItem key={eq.id} eq={eq} />)}</ul>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function CustomerPortalHistoryPage() {
  const { token } = useParams<{ token: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [invoiceFilter, setInvoiceFilter] = useState<InvoiceFilter>('all');
  const requestId = useRef(0);
  const tabRefs = useRef<Partial<Record<TabKey, HTMLButtonElement | null>>>({});

  const rawTab = searchParams.get('tab');
  const tab: TabKey = TAB_KEYS.includes(rawTab as TabKey) ? (rawTab as TabKey) : 'services';

  const selectTab = useCallback(
    (next: TabKey) => {
      setSearchParams(next === 'services' ? {} : { tab: next }, { replace: true });
    },
    [setSearchParams],
  );

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setState({ kind: 'loading' });
    const result = await fetchPortalHistory(token);
    if (id !== requestId.current) return; // token changed or unmounted
    setState(result.status === 'ok' ? { kind: 'ready', data: result.data } : { kind: result.status });
  }, [token]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current++;
    };
  }, [load]);

  // Private, token-gated page: never indexable.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    const previousTitle = document.title;
    document.title = 'Service history';
    return () => {
      document.head.removeChild(meta);
      document.title = previousTitle;
    };
  }, []);

  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = TAB_KEYS.indexOf(tab);
    let nextIdx = idx;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % TAB_KEYS.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + TAB_KEYS.length) % TAB_KEYS.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = TAB_KEYS.length - 1;
    else return;
    e.preventDefault();
    const nextKey = TAB_KEYS[nextIdx];
    selectTab(nextKey);
    tabRefs.current[nextKey]?.focus();
  };

  const backHref = token ? `/portal/${token}` : '/';

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-8 sm:py-12">
        <div className="mx-auto w-full max-w-3xl">
          {state.kind === 'loading' && (
            <div role="status" aria-live="polite" className="space-y-6">
              <span className="sr-only">Loading your service history…</span>
              <SkeletonStatGrid count={4} />
              <SkeletonCardList count={3} rows={2} />
            </div>
          )}

          {state.kind === 'unavailable' && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" aria-hidden="true" />
              <h1 className="text-lg font-semibold text-text-primary">History not available</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                This link isn&apos;t valid, or the self-service portal isn&apos;t turned on for this business yet. Please call the
                business directly for help.
              </p>
            </div>
          )}

          {state.kind === 'error' && (
            <EmptyStateError
              icon={WifiOff}
              title="Couldn't load your history"
              description="Check your connection and try again. Your records are safe."
              onRetry={() => void load()}
            />
          )}

          {state.kind === 'ready' && (
            <ReadyView
              data={state.data}
              tab={tab}
              onTab={selectTab}
              onTabKeyDown={onTabKeyDown}
              tabRefs={tabRefs}
              invoiceFilter={invoiceFilter}
              onInvoiceFilter={setInvoiceFilter}
              backHref={backHref}
            />
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}

function ReadyView({
  data,
  tab,
  onTab,
  onTabKeyDown,
  tabRefs,
  invoiceFilter,
  onInvoiceFilter,
  backHref,
}: {
  data: PortalHistory;
  tab: TabKey;
  onTab: (t: TabKey) => void;
  onTabKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  tabRefs: MutableRefObject<Partial<Record<TabKey, HTMLButtonElement | null>>>;
  invoiceFilter: InvoiceFilter;
  onInvoiceFilter: (f: InvoiceFilter) => void;
  backHref: string;
}) {
  const { summary } = data;
  const firstName = data.customer.name.split(' ')[0];

  const tabs: { key: TabKey; label: string; icon: typeof Briefcase; count: number }[] = [
    { key: 'services', label: 'Services', icon: Briefcase, count: summary.total_services },
    { key: 'invoices', label: 'Invoices', icon: Receipt, count: summary.total_invoices },
    { key: 'membership', label: 'Membership', icon: Award, count: data.memberships.length },
    { key: 'equipment', label: 'Equipment', icon: ShieldCheck, count: data.equipment.length },
  ];

  return (
    <>
      <Link
        to={backHref}
        className="focus-ring mb-4 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={14} aria-hidden="true" /> Back to my account
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">Service history</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {firstName ? `${firstName}'s` : 'Your'} complete records with {data.business_name ?? 'us'}
        </p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Visits completed" value={String(summary.completed_visits)} />
        <StatTile label="Total paid" value={formatCents(summary.total_paid_cents)} />
        <StatTile
          label="Balance due"
          value={formatCents(summary.outstanding_cents)}
          tone={summary.outstanding_cents > 0 ? 'warn' : 'neutral'}
          hint={
            summary.outstanding_count > 0
              ? `${summary.outstanding_count} unpaid invoice${summary.outstanding_count === 1 ? '' : 's'}`
              : 'All paid up'
          }
        />
        <StatTile label="Customer since" value={formatHistoryDate(data.customer.customer_since)} />
      </div>

      {summary.outstanding_count > 0 && (
        <Button
          type="button"
          className="mb-6 w-full"
          onClick={() => {
            onInvoiceFilter('outstanding');
            onTab('invoices');
          }}
        >
          <CreditCard size={15} aria-hidden="true" /> Review unpaid invoices
        </Button>
      )}

      <div
        role="tablist"
        aria-label="History sections"
        onKeyDown={onTabKeyDown}
        className="mb-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1"
      >
        {tabs.map((t) => {
          const selected = tab === t.key;
          return (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[t.key] = el;
              }}
              id={`history-tab-${t.key}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`history-panel-${t.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTab(t.key)}
              className={`focus-ring flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium transition-colors ${
                selected ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <t.icon size={13} aria-hidden="true" />
              {t.label}
              <span className={`rounded-full px-1.5 text-[10px] ${selected ? 'bg-white/20' : 'bg-bg-tertiary'}`}>{t.count}</span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`history-panel-${tab}`} aria-labelledby={`history-tab-${tab}`} tabIndex={0} className="focus:outline-none">
        {tab === 'services' && <ServicesPanel services={data.services} total={summary.total_services} />}
        {tab === 'invoices' && <InvoicesPanel invoices={data.invoices} filter={invoiceFilter} onFilter={onInvoiceFilter} />}
        {tab === 'membership' && <MembershipPanel memberships={data.memberships} businessName={data.business_name} />}
        {tab === 'equipment' && <EquipmentPanel equipment={data.equipment} />}
      </div>
    </>
  );
}
