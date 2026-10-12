import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, Lock, Plus, RefreshCw, Search, TriangleAlert as AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { WorkOrderForm } from '@/components/work-orders/WorkOrderForm';
import { WorkOrderCard, type ApprovalDecision } from '@/components/work-orders/WorkOrderCard';
import {
  EMPTY_WORK_ORDER_FORM,
  filterWorkOrders,
  formatMoney,
  groupVisitsByOrder,
  STATUS_FILTERS,
  toVisitPayload,
  toWorkOrderPayload,
  workOrderToForm,
  type StatusFilter,
  type VisitFormValues,
  type WorkOrder,
  type WorkOrderStatus,
  type WorkOrderVisit,
} from '@/lib/workOrders';
import {
  createVisit,
  createWorkOrder,
  deleteVisit,
  deleteWorkOrder,
  fetchCommercialCustomers,
  fetchTechnicians,
  fetchVisits,
  fetchWorkOrders,
  updateVisit,
  updateWorkOrder,
  type CustomerOption,
  type TechnicianOption,
  type VisitPatch,
} from '@/lib/workOrdersApi';

type FormState = { mode: 'create' } | { mode: 'edit'; id: string } | null;
type Deleting = { kind: 'order'; workOrder: WorkOrder } | { kind: 'visit'; visit: WorkOrderVisit } | null;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

