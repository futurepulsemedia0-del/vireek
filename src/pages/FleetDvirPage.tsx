import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertOctagon, CheckCircle2, ClipboardCheck, ImageIcon, RefreshCw, Truck } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { DvirChecklistEditor } from '@/components/fleet/DvirChecklistEditor';
import { supabase } from '@/lib/supabase';
import {
  INSPECTION_TYPE_LABELS,
  STATUS_LABELS,
  errorMessage,
  faultTitle,
  fetchDvirVehicles,
  fetchOpenDvirFaults,
  fetchRecentInspections,
  resolveDefect,
  signedMediaUrl,
  type DvirFault,
  type DvirVehicle,
  type InspectionRow,
  type InspectionStatus,
} from '@/lib/dvir';

type Tab = 'defects' | 'history' | 'checklist';
const TABS: { id: Tab; label: string }[] = [
  { id: 'defects', label: 'Open defects' },
  { id: 'history', label: 'Inspection history' },
  { id: 'checklist', label: 'Checklist' },
];

const STATUS_STYLE: Record<InspectionStatus, string> = {
  satisfactory: 'bg-success-500/10 text-success-500',
  defects_noted: 'bg-warning-500/10 text-warning-500',
  unsafe: 'bg-danger/10 text-danger',
};
const SEVERITY_STYLE: Record<DvirFault['severity'], string> = {
  critical: 'bg-danger/10 text-danger',
  high: 'bg-warning-500/10 text-warning-500',
  medium: 'bg-bg-tertiary text-text-secondary',
  low: 'bg-bg-tertiary text-text-secondary',
};

const fmt = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function Tile({ label, value, tone }: { label: string; value: string | number; tone?: 'bad' | 'good' }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-1 text-lg font-bold ${tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success-500' : 'text-text-primary'}`}>{value}</p>
    </div>
  );
}

