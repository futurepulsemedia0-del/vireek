import { useMemo, useState } from 'react';
import { ArrowLeft, Lock, Pencil, Plus, Search, Trash2, Truck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatMoney } from '@/lib/currency';
import { deleteVehicle, fetchFleetBundle, saveVehicle, type FleetBundle } from '@/lib/vehicleManagementApi';
import {
  VEHICLE_STATUSES, buildVehicleAlerts, formatMiles, humanize, summarizeFleet, vehicleTitle,
  type Vehicle, type VehicleAlerts, type VehiclePayload, type VehicleStatus,
} from '@/lib/vehicleManagement';
import { AssignmentTab } from '@/components/vehicles/AssignmentTab';
import { DocumentsTab } from '@/components/vehicles/DocumentsTab';
import { ExpensesTab } from '@/components/vehicles/ExpensesTab';
import { InspectionsTab } from '@/components/vehicles/InspectionsTab';
import { MaintenanceTab } from '@/components/vehicles/MaintenanceTab';
import { VehicleFormPanel } from '@/components/vehicles/VehicleFormPanel';
import { ErrorState, Pill, Stat, formatDate, useLoader, type Tone } from '@/components/vehicles/shared';

const EMPTY_BUNDLE: FleetBundle = { vehicles: [], technicians: [], schedules: [], documents: [] };

