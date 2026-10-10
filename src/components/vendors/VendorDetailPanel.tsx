/**
 * Vendor detail — one vendor, seven tabs. Lists are loaded per tab (so opening
 * a vendor stays fast) and every mutation refreshes both the tab and the
 * portfolio (risk scores / alerts) via `onChanged`.
 *
 * Procurement actions (RFQs, POs, receiving) and accounting actions (paying
 * bills) are NOT re-implemented here — the panel links to those pages.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  BookOpen,
  Check,
  ClipboardList,
  ExternalLink,
  FileText,
  Link2,
  Pencil,
  Plus,
  ShieldCheck,
  Star,
  Trash2,
  Truck,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  PO_STATUS_COLORS,
  PO_STATUS_LABELS,
  fetchVendorEvaluations,
  formatCents,
} from '@/lib/procurement';
import type { PurchaseOrder, VendorEvaluation } from '@/lib/procurement';
import {
  CONTRACT_TYPE_LABELS,
  DETAIL_TABS,
  DOC_TYPE_LABELS,
  INCIDENT_TYPE_LABELS,
  SEVERITY_LABELS,
  TIER_LABELS,
  TIER_OPTIONS,
  contractState,
  daysUntil,
  deleteVendorContract,
  deleteVendorDocument,
  documentState,
  evaluateRequiredDocuments,
  fetchVendorApBills,
  fetchVendorCatalog,
  fetchVendorContracts,
  fetchVendorDocuments,
  fetchVendorIncidents,
  fetchVendorJobBills,
  fetchVendorOrders,
  formatDay,
  formatPct,
  isHttpUrl,
  markVendorReviewed,
  setVendorActive,
  setVendorDocumentStatus,
  setVendorIncidentStatus,
  setVendorTier,
} from '@/lib/vendorManagement';
import type {
  ContractState,
  DocumentState,
  PriceInsight,
  RequiredDocState,
  VendorAlert,
  VendorContract,
  VendorDetailTab,
  VendorDocType,
  VendorDocument,
  VendorIncident,
  VendorInsight,
  VendorTier,
} from '@/lib/vendorManagement';
import { PerformanceBadge, Pill, RiskBadge, TierBadge } from './VendorBadges';
import {
  ContractModal,
  DocumentModal,
  EditVendorModal,
  EvaluationModal,
  IncidentModal,
  LinkInventoryModal,
  ResolveIncidentModal,
} from './VendorForms';

// ============================================================
// SMALL PIECES
// ============================================================

const panelCls = 'rounded-2xl border border-border bg-bg-secondary p-4';
const rowCls = 'flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary p-3';

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={panelCls}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'danger' | 'warning' }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning-500' : 'text-text-primary';
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-1 text-lg font-bold ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-xl" />
      ))}
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
      <span>Could not load this section.</span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** Loads data, ignores stale responses, and exposes reload. `key` re-runs the load. */
function useLoader<T>(load: () => Promise<T>, key: string) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: boolean }>({
    data: null,
    loading: true,
    error: false,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: false }));
    loadRef
      .current()
      .then((data) => {
        if (alive) setState({ data, loading: false, error: false });
      })
      .catch(() => {
        if (alive) setState((s) => ({ ...s, loading: false, error: true }));
      });
    return () => {
      alive = false;
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

function DocLink({ url }: { url: string | null }) {
  if (!url || !isHttpUrl(url)) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="focus-ring inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
    >
      Open <ExternalLink size={11} />
    </a>
  );
}

const CONTRACT_STATE_UI: Record<ContractState, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-bg-tertiary text-text-secondary' },
  active: { label: 'Active', cls: 'bg-success-500/10 text-success-500' },
  expiring: { label: 'Renewal window', cls: 'bg-warning-500/10 text-warning-500' },
  lapsed: { label: 'Past end date', cls: 'bg-danger/10 text-danger' },
  expired: { label: 'Expired', cls: 'bg-bg-tertiary text-text-secondary' },
  terminated: { label: 'Terminated', cls: 'bg-bg-tertiary text-text-secondary' },
};

const DOC_STATE_UI: Record<DocumentState, { label: string; cls: string }> = {
  expired: { label: 'Expired', cls: 'bg-danger/10 text-danger' },
  expiring: { label: 'Expiring soon', cls: 'bg-warning-500/10 text-warning-500' },
  valid: { label: 'Valid', cls: 'bg-success-500/10 text-success-500' },
  no_expiry: { label: 'No expiry', cls: 'bg-bg-tertiary text-text-secondary' },
  rejected: { label: 'Rejected', cls: 'bg-danger/10 text-danger' },
};

const REQUIRED_STATE_UI: Record<RequiredDocState, { label: string; cls: string }> = {
  ok: { label: 'Verified', cls: 'bg-success-500/10 text-success-500' },
  pending: { label: 'Awaiting verification', cls: 'bg-warning-500/10 text-warning-500' },
  expired: { label: 'Expired', cls: 'bg-danger/10 text-danger' },
  missing: { label: 'Missing', cls: 'bg-danger/10 text-danger' },
};

