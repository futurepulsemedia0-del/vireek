import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handshake, Inbox, Lock, RefreshCw, Search, TriangleAlert as AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { IntakeCard } from '@/components/third-party-intake/IntakeCard';
import { IntakeActionDialog } from '@/components/third-party-intake/IntakeActionDialog';
import { PartnersPanel } from '@/components/third-party-intake/PartnersPanel';
import {
  describeIntakeError,
  filterIntakes,
  formatMoney,
  INTAKE_FILTERS,
  sortIntakes,
  summarizeIntakes,
  type ActionInput,
  type IntakeAction,
  type IntakeEvent,
  type IntakeFilter,
  type Payer,
  type ThirdPartyWorkOrder,
} from '@/lib/thirdPartyIntake';
import {
  actOnIntake,
  editIntake,
  fetchEvents,
  fetchIntakes,
  fetchPayers,
  fetchRawPayload,
} from '@/lib/thirdPartyIntakeApi';

type Tab = 'requests' | 'partners';
const CLOCK_MS = 30_000;
const REFRESH_MS = 120_000;

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="!p-4 sm:!p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1.5 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </Card>
  );
}

export function ThirdPartyIntakePage() {
  const { profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();

  // Scope every query to the ACCOUNT owner, never the signed-in team member.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_view_billing;
  const initializing = authLoading || profileLoading;

  const [tab, setTab] = useState<Tab>('requests');
  const [rows, setRows] = useState<ThirdPartyWorkOrder[]>([]);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [filter, setFilter] = useState<IntakeFilter>('attention');
  const [query, setQuery] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, IntakeEvent[]>>({});
  const [eventsFailed, setEventsFailed] = useState<Record<string, boolean>>({});
  const [raw, setRaw] = useState<Record<string, string | null>>({});
  const [dialog, setDialog] = useState<{ id: string; action: IntakeAction } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      if (!accountOwnerId || !canAccess) {
        setLoading(false);
        return;
      }
      const requestId = ++requestRef.current;
      if (!silent) {
        setLoading(true);
        setLoadFailed(false);
      }
      const [intakes, partnerList] = await Promise.allSettled([
        fetchIntakes(accountOwnerId),
        isOwner ? fetchPayers(accountOwnerId) : Promise.resolve([] as Payer[]),
      ]);
      if (requestId !== requestRef.current) return; // a newer load superseded this one
      if (intakes.status === 'fulfilled') {
        setRows(intakes.value);
        setLoadFailed(false);
      } else if (!silent) {
        setLoadFailed(true);
      }
      if (partnerList.status === 'fulfilled') setPayers(partnerList.value);
      setLoading(false);
    },
    [accountOwnerId, canAccess, isOwner],
  );

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  // SLA clocks tick every 30 s; data refreshes quietly every 2 min while the tab is visible.
  useEffect(() => {
    const clock = window.setInterval(() => setNowMs(Date.now()), CLOCK_MS);
    const refresh = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, REFRESH_MS);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(refresh);
    };
  }, [load]);

  const summary = useMemo(() => summarizeIntakes(rows, nowMs), [rows, nowMs]);
  const visible = useMemo(() => sortIntakes(filterIntakes(rows, filter, query, nowMs), nowMs), [rows, filter, query, nowMs]);

  const loadEvents = useCallback(async (id: string) => {
    setEventsFailed((p) => ({ ...p, [id]: false }));
    try {
      const list = await fetchEvents(id);
      setEvents((p) => ({ ...p, [id]: list }));
    } catch {
      setEventsFailed((p) => ({ ...p, [id]: true }));
    }
  }, []);

  const toggle = (id: string) => {
    const next = expandedId === id ? null : id;
    setExpandedId(next);
    if (next && events[next] === undefined) void loadEvents(next);
  };

  const loadRaw = async (id: string) => {
    try {
      const text = await fetchRawPayload(id);
      setRaw((p) => ({ ...p, [id]: text }));
    } catch {
      setRaw((p) => ({ ...p, [id]: 'Couldn’t load the original message.' }));
    }
  };

  const submitAction = async (action: IntakeAction, payload: { input: ActionInput } | { fields: Record<string, string> }) => {
    if (!dialog || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated =
        'fields' in payload
          ? await editIntake(dialog.id, payload.fields)
          : await actOnIntake(dialog.id, action as Exclude<IntakeAction, 'edit'>, payload.input);
      // Keep columns the RPC does not return in a different shape; replace by id.
      setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
      void loadEvents(dialog.id);
      toast('Saved', 'success');
      setDialog(null);
    } catch (e) {
      setActionError(describeIntakeError(e as { code?: string; message?: string }));
    } finally {
      setBusy(false);
    }
  };

  const dialogRow = dialog ? rows.find((r) => r.id === dialog.id) ?? null : null;
  const hasFilters = filter !== 'all' || query.trim() !== '';

  if (!canAccess && !initializing) {
    return (
      <DashboardLayout activeLabel="Third-Party Intake">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-lg font-semibold text-text-primary">You don&apos;t have access to this page</h1>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
            Partner jobs include pricing and billing details. Ask your account owner for the &quot;View Billing&quot; permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const accountMissing = !initializing && !accountOwnerId;

  return (
    <DashboardLayout activeLabel="Third-Party Intake">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Inbox size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-text-primary">Third-Party Intake</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Jobs sent by warranty, insurance and manufacturer partners by email or API, with response deadlines and approval steps.
            </p>
          </div>
        </div>

        {isOwner && (
          <div role="tablist" aria-label="Intake sections" className="mb-5 flex gap-2">
            {(['requests', 'partners'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`focus-ring min-h-[40px] rounded-xl px-4 text-sm font-medium transition-colors ${
                  tab === t ? 'bg-accent text-white' : 'border border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
                }`}
              >
                {t === 'requests' ? 'Requests' : 'Partners'}
              </button>
            ))}
          </div>
        )}

        {initializing || loading ? (
          <div className="space-y-6" aria-busy="true" aria-label="Loading third-party requests">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} rows={2} />
          </div>
        ) : accountMissing || loadFailed ? (
          <div role="alert" className="flex flex-col items-center rounded-2xl border border-danger/30 bg-danger/5 px-6 py-12 text-center">
            <AlertTriangle size={28} className="text-danger" aria-hidden="true" />
            <h2 className="mt-3 text-base font-semibold text-text-primary">We couldn&apos;t load your partner requests</h2>
            <p className="mt-1 max-w-sm text-sm text-text-secondary">
              {accountMissing ? 'Your account details are unavailable right now.' : 'Check your connection and try again.'}
            </p>
            <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => void load()}>
              <RefreshCw size={14} aria-hidden="true" /> Try again
            </Button>
          </div>
        ) : tab === 'partners' && isOwner && accountOwnerId ? (
          <PartnersPanel userId={accountOwnerId} payers={payers} inboundToken={profile?.inbound_email_token ?? null} onChange={setPayers} />
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <StatCard label="Need a response" value={String(summary.needsResponse)} hint="New requests" />
              <StatCard label="SLA at risk or missed" value={String(summary.atRisk + summary.breached)} hint={`${summary.breached} past deadline`} />
              <StatCard label="Awaiting authorization" value={String(summary.awaitingAuthorization)} hint={`${formatMoney(summary.openValueCents)} open value`} />
              <StatCard label="Answered on time" value={summary.onTimePct === null ? '—' : `${summary.onTimePct}%`} hint="Within the response SLA" />
            </div>

            {rows.length === 0 ? (
              <EmptyState
                icon={Handshake}
                title={payers.length === 0 ? 'Connect your first partner' : 'Waiting for the first request'}
                description={
                  payers.length === 0
                    ? isOwner
                      ? 'Add a warranty or insurance company to get an email address and API token they can send jobs to.'
                      : 'Ask the account owner to add a partner. Requests will appear here.'
                    : 'Requests sent to your partner email address or API appear here the moment they arrive.'
                }
                action={payers.length === 0 && isOwner ? { label: 'Add a partner', onClick: () => setTab('partners') } : undefined}
              />
            ) : (
              <>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:pb-0" role="group" aria-label="Filter requests">
                    {INTAKE_FILTERS.map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        aria-pressed={filter === f.key}
                        onClick={() => setFilter(f.key)}
                        className={`focus-ring min-h-[40px] shrink-0 rounded-full px-4 text-sm font-medium transition-colors ${
                          filter === f.key ? 'bg-accent text-white' : 'border border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <div className="sm:ml-auto sm:w-64">
                    <Input
                      icon={Search}
                      aria-label="Search requests"
                      placeholder="Search partner, claim, customer…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                </div>

                {visible.length === 0 ? (
                  <EmptyState
                    icon={Search}
                    title="No requests match"
                    description="Try another filter or clear the search."
                    action={hasFilters ? { label: 'Show everything', onClick: () => { setFilter('all'); setQuery(''); } } : undefined}
                  />
                ) : (
                  <ul className="space-y-3" aria-label="Partner requests">
                    {visible.map((row) => (
                      <li key={row.id}>
                        <IntakeCard
                          row={row}
                          nowMs={nowMs}
                          expanded={expandedId === row.id}
                          busy={busy && dialog?.id === row.id}
                          events={events[row.id]}
                          eventsError={Boolean(eventsFailed[row.id])}
                          rawPayload={raw[row.id]}
                          onToggle={() => toggle(row.id)}
                          onAction={(action) => { setActionError(null); setDialog({ id: row.id, action }); }}
                          onLoadRaw={() => void loadRaw(row.id)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <IntakeActionDialog
        row={dialogRow}
        action={dialog?.action ?? null}
        busy={busy}
        serverError={actionError}
        onCancel={() => { if (!busy) { setDialog(null); setActionError(null); } }}
        onSubmit={(action, payload) => void submitAction(action, payload)}
      />
    </DashboardLayout>
  );
}