const TABS = [
  { id: 'assignment', label: 'Assignment' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'inspections', label: 'Inspections' },
  { id: 'documents', label: 'Documents' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const STATUS_TONE: Record<VehicleStatus, Tone> = { active: 'success', in_shop: 'warning', retired: 'neutral' };
type Filter = 'all' | 'attention' | VehicleStatus;

const ZERO_ALERTS: VehicleAlerts = { overdue: 0, dueSoon: 0, expired: 0, expiring: 0 };
const attentionCount = (a: VehicleAlerts) => a.overdue + a.dueSoon + a.expired + a.expiring;

function rank(v: Vehicle, a: VehicleAlerts): number {
  if (v.status === 'retired') return 3;
  if (a.overdue + a.expired > 0) return 0;
  return a.dueSoon + a.expiring > 0 ? 1 : 2;
}

export function VehiclesPage() {
  const { isOwner, permissions, profile, teamMember } = useAuth();
  const { toast } = useToast();
  const { currency } = useCurrency();

  // Fleet roster and costs are an account-management surface: owners and team managers only.
  const canAccess = isOwner || permissions.can_manage_team;
  // Team members read/write the OWNER's rows (RLS uses get_account_owner_id()).
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;

  const fleet = useLoader(
    () => (canAccess && accountOwnerId ? fetchFleetBundle() : Promise.resolve(EMPTY_BUNDLE)),
    `${accountOwnerId ?? 'none'}:${canAccess}`,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('assignment');
  const [formMode, setFormMode] = useState<null | 'create' | 'edit'>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Vehicle | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const bundle = fleet.data ?? EMPTY_BUNDLE;
  const { vehicles, technicians, schedules, documents } = bundle;

  const now = useMemo(() => new Date(), [fleet.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const alerts = useMemo(() => buildVehicleAlerts(vehicles, schedules, documents, now), [vehicles, schedules, documents, now]);
  const summary = useMemo(() => summarizeFleet(vehicles, alerts), [vehicles, alerts]);
  const techNames = useMemo(() => new Map(technicians.map((t) => [t.id, t.member_name?.trim() || t.member_email])), [technicians]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vehicles
      .filter((v) => {
        const a = alerts.get(v.id) ?? ZERO_ALERTS;
        if (filter === 'attention') { if (v.status === 'retired' || attentionCount(a) === 0) return false; }
        else if (filter !== 'all' && v.status !== filter) return false;
        if (!q) return true;
        const driver = v.assigned_technician_id ? techNames.get(v.assigned_technician_id) : null;
        return [v.label, v.make, v.model, v.license_plate, v.vin, driver].some((x) => x?.toLowerCase().includes(q));
      })
      .sort((a, b) => rank(a, alerts.get(a.id) ?? ZERO_ALERTS) - rank(b, alerts.get(b.id) ?? ZERO_ALERTS) || a.label.localeCompare(b.label));
  }, [vehicles, alerts, filter, search, techNames]);

  const selected = vehicles.find((v) => v.id === selectedId) ?? null;
  const selectedAlerts = selected ? alerts.get(selected.id) ?? ZERO_ALERTS : ZERO_ALERTS;

  const handleSave = async (payload: VehiclePayload) => {
    if (!accountOwnerId || saving) return;
    setSaving(true);
    try {
      const saved = await saveVehicle(accountOwnerId, payload, formMode === 'edit' && selected ? selected.id : undefined);
      toast(formMode === 'edit' ? 'Vehicle updated.' : 'Vehicle added.', 'success');
      setFormMode(null);
      setSelectedId(saved.id);
      await fleet.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the vehicle.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      await deleteVehicle(target.id);
      toast(`${target.label} deleted.`, 'success');
      if (selectedId === target.id) setSelectedId(null);
      await fleet.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the vehicle.', 'error');
    }
  };

  const select = (id: string) => { setSelectedId(id); setFormMode(null); };

  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null;
    if (next == null) return;
    e.preventDefault();
    const target = TABS[(next + TABS.length) % TABS.length];
    setTab(target.id);
    document.getElementById(`vehicle-tab-${target.id}`)?.focus();
  };

  // --- Permission gate -------------------------------------------------------
  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Vehicles">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Vehicle management is restricted. Ask your account owner to grant you the "Manage Team" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const header = (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Truck size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Vehicles</h1>
          <p className="text-sm text-text-secondary">Assignments, maintenance, costs, inspections and paperwork for every vehicle.</p>
        </div>
      </div>
      <Button size="sm" onClick={() => { setFormMode('create'); setSelectedId(null); }} disabled={formMode === 'create'}><Plus size={16} /> Add vehicle</Button>
    </div>
  );

  // --- Loading / error -------------------------------------------------------
  if (!accountOwnerId || (fleet.loading && !fleet.data)) {
    return (
      <DashboardLayout activeLabel="Vehicles">
        {header}
        <SkeletonStatGrid className="mb-6" />
        <SkeletonCardList count={4} rows={2} />
      </DashboardLayout>
    );
  }
  if (fleet.error && !fleet.data) {
    return <DashboardLayout activeLabel="Vehicles">{header}<ErrorState message={fleet.error} onRetry={fleet.reload} /></DashboardLayout>;
  }

  const money = (n: number) => formatMoney(n, currency);
  const showList = !selected || formMode === 'create';

  return (
    <DashboardLayout activeLabel="Vehicles">
      {header}

      {fleet.error && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span>Couldn't refresh: {fleet.error}</span>
          <Button size="sm" variant="ghost" onClick={fleet.reload}>Retry</Button>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Fleet" value={`${summary.active} active`} hint={`${summary.inShop} in shop · ${summary.retired} retired`} />
        <Stat label="Services overdue" value={summary.overdueServices} tone={summary.overdueServices ? 'danger' : 'success'} hint={`${summary.dueSoonServices} due soon`} />
        <Stat label="Documents expired" value={summary.expiredDocuments} tone={summary.expiredDocuments ? 'danger' : 'success'} hint={`${summary.expiringDocuments} expiring within 30 days`} />
        <Stat label="Unassigned" value={summary.unassigned} tone={summary.unassigned ? 'warning' : 'success'} hint="Active and in-shop vehicles" />
      </div>

      {formMode && (
        <div className="mb-6">
          <VehicleFormPanel
            key={formMode === 'edit' ? selected?.id : 'new'}
            vehicle={formMode === 'edit' ? selected ?? undefined : undefined}
            saving={saving}
            onSubmit={handleSave}
            onCancel={() => setFormMode(null)}
          />
        </div>
      )}

      {vehicles.length === 0 ? (
        formMode ? null : (
          <EmptyState icon={Truck} title="No vehicles yet" description="Add your first truck or van to track who drives it, when it needs service and what it costs." action={{ label: 'Add vehicle', onClick: () => setFormMode('create') }} />
        )
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
          <div className={showList ? '' : 'hidden lg:block'}>
            <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <Input label="Search" icon={Search} placeholder="Name, plate, VIN or driver" value={search} onChange={(e) => setSearch(e.target.value)} />
              <div>
                <label htmlFor="vehicle-filter" className="mb-1.5 block text-sm font-medium text-text-primary">Show</label>
                <select id="vehicle-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent">
                  <option value="all">All vehicles</option>
                  <option value="attention">Needs attention</option>
                  {VEHICLE_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                </select>
              </div>
            </div>

            {visible.length === 0 ? (
              <EmptyState icon={Search} title="No vehicles match" description="Try a different search or filter." action={{ label: 'Clear filters', onClick: () => { setSearch(''); setFilter('all'); } }} />
            ) : (
              <ul className="space-y-2" aria-label="Vehicles">
                {visible.map((v) => {
                  const a = alerts.get(v.id) ?? ZERO_ALERTS;
                  const driver = v.assigned_technician_id ? techNames.get(v.assigned_technician_id) ?? 'Assigned' : 'Unassigned';
                  const isSelected = v.id === selectedId;
                  return (
                    <li key={v.id}>
                      <button
                        type="button"
                        onClick={() => select(v.id)}
                        aria-current={isSelected ? 'true' : undefined}
                        className={`focus-ring w-full rounded-2xl border p-4 text-start transition-colors ${isSelected ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'}`}
                      >
                        <span className="flex items-start justify-between gap-2">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-text-primary">{v.label}</span>
                            <span className="block truncate text-xs text-text-secondary">{[vehicleTitle(v), v.license_plate].filter(Boolean).join(' · ') || '—'}</span>
                          </span>
                          <Pill tone={STATUS_TONE[v.status]}>{humanize(v.status)}</Pill>
                        </span>
                        <span className="mt-2 flex flex-wrap items-center justify-between gap-x-3 text-xs text-text-secondary">
                          <span className="truncate">{driver}</span>
                          <span>{formatMiles(v.odometer_miles)}</span>
                        </span>
                        {attentionCount(a) > 0 && v.status !== 'retired' && (
                          <span className="mt-2 flex flex-wrap gap-1.5">
                            {a.overdue > 0 && <Pill tone="danger">{a.overdue} overdue</Pill>}
                            {a.expired > 0 && <Pill tone="danger">{a.expired} expired doc{a.expired > 1 ? 's' : ''}</Pill>}
                            {a.dueSoon > 0 && <Pill tone="warning">{a.dueSoon} due soon</Pill>}
                            {a.expiring > 0 && <Pill tone="warning">{a.expiring} expiring</Pill>}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className={showList && !selected ? 'hidden lg:block' : formMode === 'create' ? 'hidden lg:block' : ''}>
            {!selected ? (
              <EmptyState icon={Truck} title="Select a vehicle" description="Pick a vehicle from the list to manage its driver, service schedule, costs, inspections and documents." />
            ) : (
              <div className="space-y-4">
                <div className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
                  <button type="button" onClick={() => setSelectedId(null)} className="focus-ring mb-3 inline-flex items-center gap-1.5 rounded-lg text-sm text-text-secondary hover:text-text-primary lg:hidden">
                    <ArrowLeft size={16} /> All vehicles
                  </button>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="break-words text-lg font-bold text-text-primary">{selected.label}</h2>
                        <Pill tone={STATUS_TONE[selected.status]}>{humanize(selected.status)}</Pill>
                      </div>
                      <p className="text-sm text-text-secondary">{vehicleTitle(selected) || 'No make or model set'}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setFormMode('edit')} disabled={formMode === 'edit'}><Pencil size={16} /> Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => setPendingDelete(selected)} aria-label={`Delete ${selected.label}`}><Trash2 size={16} /></Button>
                    </div>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                    {([
                      ['Odometer', formatMiles(selected.odometer_miles)],
                      ['Driver', selected.assigned_technician_id ? techNames.get(selected.assigned_technician_id) ?? 'Assigned' : 'Unassigned'],
                      ['Fuel', humanize(selected.fuel_type)],
                      ['Plate', selected.license_plate ?? '—'],
                      ['VIN', selected.vin ?? '—'],
                      ['Purchased', formatDate(selected.purchase_date)],
                      ['Monthly payment', money(selected.monthly_payment_cost)],
                      ['Monthly insurance', money(selected.monthly_insurance_cost)],
                    ] as const).map(([k, val]) => (
                      <div key={k} className="min-w-0">
                        <dt className="text-xs text-text-secondary">{k}</dt>
                        <dd className="break-words font-medium text-text-primary">{val}</dd>
                      </div>
                    ))}
                  </dl>
                  {selected.notes && <p className="mt-4 whitespace-pre-wrap break-words border-t border-border pt-3 text-sm text-text-secondary">{selected.notes}</p>}
                </div>

                <div role="tablist" aria-label="Vehicle sections" onKeyDown={onTabKey} className="flex gap-1 overflow-x-auto border-b border-border">
                  {TABS.map((t) => {
                    const badge = t.id === 'maintenance' ? selectedAlerts.overdue + selectedAlerts.dueSoon : t.id === 'documents' ? selectedAlerts.expired + selectedAlerts.expiring : 0;
                    const active = tab === t.id;
                    return (
                      <button
                        key={t.id}
                        id={`vehicle-tab-${t.id}`}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-controls={`vehicle-panel-${t.id}`}
                        tabIndex={active ? 0 : -1}
                        onClick={() => setTab(t.id)}
                        className={`focus-ring -mb-px inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-medium ${active ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
                      >
                        {t.label}
                        {badge > 0 && <span className="rounded-full bg-danger/10 px-1.5 text-xs text-danger">{badge}</span>}
                      </button>
                    );
                  })}
                </div>

                <div role="tabpanel" id={`vehicle-panel-${tab}`} aria-labelledby={`vehicle-tab-${tab}`}>
                  {tab === 'assignment' && <AssignmentTab key={selected.id} vehicle={selected} technicians={technicians} onChanged={fleet.reload} />}
                  {tab === 'maintenance' && <MaintenanceTab key={selected.id} vehicle={selected} schedules={schedules.filter((s) => s.vehicle_id === selected.id)} ownerId={accountOwnerId} onChanged={fleet.reload} />}
                  {tab === 'expenses' && <ExpensesTab key={selected.id} vehicle={selected} ownerId={accountOwnerId} onChanged={fleet.reload} />}
                  {tab === 'inspections' && <InspectionsTab key={selected.id} vehicle={selected} ownerId={accountOwnerId} onChanged={fleet.reload} />}
                  {tab === 'documents' && <DocumentsTab key={selected.id} vehicle={selected} documents={documents.filter((d) => d.vehicle_id === selected.id)} ownerId={accountOwnerId} onChanged={fleet.reload} />}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete ${pendingDelete?.label ?? 'this vehicle'}?`}
        description="This permanently removes the vehicle with its schedules, expenses, inspections, assignment history and documents. Job profitability history that references it is removed too."
        confirmPhrase="delete vehicle"
        confirmLabel="Delete vehicle"
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleDelete}
      />
    </DashboardLayout>
  );
}