// ============================================================
// PANEL
// ============================================================

export interface VendorDetailPanelProps {
  insight: VendorInsight;
  alerts: VendorAlert[];
  priceInsights: PriceInsight[];
  vendorNames: Map<string, string>;
  linkedInventoryIds: string[];
  tab: VendorDetailTab;
  onTab: (tab: VendorDetailTab) => void;
  onBack: () => void;
  onChanged: () => void;
}

export function VendorDetailPanel(props: VendorDetailPanelProps) {
  const { insight, alerts, priceInsights, vendorNames, linkedInventoryIds, tab, onTab, onBack, onChanged } = props;
  const row = insight.row;
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [pendingTier, setPendingTier] = useState<VendorTier | null>(null);
  const [busy, setBusy] = useState(false);

  const orders = useLoader(() => fetchVendorOrders(row.vendor_id, 50), row.vendor_id);

  const act = async (fn: () => Promise<void>, ok: string, fail: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast(ok, 'success');
      onChanged();
    } catch {
      toast(fail, 'error');
    } finally {
      setBusy(false);
    }
  };

  const changeTier = (next: VendorTier) => {
    if (next === row.tier) return;
    if (next === 'blocked') {
      setPendingTier(next);
      return;
    }
    void act(() => setVendorTier(row.vendor_id, row.tier, next), `Tier set to ${TIER_LABELS[next]}`, 'Could not change the tier');
  };

  const orderList: PurchaseOrder[] = orders.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="focus-ring mb-2 inline-flex items-center gap-1 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            <ArrowLeft size={13} /> All vendors
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold text-text-primary">{row.name}</h2>
            <TierBadge tier={row.tier} />
            <RiskBadge level={insight.risk.level} score={insight.risk.score} />
            {!row.active && <Pill className="bg-bg-tertiary text-text-secondary">Inactive</Pill>}
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            {row.category ?? 'Uncategorized'}
            {row.payment_terms ? ` · ${row.payment_terms}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            <Pencil size={14} /> Edit
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setEvaluating(true)}>
            <Star size={14} /> Evaluate
          </Button>
          <Link
            to="/dashboard/procurement"
            className="focus-ring inline-flex min-h-[40px] items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/40 hover:bg-bg-tertiary"
          >
            <ClipboardList size={14} /> Procurement
          </Link>
        </div>
      </div>

      <div role="tablist" aria-label="Vendor sections" className="flex flex-wrap gap-1.5">
        {DETAIL_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => onTab(t.key)}
            className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium ${
              tab === t.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <OverviewTab
          insight={insight}
          alerts={alerts}
          busy={busy}
          onTab={onTab}
          onChangeTier={changeTier}
          onLink={() => setLinking(true)}
          onReviewed={() => void act(() => markVendorReviewed(row.vendor_id), 'Marked as reviewed', 'Could not update the review date')}
          onToggleActive={() =>
            void act(
              () => setVendorActive(row.vendor_id, !row.active),
              row.active ? 'Vendor deactivated' : 'Vendor reactivated',
              'Could not update the vendor',
            )
          }
        />
      )}
      {tab === 'performance' && <PerformanceTab insight={insight} onEvaluate={() => setEvaluating(true)} />}
      {tab === 'orders' && <OrdersTab insight={insight} orders={orders} />}
      {tab === 'pricing' && (
        <PricingTab insight={insight} priceInsights={priceInsights} vendorNames={vendorNames} onLink={() => setLinking(true)} />
      )}
      {tab === 'contracts' && <ContractsTab vendorId={row.vendor_id} onChanged={onChanged} />}
      {tab === 'compliance' && <ComplianceTab insight={insight} onChanged={onChanged} />}
      {tab === 'incidents' && <IncidentsTab vendorId={row.vendor_id} orders={orderList} onChanged={onChanged} />}

      {editing && <EditVendorModal vendor={row} onClose={() => setEditing(false)} onSaved={onChanged} />}
      {evaluating && (
        <EvaluationModal
          vendorId={row.vendor_id}
          vendorName={row.name}
          orders={orderList}
          onClose={() => setEvaluating(false)}
          onSaved={onChanged}
        />
      )}
      {linking && (
        <LinkInventoryModal vendor={row} linkedIds={linkedInventoryIds} onClose={() => setLinking(false)} onSaved={onChanged} />
      )}
      <ConfirmDialog
        open={pendingTier !== null}
        title={`Block ${row.name}?`}
        description="A blocked vendor is deactivated and cannot be invited to new RFQs. Open orders and bills stay visible. You can unblock them later."
        confirmLabel="Block vendor"
        onCancel={() => setPendingTier(null)}
        onConfirm={async () => {
          const next = pendingTier;
          setPendingTier(null);
          if (next) await act(() => setVendorTier(row.vendor_id, row.tier, next), 'Vendor blocked', 'Could not block this vendor');
        }}
      />
    </div>
  );
}

// ============================================================
// OVERVIEW
// ============================================================

function OverviewTab({
  insight,
  alerts,
  busy,
  onTab,
  onChangeTier,
  onLink,
  onReviewed,
  onToggleActive,
}: {
  insight: VendorInsight;
  alerts: VendorAlert[];
  busy: boolean;
  onTab: (t: VendorDetailTab) => void;
  onChangeTier: (t: VendorTier) => void;
  onLink: () => void;
  onReviewed: () => void;
  onToggleActive: () => void;
}) {
  const r = insight.row;
  const review = insight.reviewDaysLeft;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Spend (12 months)" value={formatCents(r.po_spend_12m_cents)} sub={`${formatPct(insight.spendShare)} of total`} />
        <Stat label="Open PO value" value={formatCents(r.open_po_cents)} sub={`${r.open_po_count} open`} />
        <Stat
          label="Payables"
          value={formatCents(insight.openPayablesCents)}
          sub={insight.overduePayablesCents > 0 ? `${formatCents(insight.overduePayablesCents)} overdue` : 'None overdue'}
          tone={insight.overduePayablesCents > 0 ? 'danger' : undefined}
        />
        <div className="rounded-xl border border-border bg-bg-primary p-3">
          <p className="text-xs text-text-secondary">Performance</p>
          <div className="mt-1.5">
            <PerformanceBadge performance={insight.performance} />
          </div>
        </div>
      </div>

      {alerts.length > 0 && (
        <Section title={`Needs attention (${alerts.length})`}>
          <ul className="space-y-2">
            {alerts.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onTab(a.tab)}
                  className={`${rowCls} focus-ring w-full text-left hover:border-accent/40`}
                >
                  <span>
                    <span className="block text-sm font-semibold text-text-primary">{a.title}</span>
                    <span className="block text-xs text-text-secondary">{a.detail}</span>
                  </span>
                  <Pill
                    className={
                      a.severity === 'critical'
                        ? 'bg-danger/10 text-danger'
                        : a.severity === 'warning'
                          ? 'bg-warning-500/10 text-warning-500'
                          : 'bg-bg-tertiary text-text-secondary'
                    }
                  >
                    {a.severity}
                  </Pill>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Contact">
          <dl className="space-y-2 text-sm">
            <Field label="Contact" value={r.contact_name} />
            <Field label="Email" value={r.email} href={r.email ? `mailto:${r.email}` : null} />
            <Field label="Phone" value={r.phone} href={r.phone ? `tel:${r.phone.replace(/[^\d+]/g, '')}` : null} />
            <Field label="Website" value={r.website} href={r.website && isHttpUrl(r.website) ? r.website : null} external />
            <Field label="Address" value={r.address} />
            {r.notes && <Field label="Notes" value={r.notes} />}
          </dl>
        </Section>

        <Section title="Relationship">
          <div className="space-y-3 text-sm">
            <div>
              <label htmlFor="vendor-tier" className="mb-1 block text-xs text-text-secondary">
                Tier
              </label>
              <select
                id="vendor-tier"
                value={r.tier}
                disabled={busy}
                onChange={(e) => onChangeTier(e.target.value as VendorTier)}
                className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-50"
              >
                {TIER_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {TIER_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-text-secondary">
                Last reviewed {r.last_reviewed_at ? formatDay(r.last_reviewed_at) : 'never'}
                <span className={`ml-1 text-xs ${review < 0 ? 'text-warning-500' : 'text-text-secondary'}`}>
                  ({review < 0 ? `${Math.abs(review)} days overdue` : `next in ${review} days`})
                </span>
              </span>
              <Button variant="secondary" size="sm" disabled={busy} onClick={onReviewed}>
                <Check size={14} /> Mark reviewed
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-text-secondary">
                {r.inventory_vendor_id ? 'Linked to Parts & Inventory' : 'Not linked to Parts & Inventory'}
              </span>
              <Button variant="secondary" size="sm" onClick={onLink}>
                <Link2 size={14} /> {r.inventory_vendor_id ? 'Change link' : 'Link'}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-text-secondary">
                {r.tier === 'blocked' ? 'Blocked vendors stay inactive' : r.active ? 'Active — can be invited to RFQs' : 'Inactive'}
              </span>
              <Button variant="ghost" size="sm" disabled={busy || r.tier === 'blocked'} onClick={onToggleActive}>
                {r.active ? 'Deactivate' : 'Reactivate'}
              </Button>
            </div>
            <div className="flex flex-wrap gap-3 border-t border-border pt-3 text-xs">
              <Link to="/dashboard/accounting" className="focus-ring inline-flex items-center gap-1 font-medium text-accent hover:underline">
                <BookOpen size={12} /> Pay bills in Accounting
              </Link>
              <Link to="/dashboard/inventory" className="focus-ring inline-flex items-center gap-1 font-medium text-accent hover:underline">
                <Truck size={12} /> Parts &amp; Inventory
              </Link>
            </div>
          </div>
        </Section>
      </div>

      <Section title={`Risk score ${insight.risk.score}/100`}>
        {insight.risk.factors.length === 0 ? (
          <p className="text-sm text-text-secondary">No risk factors detected for this vendor.</p>
        ) : (
          <ul className="space-y-2">
            {insight.risk.factors.map((f) => (
              <li key={f.key} className={rowCls}>
                <span>
                  <span className="block text-sm font-medium text-text-primary">{f.label}</span>
                  <span className="block text-xs text-text-secondary">{f.detail}</span>
                </span>
                <span className="text-xs font-semibold text-text-secondary">+{f.points}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Field({ label, value, href, external }: { label: string; value: string | null; href?: string | null; external?: boolean }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-text-secondary">{label}</dt>
      <dd className="min-w-0 break-words text-text-primary">
        {value ? (
          href ? (
            <a
              href={href}
              {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="focus-ring text-accent hover:underline"
            >
              {value}
            </a>
          ) : (
            value
          )
        ) : (
          <span className="text-text-secondary">—</span>
        )}
      </dd>
    </div>
  );
}

// ============================================================
// PERFORMANCE
// ============================================================

function PerformanceTab({ insight, onEvaluate }: { insight: VendorInsight; onEvaluate: () => void }) {
  const r = insight.row;
  const p = insight.performance;
  const evals = useLoader<VendorEvaluation[]>(() => fetchVendorEvaluations(r.vendor_id), `${r.vendor_id}:${r.eval_count}`);

  return (
    <div className="space-y-4">
      <Section
        title="Performance score"
        action={
          <Button variant="secondary" size="sm" onClick={onEvaluate}>
            <Star size={14} /> Add evaluation
          </Button>
        }
      >
        {p.score === null ? (
          <p className="text-sm text-text-secondary">
            Not enough data yet. The score appears once this vendor has a delivered purchase order, a received line, or an evaluation.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-3xl font-bold text-text-primary">{p.score}</span>
              <PerformanceBadge performance={p} />
            </div>
            <ul className="space-y-3">
              {p.components.map((c) => (
                <li key={c.key}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="font-medium text-text-primary">
                      {c.label} <span className="text-text-secondary">· weight {c.weight}% · {c.sample} measured</span>
                    </span>
                    <span className="text-text-secondary">{c.value}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-bg-tertiary">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${c.value}%` }} />
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-xs text-text-secondary">
              Small samples are smoothed so a single on-time delivery never reads as a perfect score.
            </p>
          </div>
        )}
      </Section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="On-time deliveries" value={formatPct(p.onTimeRate)} sub={`${r.delivery_on_time_count} of ${r.delivery_measured_count}`} />
        <Stat label="Receiving issues" value={formatPct(p.issueRate)} sub={`${r.receipt_issue_line_count} of ${r.receipt_line_count} lines`} />
        <Stat label="Avg. evaluation" value={r.avg_overall_score === null ? '—' : `${r.avg_overall_score.toFixed(1)} / 5`} sub={`${r.eval_count} evaluations`} />
        <Stat label="Incident cost (12 mo)" value={formatCents(r.incident_cost_12m_cents)} sub={`${r.incident_count_12m} incidents`} />
      </div>

      <Section title="Evaluation history">
        {evals.loading && !evals.data ? (
          <ListSkeleton />
        ) : evals.error ? (
          <LoadError onRetry={evals.reload} />
        ) : (evals.data ?? []).length === 0 ? (
          <EmptyState icon={Star} title="No evaluations yet" description="Rate this vendor after a delivery to build its track record." />
        ) : (
          <ul className="space-y-2">
            {(evals.data ?? []).map((e) => (
              <li key={e.id} className={rowCls}>
                <span className="text-sm text-text-primary">
                  {e.overall_score !== null ? `${Number(e.overall_score).toFixed(1)} / 5` : 'Unrated'}
                  <span className="ml-2 text-xs text-text-secondary">
                    {e.on_time === null ? '' : e.on_time ? 'On time' : 'Late'}
                    {e.quality_score ? ` · Quality ${e.quality_score}` : ''}
                    {e.price_score ? ` · Price ${e.price_score}` : ''}
                    {e.communication_score ? ` · Comms ${e.communication_score}` : ''}
                  </span>
                  {e.notes && <span className="mt-0.5 block text-xs text-text-secondary">{e.notes}</span>}
                </span>
                <span className="text-xs text-text-secondary">{formatDay(e.evaluated_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ============================================================
// ORDERS & BILLS
// ============================================================

function OrdersTab({
  insight,
  orders,
}: {
  insight: VendorInsight;
  orders: { data: PurchaseOrder[] | null; loading: boolean; error: boolean; reload: () => void };
}) {
  const r = insight.row;
  const ap = useLoader(() => fetchVendorApBills(r.vendor_id), r.vendor_id);
  const jobBills = useLoader(() => fetchVendorJobBills(r.name), `${r.vendor_id}:${r.name}`);
  const today = new Date();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Orders placed" value={String(r.po_count)} sub={r.last_order_at ? `Last ${formatDay(r.last_order_at)}` : 'None yet'} />
        <Stat label="Open orders" value={String(r.open_po_count)} sub={formatCents(r.open_po_cents)} tone={r.late_open_po_count > 0 ? 'warning' : undefined} />
        <Stat label="Open payables" value={formatCents(insight.openPayablesCents)} />
        <Stat
          label="Overdue payables"
          value={formatCents(insight.overduePayablesCents)}
          tone={insight.overduePayablesCents > 0 ? 'danger' : undefined}
        />
      </div>

      <Section
        title="Purchase orders"
        action={
          <Link to="/dashboard/procurement" className="focus-ring text-xs font-medium text-accent hover:underline">
            Manage in Procurement
          </Link>
        }
      >
        {orders.loading && !orders.data ? (
          <ListSkeleton />
        ) : orders.error ? (
          <LoadError onRetry={orders.reload} />
        ) : (orders.data ?? []).length === 0 ? (
          <EmptyState icon={Truck} title="No purchase orders yet" description="Orders placed with this vendor appear here." />
        ) : (
          <ul className="space-y-2">
            {(orders.data ?? []).map((po) => {
              const late =
                (po.status === 'sent' || po.status === 'partially_received') &&
                (daysUntil(po.expected_delivery_date, today) ?? 0) < 0;
              return (
                <li key={po.id} className={rowCls}>
                  <span>
                    <span className="block text-sm font-semibold text-text-primary">{po.po_number}</span>
                    <span className={`block text-xs ${late ? 'text-danger' : 'text-text-secondary'}`}>
                      {po.expected_delivery_date ? `Expected ${formatDay(po.expected_delivery_date)}` : `Created ${formatDay(po.created_at)}`}
                      {late ? ' · overdue' : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{formatCents(po.total_cents)}</span>
                    <Pill className={PO_STATUS_COLORS[po.status]}>{PO_STATUS_LABELS[po.status]}</Pill>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title="Bills (Accounting)"
        action={
          <Link to="/dashboard/accounting" className="focus-ring text-xs font-medium text-accent hover:underline">
            Open Accounting
          </Link>
        }
      >
        {ap.loading && !ap.data ? (
          <ListSkeleton rows={2} />
        ) : ap.error ? (
          <LoadError onRetry={ap.reload} />
        ) : (ap.data ?? []).length === 0 ? (
          <p className="text-sm text-text-secondary">No accounts-payable bills are linked to this vendor.</p>
        ) : (
          <ul className="space-y-2">
            {(ap.data ?? []).map((b) => {
              const balance = Math.max(0, b.total_cents - b.amount_paid_cents);
              const open = (b.status === 'approved' || b.status === 'partially_paid') && balance > 0;
              const overdue = open && (daysUntil(b.due_date, today) ?? 0) < 0;
              return (
                <li key={b.id} className={rowCls}>
                  <span>
                    <span className="block text-sm font-semibold text-text-primary">{b.bill_number}</span>
                    <span className={`block text-xs ${overdue ? 'text-danger' : 'text-text-secondary'}`}>
                      Due {formatDay(b.due_date)}
                      {overdue ? ' · overdue' : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-sm">
                    <span className="text-text-secondary">{open ? `${formatCents(balance)} due` : formatCents(b.total_cents)}</span>
                    <Pill className="bg-bg-tertiary text-text-secondary">{b.status.replace('_', ' ')}</Pill>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Job-cost bills">
        {jobBills.loading && !jobBills.data ? (
          <ListSkeleton rows={2} />
        ) : jobBills.error ? (
          <LoadError onRetry={jobBills.reload} />
        ) : (jobBills.data ?? []).length === 0 ? (
          <p className="text-sm text-text-secondary">No job-costing bills match this vendor&apos;s name.</p>
        ) : (
          <ul className="space-y-2">
            {(jobBills.data ?? []).map((b) => {
              const overdue = b.status === 'overdue' || (b.status === 'unpaid' && (daysUntil(b.due_date, today) ?? 0) < 0);
              return (
                <li key={b.id} className={rowCls}>
                  <span className="text-sm text-text-primary">
                    {b.bill_number ? `#${b.bill_number}` : 'Bill'}
                    <span className="ml-2 text-xs text-text-secondary">{formatDay(b.bill_date)}</span>
                  </span>
                  <span className="flex items-center gap-2 text-sm">
                    <span className="text-text-primary">{formatCents(b.amount_cents)}</span>
                    <Pill className={b.status === 'paid' ? 'bg-success-500/10 text-success-500' : overdue ? 'bg-danger/10 text-danger' : 'bg-bg-tertiary text-text-secondary'}>
                      {b.status === 'unpaid' && overdue ? 'overdue' : b.status}
                    </Pill>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ============================================================
// PRICING & CATALOG
// ============================================================

function PricingTab({
  insight,
  priceInsights,
  vendorNames,
  onLink,
}: {
  insight: VendorInsight;
  priceInsights: PriceInsight[];
  vendorNames: Map<string, string>;
  onLink: () => void;
}) {
  const r = insight.row;
  const linked = r.inventory_vendor_id !== null;
  const catalog = useLoader(() => (linked ? fetchVendorCatalog(r.vendor_id) : Promise.resolve([])), `${r.vendor_id}:${r.inventory_vendor_id ?? ''}`);
  const savings = priceInsights.reduce((s, p) => s + p.potentialSavingsCents, 0);

  return (
    <div className="space-y-4">
      <Section title="What this vendor charged on orders (last 24 months)">
        {priceInsights.length === 0 ? (
          <EmptyState icon={FileText} title="No priced orders yet" description="Item prices appear after purchase orders are placed with this vendor." />
        ) : (
          <>
            {savings > 0 && (
              <p className="mb-3 rounded-xl bg-warning-500/10 px-3 py-2 text-sm text-warning-500">
                Potential savings of {formatCents(savings)} on the latest orders if the cheaper vendors were used.
              </p>
            )}
            <ul className="space-y-2">
              {priceInsights.map((p) => (
                <li key={`${p.key}:${p.vendorId}`} className={rowCls}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-text-primary">{p.description}</span>
                    <span className="block text-xs text-text-secondary">
                      {p.orderCount} order{p.orderCount === 1 ? '' : 's'} · last {formatDay(p.lastOrderedAt)}
                      {p.premiumPct !== null && p.bestVendorId
                        ? ` · ${formatPct(p.premiumPct)} above ${vendorNames.get(p.bestVendorId) ?? 'the cheapest vendor'} (${formatCents(p.bestPriceCents)})`
                        : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-text-primary">{formatCents(p.latestCents)}</span>
                    {p.changePct !== null && p.trend !== 'flat' && (
                      <Pill className={p.trend === 'up' ? 'bg-danger/10 text-danger' : 'bg-success-500/10 text-success-500'}>
                        {p.trend === 'up' ? '▲' : '▼'} {formatPct(Math.abs(p.changePct), 1)}
                      </Pill>
                    )}
                    {p.trend === 'flat' && <Pill className="bg-bg-tertiary text-text-secondary">Stable</Pill>}
                    {p.trend === 'new' && <Pill className="bg-bg-tertiary text-text-secondary">First order</Pill>}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="Inventory catalog">
        {!linked ? (
          <EmptyState
            icon={Link2}
            title="Not linked to Parts & Inventory"
            description="Link this vendor to its inventory vendor to see the SKUs, costs and lead times you track in the parts catalog."
            action={{ label: 'Link inventory vendor', onClick: onLink }}
          />
        ) : catalog.loading && !catalog.data ? (
          <ListSkeleton />
        ) : catalog.error ? (
          <LoadError onRetry={catalog.reload} />
        ) : (catalog.data ?? []).length === 0 ? (
          <EmptyState icon={FileText} title="No catalog entries" description="Add this vendor to parts in Parts & Inventory to build its catalog." />
        ) : (
          <ul className="space-y-2">
            {(catalog.data ?? []).map((c) => {
              const premium =
                c.best_catalog_cost_cents !== null && c.best_catalog_cost_cents > 0 && c.unit_cost_cents > c.best_catalog_cost_cents
                  ? (c.unit_cost_cents - c.best_catalog_cost_cents) / c.best_catalog_cost_cents
                  : null;
              return (
                <li key={c.catalog_entry_id} className={rowCls}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-text-primary">
                      {c.part_name}
                      {c.is_preferred && <Pill className="ml-2 bg-accent/10 text-accent">Preferred</Pill>}
                    </span>
                    <span className="block text-xs text-text-secondary">
                      {c.part_number ? `Part ${c.part_number}` : ''}
                      {c.vendor_sku ? ` · SKU ${c.vendor_sku}` : ''}
                      {c.lead_time_days !== null ? ` · ${c.lead_time_days} day lead time` : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-text-primary">{formatCents(c.unit_cost_cents)}</span>
                    {premium !== null ? (
                      <Pill className="bg-warning-500/10 text-warning-500" title="Compared with the cheapest vendor for this part in your catalog">
                        {formatPct(premium)} above best
                      </Pill>
                    ) : (
                      <Pill className="bg-success-500/10 text-success-500">Best price</Pill>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ============================================================
// CONTRACTS
// ============================================================

function ContractsTab({ vendorId, onChanged }: { vendorId: string; onChanged: () => void }) {
  const { toast } = useToast();
  const list = useLoader(() => fetchVendorContracts(vendorId), vendorId);
  const [editing, setEditing] = useState<VendorContract | 'new' | null>(null);
  const [deleting, setDeleting] = useState<VendorContract | null>(null);
  const today = new Date();

  const refresh = () => {
    list.reload();
    onChanged();
  };

  return (
    <Section
      title="Contracts & agreements"
      action={
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus size={14} /> Add contract
        </Button>
      }
    >
      {list.loading && !list.data ? (
        <ListSkeleton />
      ) : list.error ? (
        <LoadError onRetry={list.reload} />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No contracts on file"
          description="Track supply agreements, pricing deals and rebates, with renewal alerts before they lapse."
          action={{ label: 'Add contract', onClick: () => setEditing('new') }}
        />
      ) : (
        <ul className="space-y-2">
          {(list.data ?? []).map((c) => {
            const state = contractState(c, today);
            const ui = CONTRACT_STATE_UI[state];
            const left = daysUntil(c.end_date, today);
            return (
              <li key={c.id} className={rowCls}>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-text-primary">
                    {c.title} <Pill className={ui.cls}>{ui.label}</Pill>
                  </span>
                  <span className="block text-xs text-text-secondary">
                    {CONTRACT_TYPE_LABELS[c.contract_type]}
                    {c.start_date || c.end_date ? ` · ${formatDay(c.start_date)} → ${formatDay(c.end_date)}` : ''}
                    {left !== null && left >= 0 && c.status === 'active' ? ` · ${left} days left` : ''}
                    {c.auto_renew ? ' · auto-renews' : ''}
                    {c.discount_percent !== null ? ` · ${c.discount_percent}% discount` : ''}
                    {c.value_cents !== null ? ` · ${formatCents(c.value_cents)}` : ''}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <DocLink url={c.document_url} />
                  <Button variant="ghost" size="sm" aria-label={`Edit ${c.title}`} onClick={() => setEditing(c)}>
                    <Pencil size={14} />
                  </Button>
                  <Button variant="ghost" size="sm" aria-label={`Delete ${c.title}`} onClick={() => setDeleting(c)}>
                    <Trash2 size={14} />
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <ContractModal
          vendorId={vendorId}
          contract={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this contract?"
        description={`"${deleting?.title ?? ''}" will be removed permanently. This cannot be undone.`}
        confirmLabel="Delete contract"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const target = deleting;
          setDeleting(null);
          if (!target) return;
          try {
            await deleteVendorContract(target.id);
            toast('Contract deleted', 'success');
            refresh();
          } catch {
            toast('Could not delete the contract', 'error');
          }
        }}
      />
    </Section>
  );
}

// ============================================================
// COMPLIANCE
// ============================================================

function ComplianceTab({ insight, onChanged }: { insight: VendorInsight; onChanged: () => void }) {
  const r = insight.row;
  const { toast } = useToast();
  const { teamMember } = useAuth();
  const list = useLoader(() => fetchVendorDocuments(r.vendor_id), r.vendor_id);
  const [editing, setEditing] = useState<{ doc: VendorDocument | null; type?: VendorDocType } | null>(null);
  const [deleting, setDeleting] = useState<VendorDocument | null>(null);
  const today = new Date();
  const docs = list.data ?? [];
  const required = evaluateRequiredDocuments(r.required_documents, docs, today);

  const refresh = () => {
    list.reload();
    onChanged();
  };

  const setStatus = async (d: VendorDocument, status: 'verified' | 'rejected' | 'pending') => {
    try {
      await setVendorDocumentStatus(d.id, status, teamMember?.id ?? null);
      toast(status === 'verified' ? 'Document verified' : status === 'rejected' ? 'Document rejected' : 'Document reopened', 'success');
      refresh();
    } catch {
      toast('Could not update the document', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Section title="Required documents">
        {r.required_documents.length === 0 ? (
          <p className="text-sm text-text-secondary">No documents are required for this vendor. Use Edit to choose which ones are.</p>
        ) : list.loading && !list.data ? (
          <ListSkeleton rows={2} />
        ) : (
          <ul className="space-y-2">
            {required.map((q) => {
              const ui = REQUIRED_STATE_UI[q.state];
              return (
                <li key={q.type} className={rowCls}>
                  <span className="text-sm font-medium text-text-primary">
                    {DOC_TYPE_LABELS[q.type as VendorDocType] ?? q.type} <Pill className={ui.cls}>{ui.label}</Pill>
                  </span>
                  {(q.state === 'missing' || q.state === 'expired') && (
                    <Button variant="secondary" size="sm" onClick={() => setEditing({ doc: null, type: q.type as VendorDocType })}>
                      <Plus size={14} /> Add
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title="All documents"
        action={
          <Button size="sm" onClick={() => setEditing({ doc: null })}>
            <Plus size={14} /> Add document
          </Button>
        }
      >
        {list.loading && !list.data ? (
          <ListSkeleton />
        ) : list.error ? (
          <LoadError onRetry={list.reload} />
        ) : docs.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No documents on file"
            description="Keep W-9s, insurance certificates and licences here, with expiry alerts."
            action={{ label: 'Add document', onClick: () => setEditing({ doc: null }) }}
          />
        ) : (
          <ul className="space-y-2">
            {docs.map((d) => {
              const state = documentState(d, today);
              const ui = DOC_STATE_UI[state];
              return (
                <li key={d.id} className={rowCls}>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-text-primary">
                      {DOC_TYPE_LABELS[d.doc_type]}
                      {d.title ? ` — ${d.title}` : ''} <Pill className={ui.cls}>{ui.label}</Pill>
                      {d.status === 'pending' && <Pill className="ml-1 bg-warning-500/10 text-warning-500">Unverified</Pill>}
                      {d.status === 'verified' && <Pill className="ml-1 bg-success-500/10 text-success-500">Verified</Pill>}
                    </span>
                    <span className="block text-xs text-text-secondary">
                      {d.expires_on ? `Expires ${formatDay(d.expires_on)}` : 'No expiry date'}
                      {d.verified_at ? ` · verified ${formatDay(d.verified_at)}` : ''}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1">
                    <DocLink url={d.document_url} />
                    {d.status !== 'verified' && (
                      <Button variant="ghost" size="sm" aria-label="Verify document" onClick={() => void setStatus(d, 'verified')}>
                        <Check size={14} />
                      </Button>
                    )}
                    {d.status !== 'rejected' && (
                      <Button variant="ghost" size="sm" aria-label="Reject document" onClick={() => void setStatus(d, 'rejected')}>
                        <X size={14} />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" aria-label="Edit document" onClick={() => setEditing({ doc: d })}>
                      <Pencil size={14} />
                    </Button>
                    <Button variant="ghost" size="sm" aria-label="Delete document" onClick={() => setDeleting(d)}>
                      <Trash2 size={14} />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {editing && (
        <DocumentModal
          vendorId={r.vendor_id}
          document={editing.doc}
          defaultType={editing.type}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this document?"
        description="The record is removed permanently. The file itself (if linked) is not touched."
        confirmLabel="Delete document"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const target = deleting;
          setDeleting(null);
          if (!target) return;
          try {
            await deleteVendorDocument(target.id);
            toast('Document deleted', 'success');
            refresh();
          } catch {
            toast('Could not delete the document', 'error');
          }
        }}
      />
    </div>
  );
}

// ============================================================
// INCIDENTS
// ============================================================

const SEVERITY_CLASS: Record<1 | 2 | 3, string> = {
  1: 'bg-bg-tertiary text-text-secondary',
  2: 'bg-warning-500/10 text-warning-500',
  3: 'bg-danger/10 text-danger',
};

function IncidentsTab({ vendorId, orders, onChanged }: { vendorId: string; orders: PurchaseOrder[]; onChanged: () => void }) {
  const { toast } = useToast();
  const list = useLoader(() => fetchVendorIncidents(vendorId), vendorId);
  const [logging, setLogging] = useState(false);
  const [resolving, setResolving] = useState<VendorIncident | null>(null);

  const refresh = () => {
    list.reload();
    onChanged();
  };

  const reopen = async (i: VendorIncident) => {
    try {
      await setVendorIncidentStatus(i.id, 'open');
      toast('Incident reopened', 'success');
      refresh();
    } catch {
      toast('Could not reopen the incident', 'error');
    }
  };

  return (
    <Section
      title="Incidents"
      action={
        <Button size="sm" onClick={() => setLogging(true)}>
          <Plus size={14} /> Log incident
        </Button>
      }
    >
      {list.loading && !list.data ? (
        <ListSkeleton />
      ) : list.error ? (
        <LoadError onRetry={list.reload} />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No incidents logged"
          description="Record late deliveries, quality problems and billing disputes so they count toward this vendor's risk."
          action={{ label: 'Log incident', onClick: () => setLogging(true) }}
        />
      ) : (
        <ul className="space-y-2">
          {(list.data ?? []).map((i) => (
            <li key={i.id} className={rowCls}>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-text-primary">
                  {INCIDENT_TYPE_LABELS[i.incident_type]} <Pill className={SEVERITY_CLASS[i.severity]}>{SEVERITY_LABELS[i.severity]}</Pill>
                  {i.status === 'resolved' && <Pill className="ml-1 bg-success-500/10 text-success-500">Resolved</Pill>}
                </span>
                <span className="block text-sm text-text-primary">{i.summary}</span>
                <span className="block text-xs text-text-secondary">
                  {formatDay(i.occurred_on)}
                  {i.cost_impact_cents > 0 ? ` · cost impact ${formatCents(i.cost_impact_cents)}` : ''}
                  {i.resolution_notes ? ` · ${i.resolution_notes}` : ''}
                </span>
              </span>
              {i.status === 'open' ? (
                <Button variant="secondary" size="sm" onClick={() => setResolving(i)}>
                  <Check size={14} /> Resolve
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => void reopen(i)}>
                  Reopen
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {logging && <IncidentModal vendorId={vendorId} orders={orders} onClose={() => setLogging(false)} onSaved={refresh} />}
      {resolving && <ResolveIncidentModal incident={resolving} onClose={() => setResolving(null)} onSaved={refresh} />}
    </Section>
  );
}