function DefectCard({ fault, vehicleLabel, onResolved }: { fault: DvirFault; vehicleLabel: string; onResolved: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<string[] | null>(null);

  const loadPhotos = async () => {
    const urls = await Promise.all(fault.photo_paths.map((p) => signedMediaUrl(p)));
    setPhotos(urls.filter((u): u is string => Boolean(u)));
  };

  const resolve = async () => {
    setBusy(true);
    try {
      const { stillBlocked } = await resolveDefect(fault.id, note);
      toast(stillBlocked ? 'Defect resolved — vehicle still has other blocking defects' : 'Defect resolved — vehicle cleared for dispatch', 'success');
      onResolved();
    } catch (e) {
      toast(errorMessage(e, 'Could not resolve the defect'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-text-primary">{vehicleLabel}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_STYLE[fault.severity]}`}>{fault.severity}</span>
        {fault.blocks_dispatch && (
          <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-danger">Blocks dispatch</span>
        )}
        <span className="ml-auto text-xs text-text-secondary">Reported {fmt(fault.first_seen_at)}</span>
      </div>
      <p className="mt-2 text-sm text-text-primary">{faultTitle(fault)}</p>

      {fault.photo_paths.length > 0 && (
        <div className="mt-2">
          {photos === null ? (
            <Button variant="ghost" size="sm" onClick={() => void loadPhotos()}>
              <ImageIcon size={14} /> View {fault.photo_paths.length} photo{fault.photo_paths.length === 1 ? '' : 's'}
            </Button>
          ) : (
            <div className="flex flex-wrap gap-2">
              {photos.map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer">
                  <img src={u} alt="Defect" className="h-20 w-20 rounded-lg border border-border object-cover" />
                </a>
              ))}
              {photos.length === 0 && <p className="text-xs text-text-secondary">Photos could not be loaded.</p>}
            </div>
          )}
        </div>
      )}

      {open ? (
        <div className="mt-3 space-y-2">
          <Textarea label="Repair / resolution note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Replaced front tires, verified at shop" />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || note.trim().length < 3} onClick={() => void resolve()}>
              {busy ? 'Saving…' : 'Mark resolved'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => setOpen(true)}>
          <CheckCircle2 size={14} /> Resolve
        </Button>
      )}
    </li>
  );
}

function HistoryRow({ row, vehicleLabel, techName }: { row: InspectionRow; vehicleLabel: string; techName: string }) {
  const [open, setOpen] = useState(false);
  const defects = row.results.filter((r) => r.result === 'defect');
  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-4">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="focus-ring flex w-full flex-wrap items-center gap-2 text-left">
        <span className="font-semibold text-text-primary">{vehicleLabel}</span>
        <span className="text-xs text-text-secondary">{INSPECTION_TYPE_LABELS[row.inspection_type]}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_STYLE[row.status]}`}>{STATUS_LABELS[row.status]}</span>
        <span className="ml-auto text-xs text-text-secondary">
          {fmt(row.created_at)} · {techName}
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-2 text-sm text-text-primary">
          <p className="text-xs text-text-secondary">
            Odometer {row.odometer_miles.toLocaleString()} mi
            {row.odometer_anomaly && <span className="ml-2 font-semibold text-warning-500">· lower than previous reading</span>} · Signed by {row.signed_name}
          </p>
          {defects.length === 0 && <p className="text-xs text-text-secondary">All items passed.</p>}
          <ul className="list-disc space-y-1 pl-5">
            {defects.map((d) => (
              <li key={d.key}>
                <strong>{d.label}</strong>: {d.note}
              </li>
            ))}
          </ul>
          {row.notes && <p className="rounded-lg bg-bg-tertiary p-2 text-xs text-text-secondary">{row.notes}</p>}
        </div>
      )}
    </li>
  );
}

export function FleetDvirPage() {
  const [tab, setTab] = useState<Tab>('defects');
  const [vehicles, setVehicles] = useState<DvirVehicle[]>([]);
  const [faults, setFaults] = useState<DvirFault[]>([]);
  const [inspections, setInspections] = useState<InspectionRow[]>([]);
  const [techNames, setTechNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [v, f, i] = await Promise.all([fetchDvirVehicles(), fetchOpenDvirFaults(), fetchRecentInspections(100)]);
      setVehicles(v);
      setFaults(f);
      setInspections(i);
      const { data } = await supabase.from('team_members').select('id, member_name');
      setTechNames(Object.fromEntries((data ?? []).map((t) => [t.id as string, (t.member_name as string | null) ?? 'Technician'])));
    } catch (e) {
      setError(errorMessage(e, 'Could not load DVIR data'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const labelOf = useMemo(() => Object.fromEntries(vehicles.map((v) => [v.id, v.label])), [vehicles]);
  const stats = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const outOfService = new Set(faults.filter((f) => f.blocks_dispatch).map((f) => f.vehicle_id));
    const todays = inspections.filter((i) => new Date(i.created_at) >= todayStart);
    const preToday = new Set(todays.filter((i) => i.inspection_type === 'pre_trip').map((i) => i.vehicle_id));
    return {
      outOfService: outOfService.size,
      openDefects: faults.length,
      today: todays.length,
      missingPre: vehicles.filter((v) => v.status === 'active' && !preToday.has(v.id)).length,
    };
  }, [faults, inspections, vehicles]);

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <ClipboardCheck size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Vehicle Inspections (DVIR)</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Pre-trip and post-trip reports from your technicians. Unsafe vehicles are flagged here and blocked from dispatch until resolved.
            </p>
          </div>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void load()} aria-label="Refresh">
            <RefreshCw size={16} />
          </Button>
        </div>

        {loading && (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {!loading && error && (
          <div role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
            {error}
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => void load()}>
              <RefreshCw size={14} /> Retry
            </Button>
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="Out of service" value={stats.outOfService} tone={stats.outOfService > 0 ? 'bad' : 'good'} />
              <Tile label="Open defects" value={stats.openDefects} />
              <Tile label="Inspections today" value={stats.today} />
              <Tile label="No pre-trip today" value={stats.missingPre} />
            </div>

            <div role="tablist" className="mb-4 flex gap-1 border-b border-border">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`focus-ring -mb-px border-b-2 px-4 py-2 text-sm font-medium ${
                    tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === 'defects' &&
              (faults.length === 0 ? (
                <EmptyState icon={AlertOctagon} title="No open defects" description="Every reported vehicle defect has been resolved." />
              ) : (
                <ul className="space-y-3">
                  {faults.map((f) => (
                    <DefectCard key={f.id} fault={f} vehicleLabel={labelOf[f.vehicle_id] ?? 'Vehicle'} onResolved={() => void load()} />
                  ))}
                </ul>
              ))}

            {tab === 'history' &&
              (inspections.length === 0 ? (
                <EmptyState icon={Truck} title="No inspections yet" description="Technicians submit them from /tech/dvir on their phone." />
              ) : (
                <ul className="space-y-3">
                  {inspections.map((r) => (
                    <HistoryRow key={r.id} row={r} vehicleLabel={labelOf[r.vehicle_id] ?? 'Vehicle'} techName={r.technician_id ? techNames[r.technician_id] ?? 'Technician' : 'Owner'} />
                  ))}
                </ul>
              ))}

            {tab === 'checklist' && <DvirChecklistEditor />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