export function WorkOrdersPage() {
  const { profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();

  // Scope every query to the ACCOUNT owner, never the signed-in team member.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_view_billing;
  const initializing = authLoading || profileLoading;

  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [visits, setVisits] = useState<WorkOrderVisit[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [technicians, setTechnicians] = useState<TechnicianOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const [filter, setFilter] = useState<StatusFilter>('open');
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [orderBusyId, setOrderBusyId] = useState<string | null>(null);
  const [visitBusyId, setVisitBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Deleting>(null);

  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!accountOwnerId || !canAccess) {
      setLoading(false);
      return;
    }
    const requestId = ++requestRef.current;
    setLoading(true);
    setLoadFailed(false);
    const [orders, allVisits, customerList, techList] = await Promise.allSettled([
      fetchWorkOrders(accountOwnerId),
      fetchVisits(accountOwnerId),
      fetchCommercialCustomers(accountOwnerId),
      fetchTechnicians(accountOwnerId),
    ]);
    if (requestId !== requestRef.current) return; // a newer load superseded this one
    if (orders.status === 'rejected' || allVisits.status === 'rejected') {
      setLoadFailed(true);
    } else {
      setWorkOrders(orders.value);
      setVisits(allVisits.value);
    }
    // Customers and technicians only feed dropdowns; degrade gracefully.
    if (customerList.status === 'fulfilled') setCustomers(customerList.value);
    if (techList.status === 'fulfilled') setTechnicians(techList.value);
    setLoading(false);
  }, [accountOwnerId, canAccess]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const visitsByOrder = useMemo(() => groupVisitsByOrder(visits), [visits]);
  const customerNames = useMemo(
    () => Object.fromEntries(customers.map((c) => [c.id, c.name])) as Record<string, string>,
    [customers],
  );
  const filtered = useMemo(
    () => filterWorkOrders(workOrders, visitsByOrder, filter, query, customerNames),
    [workOrders, visitsByOrder, filter, query, customerNames],
  );

  const stats = useMemo(() => {
    let ready = 0;
    let outstanding = 0;
    for (const v of visits) {
      if (v.billing_status === 'ready_to_bill') ready += v.billable_amount_cents ?? 0;
      if (v.billing_status === 'invoiced') outstanding += v.billable_amount_cents ?? 0;
    }
    return {
      open: workOrders.filter((w) => w.status !== 'completed' && w.status !== 'cancelled').length,
      awaiting: workOrders.filter((w) => w.approval_status === 'pending').length,
      ready,
      outstanding,
    };
  }, [workOrders, visits]);

  // ---------- work order writes ----------

  const replaceOrder = (row: WorkOrder) => setWorkOrders((prev) => prev.map((w) => (w.id === row.id ? row : w)));

  const runOrderWrite = async (id: string, write: () => Promise<WorkOrder>, success: string): Promise<boolean> => {
    setOrderBusyId(id);
    try {
      replaceOrder(await write());
      toast(success, 'success');
      return true;
    } catch (e) {
      toast(messageOf(e), 'error');
      return false;
    } finally {
      setOrderBusyId(null);
    }
  };

  const handleSaveOrder = async (values: Parameters<typeof toWorkOrderPayload>[0]) => {
    if (!accountOwnerId || !form) return;
    setSaving(true);
    setFormError(null);
    try {
      const payload = toWorkOrderPayload(values);
      if (form.mode === 'edit') {
        // A blank number on edit means "keep the existing one", not "erase it".
        const { work_order_number, ...rest } = payload;
        const row = await updateWorkOrder(accountOwnerId, form.id, work_order_number ? { ...rest, work_order_number } : rest);
        replaceOrder(row);
        toast('Work order updated', 'success');
      } else {
        const row = await createWorkOrder(accountOwnerId, payload);
        setWorkOrders((prev) => [row, ...prev]);
        setExpandedId(row.id);
        setFilter((f) => (f === 'open' || f === 'all' ? f : 'all'));
        toast(`Created ${row.work_order_number ?? 'work order'}`, 'success');
      }
      setForm(null);
    } catch (e) {
      setFormError(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  const handleApproval = (wo: WorkOrder, decision: ApprovalDecision) =>
    runOrderWrite(wo.id, () => updateWorkOrder(accountOwnerId as string, wo.id, decision), 'Approval updated');

  const handleStatusChange = (wo: WorkOrder, status: WorkOrderStatus) =>
    status === wo.status
      ? Promise.resolve(true)
      : runOrderWrite(wo.id, () => updateWorkOrder(accountOwnerId as string, wo.id, { status }), 'Status updated');

  // ---------- visit writes ----------

  const handleCreateVisit = async (workOrderId: string, values: VisitFormValues): Promise<boolean> => {
    if (!accountOwnerId) return false;
    setVisitBusyId('new');
    try {
      const row = await createVisit(accountOwnerId, workOrderId, toVisitPayload(values));
      setVisits((prev) => [...prev, row]);
      toast(`Visit ${row.visit_number} added`, 'success');
      return true;
    } catch (e) {
      toast(messageOf(e), 'error');
      return false;
    } finally {
      setVisitBusyId(null);
    }
  };

  const handleUpdateVisit = async (visit: WorkOrderVisit, patch: VisitPatch): Promise<boolean> => {
    if (!accountOwnerId) return false;
    setVisitBusyId(visit.id);
    try {
      const row = await updateVisit(accountOwnerId, visit.id, patch);
      setVisits((prev) => prev.map((v) => (v.id === row.id ? row : v)));
      toast(`Visit ${row.visit_number} updated`, 'success');
      return true;
    } catch (e) {
      toast(messageOf(e), 'error');
      return false;
    } finally {
      setVisitBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!accountOwnerId || !deleting) return;
    try {
      if (deleting.kind === 'order') {
        await deleteWorkOrder(accountOwnerId, deleting.workOrder.id);
        setWorkOrders((prev) => prev.filter((w) => w.id !== deleting.workOrder.id));
        setVisits((prev) => prev.filter((v) => v.work_order_id !== deleting.workOrder.id));
        toast('Work order deleted', 'success');
      } else {
        await deleteVisit(accountOwnerId, deleting.visit.id);
        setVisits((prev) => prev.filter((v) => v.id !== deleting.visit.id));
        toast('Visit deleted', 'success');
      }
    } catch (e) {
      toast(messageOf(e), 'error');
    } finally {
      setDeleting(null);
    }
  };

  // ---------- render ----------

  if (!canAccess && !initializing) {
    return (
      <DashboardLayout activeLabel="Work Orders">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-lg font-semibold text-text-primary">You don&apos;t have access to this page</h1>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
            Work orders include billing details. Ask your account owner for the &quot;View Billing&quot; permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const editingOrder = form?.mode === 'edit' ? workOrders.find((w) => w.id === form.id) : undefined;
  const accountMissing = !initializing && !accountOwnerId;
  const hasFilters = filter !== 'all' || query.trim() !== '';

  return (
    <DashboardLayout activeLabel="Work Orders">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <ClipboardList size={20} aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Work Orders</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Commercial jobs with a PO, customer approval, multiple visits, and billing per visit.
              </p>
            </div>
          </div>
          {!form && canAccess && !loadFailed && !accountMissing && (
            <Button
              type="button"
              variant="primary"
              className="w-full sm:w-auto"
              onClick={() => {
                setFormError(null);
                setForm({ mode: 'create' });
              }}
            >
              <Plus size={16} aria-hidden="true" /> New work order
            </Button>
          )}
        </div>

        {form && (
          <div className="mb-6">
            <WorkOrderForm
              key={form.mode === 'edit' ? form.id : 'new'}
              initial={editingOrder ? workOrderToForm(editingOrder) : EMPTY_WORK_ORDER_FORM}
              customers={customers}
              isEdit={form.mode === 'edit'}
              saving={saving}
              serverError={formError}
              onSubmit={(values) => void handleSaveOrder(values)}
              onCancel={() => {
                setForm(null);
                setFormError(null);
              }}
            />
          </div>
        )}

        {initializing || loading ? (
          <div className="space-y-6" aria-busy="true" aria-label="Loading work orders">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} rows={1} />
          </div>
        ) : accountMissing || loadFailed ? (
          <div role="alert" className="flex flex-col items-center rounded-2xl border border-danger/30 bg-danger/5 px-6 py-12 text-center">
            <AlertTriangle size={28} className="text-danger" aria-hidden="true" />
            <h2 className="mt-3 text-base font-semibold text-text-primary">We couldn&apos;t load your work orders</h2>
            <p className="mt-1 max-w-sm text-sm text-text-secondary">
              {accountMissing ? 'Your account details are unavailable right now.' : 'Check your connection and try again.'}
            </p>
            <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => void load()}>
              <RefreshCw size={14} aria-hidden="true" /> Try again
            </Button>
          </div>
        ) : (
          <>
            <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Open work orders', value: String(stats.open) },
                { label: 'Awaiting approval', value: String(stats.awaiting), warn: stats.awaiting > 0 },
                { label: 'Ready to bill', value: formatMoney(stats.ready) },
                { label: 'Invoiced, unpaid', value: formatMoney(stats.outstanding) },
              ].map((s) => (
                <div key={s.label} className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                  <dd className={`text-2xl font-bold ${s.warn ? 'text-warning-500' : 'text-text-primary'}`}>{s.value}</dd>
                  <dt className="mt-1 text-xs text-text-secondary">{s.label}</dt>
                </div>
              ))}
            </dl>

            <div className="mb-4 space-y-3">
              <Input
                type="search"
                icon={Search}
                aria-label="Search work orders"
                placeholder="Search PO, work order, customer, site…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Filter work orders">
                {STATUS_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={filter === f.key}
                    onClick={() => setFilter(f.key)}
                    className={`focus-ring min-h-[40px] shrink-0 rounded-xl px-4 text-sm font-medium transition-colors ${
                      filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <p className="sr-only" aria-live="polite">
              {filtered.length} work order{filtered.length === 1 ? '' : 's'} shown
            </p>

            {workOrders.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="No work orders yet"
                description="Create your first commercial work order to track the PO, approval, visits, and billing in one place."
                action={{
                  label: 'New work order',
                  onClick: () => {
                    setFormError(null);
                    setForm({ mode: 'create' });
                  },
                }}
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={Search}
                title="No work orders match"
                description="Try a different search or filter."
                action={
                  hasFilters
                    ? {
                        label: 'Clear filters',
                        onClick: () => {
                          setQuery('');
                          setFilter('all');
                        },
                      }
                    : undefined
                }
              />
            ) : (
              <div className="space-y-3">
                {filtered.map((wo) => (
                  <WorkOrderCard
                    key={wo.id}
                    workOrder={wo}
                    visits={visitsByOrder[wo.id] ?? []}
                    customerName={wo.customer_id ? (customerNames[wo.customer_id] ?? null) : null}
                    technicians={technicians}
                    expanded={expandedId === wo.id}
                    busy={orderBusyId === wo.id}
                    visitBusyId={visitBusyId}
                    onToggle={() => setExpandedId((cur) => (cur === wo.id ? null : wo.id))}
                    onEdit={() => {
                      setFormError(null);
                      setForm({ mode: 'edit', id: wo.id });
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    onDelete={() => setDeleting({ kind: 'order', workOrder: wo })}
                    onApproval={(decision) => handleApproval(wo, decision)}
                    onStatusChange={(status) => handleStatusChange(wo, status)}
                    onCreateVisit={handleCreateVisit}
                    onUpdateVisit={handleUpdateVisit}
                    onDeleteVisit={(visit) => setDeleting({ kind: 'visit', visit })}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title={deleting?.kind === 'visit' ? 'Delete this visit?' : 'Delete this work order?'}
        description={
          deleting?.kind === 'visit'
            ? `Visit ${deleting.visit.visit_number} and its billing entry will be removed. This cannot be undone.`
            : 'The work order and all of its visits will be permanently removed. Work orders with invoiced or paid visits cannot be deleted.'
        }
        confirmPhrase={deleting?.kind === 'order' ? 'delete' : undefined}
        confirmLabel={deleting?.kind === 'visit' ? 'Delete visit' : 'Delete work order'}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </DashboardLayout>
  );
}
