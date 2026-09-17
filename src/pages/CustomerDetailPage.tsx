import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Phone,
  Mail,
  MapPin,
  Wrench,
  Briefcase,
  PhoneCall,
  Plus,
  Trash2,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Customer } from '@/lib/supabase';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import {
  CustomerKnowledgeGraph,
  type GraphEquipment,
  type GraphJob,
  type GraphCall,
  type GraphLink,
} from '@/components/customers/CustomerKnowledgeGraph';
import { JobEquipmentLinker, type LinkedEquipment } from '@/components/customers/JobEquipmentLinker';

// ============================================================
// TYPES — narrow, query-shaped (not the full app-wide Job/Call
// interfaces) since this page only ever selects these columns.
// ============================================================

interface Equipment {
  id: string;
  user_id: string;
  customer_id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  install_date: string | null;
  install_job_id: string | null;
  warranty_expires_at: string | null;
  warranty_notes: string | null;
  status: 'active' | 'replaced' | 'removed';
  notes: string | null;
  created_at: string;
}

interface JobEquipmentLink {
  job_id: string;
  equipment_id: string;
  service_type: string;
}

interface JobRow {
  id: string;
  service_type: string | null;
  job_status: string;
  scheduled_datetime: string | null;
  invoice_status: string;
}

interface CallRow {
  id: string;
  summary: string | null;
  call_datetime: string;
  status: string;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
}

interface EquipmentDraft {
  equipment_type: string;
  make: string;
  model: string;
  serial_number: string;
  install_date: string;
  warranty_expires_at: string;
  warranty_notes: string;
  notes: string;
}

const EMPTY_EQUIPMENT_DRAFT: EquipmentDraft = {
  equipment_type: '',
  make: '',
  model: '',
  serial_number: '',
  install_date: '',
  warranty_expires_at: '',
  warranty_notes: '',
  notes: '',
};

const EQUIPMENT_TYPE_SUGGESTIONS = [
  'Furnace', 'Central AC', 'Heat Pump', 'Water Heater', 'Boiler',
  'Electrical Panel', 'Garage Door Opener', 'Sump Pump', 'Well Pump',
];

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ============================================================
// EQUIPMENT CARD
// ============================================================

function EquipmentCard({ eq, onDelete }: { eq: Equipment; onDelete: (eq: Equipment) => void }) {
  const warrantyDate = eq.warranty_expires_at ? new Date(eq.warranty_expires_at) : null;
  const underWarranty = warrantyDate ? warrantyDate.getTime() >= Date.now() : null;

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Wrench size={15} />
          </span>
          <div>
            <p className="text-sm font-semibold text-text-primary">
              {[eq.make, eq.model].filter(Boolean).join(' ') || eq.equipment_type}
            </p>
            <p className="text-xs text-text-secondary">{eq.equipment_type}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDelete(eq)}
          className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-danger"
          aria-label="Remove equipment"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-text-secondary">Serial</dt>
        <dd className="text-text-primary">{eq.serial_number || '—'}</dd>
        <dt className="text-text-secondary">Installed</dt>
        <dd className="text-text-primary">{formatDate(eq.install_date)}</dd>
      </dl>

      {warrantyDate && (
        <div
          className={`mt-3 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${
            underWarranty ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'
          }`}
        >
          {underWarranty ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
          {underWarranty ? `Under warranty until ${formatDate(eq.warranty_expires_at)}` : `Warranty expired ${formatDate(eq.warranty_expires_at)}`}
        </div>
      )}
      {eq.warranty_notes && <p className="mt-1.5 text-[11px] text-text-secondary/80">{eq.warranty_notes}</p>}
      {eq.status !== 'active' && (
        <span className="mt-2 inline-block rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
          {eq.status}
        </span>
      )}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [links, setLinks] = useState<JobEquipmentLink[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddEquipment, setShowAddEquipment] = useState(false);
  const [draft, setDraft] = useState<EquipmentDraft>(EMPTY_EQUIPMENT_DRAFT);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Equipment | null>(null);

  const fetchAll = useCallback(async () => {
    if (!id) return;
    setLoading(true);

    const { data: customerRow, error: customerError } = await supabase
      .from('customers')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (customerError || !customerRow) {
      toast('Could not load this customer', 'error');
      setLoading(false);
      return;
    }
    setCustomer(customerRow as Customer);

    const phone = (customerRow as Customer).phone;

    const [equipmentRes, jobsByIdRes, jobsByPhoneRes, callsByIdRes, callsByPhoneRes] = await Promise.all([
      supabase.from('equipment').select('*').eq('customer_id', id).order('created_at', { ascending: false }),
      supabase.from('jobs').select('id, service_type, job_status, scheduled_datetime, invoice_status').eq('customer_id', id),
      phone
        ? supabase.from('jobs').select('id, service_type, job_status, scheduled_datetime, invoice_status').eq('customer_phone', phone).is('customer_id', null)
        : Promise.resolve({ data: [] as JobRow[] }),
      supabase.from('calls').select('id, summary, call_datetime, status, sentiment').eq('customer_id', id),
      phone
        ? supabase.from('calls').select('id, summary, call_datetime, status, sentiment').eq('caller_phone', phone).is('customer_id', null)
        : Promise.resolve({ data: [] as CallRow[] }),
    ]);

    const mergedJobs = [...(jobsByIdRes.data ?? []), ...(jobsByPhoneRes.data ?? [])] as JobRow[];
    const mergedCalls = [...(callsByIdRes.data ?? []), ...(callsByPhoneRes.data ?? [])] as CallRow[];

    setEquipment((equipmentRes.data as Equipment[]) ?? []);
    setJobs(mergedJobs.sort((a, b) => (b.scheduled_datetime ?? '').localeCompare(a.scheduled_datetime ?? '')));
    setCalls(mergedCalls.sort((a, b) => b.call_datetime.localeCompare(a.call_datetime)));

    const jobIds = mergedJobs.map((j) => j.id);
    if (jobIds.length > 0) {
      const { data: linkRows } = await supabase.from('job_equipment').select('job_id, equipment_id, service_type').in('job_id', jobIds);
      setLinks((linkRows as JobEquipmentLink[]) ?? []);
    } else {
      setLinks([]);
    }

    setLoading(false);
  }, [id, toast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleAddEquipment = async () => {
    if (!user || !customer || !draft.equipment_type.trim()) {
      toast('Equipment type is required', 'error');
      return;
    }
    setSaving(true);

    const { error } = await supabase.from('equipment').insert({
      user_id: user.id,
      customer_id: customer.id,
      equipment_type: draft.equipment_type.trim(),
      make: draft.make.trim() || null,
      model: draft.model.trim() || null,
      serial_number: draft.serial_number.trim() || null,
      install_date: draft.install_date || null,
      warranty_expires_at: draft.warranty_expires_at || null,
      warranty_notes: draft.warranty_notes.trim() || null,
      notes: draft.notes.trim() || null,
    });

    setSaving(false);
    if (error) {
      toast('Could not save this equipment', 'error');
      return;
    }
    setDraft(EMPTY_EQUIPMENT_DRAFT);
    setShowAddEquipment(false);
    toast('Equipment added', 'success');
    fetchAll();
  };

  const handleDeleteEquipment = async () => {
    if (!deleteTarget) return;
    const { error } = await supabase.from('equipment').delete().eq('id', deleteTarget.id);
    if (error) {
      toast('Could not remove this equipment', 'error');
    } else {
      setEquipment((prev) => prev.filter((e) => e.id !== deleteTarget.id));
      toast('Equipment removed', 'success');
    }
    setDeleteTarget(null);
  };

  const graphData = useMemo(() => {
    const graphEquipment: GraphEquipment[] = equipment.map((e) => ({
      id: e.id,
      label: [e.make, e.model].filter(Boolean).join(' ') || e.equipment_type,
      status: e.status,
    }));
    const graphJobs: GraphJob[] = jobs.map((j) => ({
      id: j.id,
      label: `${j.service_type ?? 'Job'} — ${j.scheduled_datetime ? formatDate(j.scheduled_datetime) : 'unscheduled'}`,
      status: j.job_status,
    }));
    const graphCalls: GraphCall[] = calls.map((c) => ({
      id: c.id,
      label: `Call — ${formatDate(c.call_datetime)}`,
    }));
    const graphLinks: GraphLink[] = links.map((l) => ({ equipment_id: l.equipment_id, job_id: l.job_id, service_type: l.service_type }));
    return { graphEquipment, graphJobs, graphCalls, graphLinks };
  }, [equipment, jobs, calls, links]);

  const activeEquipmentOptions = useMemo(
    () =>
      equipment
        .filter((e) => e.status === 'active')
        .map((e) => ({ id: e.id, label: [e.make, e.model].filter(Boolean).join(' ') || e.equipment_type })),
    [equipment],
  );

  const linksByJob = useMemo(() => {
    const map: Record<string, LinkedEquipment[]> = {};
    links.forEach((l) => {
      const eq = equipment.find((e) => e.id === l.equipment_id);
      const label = eq ? [eq.make, eq.model].filter(Boolean).join(' ') || eq.equipment_type : 'Unit';
      (map[l.job_id] ||= []).push({ equipment_id: l.equipment_id, label, service_type: l.service_type });
    });
    return map;
  }, [links, equipment]);

  const handleJobEquipmentLinked = (jobId: string, link: LinkedEquipment) => {
    setLinks((prev) => [...prev, { job_id: jobId, equipment_id: link.equipment_id, service_type: link.service_type }]);
  };

  const handleJobEquipmentUnlinked = (jobId: string, equipmentId: string) => {
    setLinks((prev) => prev.filter((l) => !(l.job_id === jobId && l.equipment_id === equipmentId)));
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-5xl space-y-4 px-4 py-8 sm:px-6">
          <div className="h-10 w-48 animate-pulse rounded-lg bg-bg-tertiary" />
          <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />
          <div className="h-64 animate-pulse rounded-2xl bg-bg-tertiary" />
        </div>
      </DashboardLayout>
    );
  }

  if (!customer) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <EmptyState icon={Briefcase} title="Customer not found" description="It may have been deleted." />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <button
          onClick={() => navigate('/dashboard/customers')}
          className="focus-ring mb-4 flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary"
        >
          <ArrowLeft size={16} /> Back to customers
        </button>

        {/* Header */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">{customer.name}</h1>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-secondary">
              {customer.phone && (
                <span className="flex items-center gap-1.5">
                  <Phone size={13} /> {customer.phone}
                </span>
              )}
              {customer.email && (
                <span className="flex items-center gap-1.5">
                  <Mail size={13} /> {customer.email}
                </span>
              )}
              {customer.address && (
                <span className="flex items-center gap-1.5">
                  <MapPin size={13} /> {customer.address}
                </span>
              )}
            </div>
          </div>
          <span className="rounded-full bg-bg-tertiary px-3 py-1 text-xs font-medium capitalize text-text-secondary">
            {customer.lifecycle_stage} · {customer.customer_type}
          </span>
        </div>

        {/* Knowledge graph */}
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Knowledge graph</h2>
          <CustomerKnowledgeGraph
            customer={{ id: customer.id, name: customer.name }}
            equipment={graphData.graphEquipment}
            jobs={graphData.graphJobs}
            calls={graphData.graphCalls}
            links={graphData.graphLinks}
          />
        </div>

        {/* Equipment */}
        <div className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">Equipment</h2>
            <button
              type="button"
              onClick={() => setShowAddEquipment((v) => !v)}
              className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-accent/50 hover:text-accent"
            >
              <Plus size={13} /> Add equipment
            </button>
          </div>

          {showAddEquipment && (
            <div className="mb-4 rounded-xl border border-border bg-bg-primary p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <input
                  list="equipment-type-suggestions"
                  placeholder="Equipment type (e.g. Furnace)"
                  value={draft.equipment_type}
                  onChange={(e) => setDraft((d) => ({ ...d, equipment_type: e.target.value }))}
                  className="rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring"
                />
                <datalist id="equipment-type-suggestions">
                  {EQUIPMENT_TYPE_SUGGESTIONS.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <input
                  placeholder="Make"
                  value={draft.make}
                  onChange={(e) => setDraft((d) => ({ ...d, make: e.target.value }))}
                  className="rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring"
                />
                <input
                  placeholder="Model"
                  value={draft.model}
                  onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                  className="rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring"
                />
                <input
                  placeholder="Serial number"
                  value={draft.serial_number}
                  onChange={(e) => setDraft((d) => ({ ...d, serial_number: e.target.value }))}
                  className="rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring"
                />
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  Install date
                  <input
                    type="date"
                    value={draft.install_date}
                    onChange={(e) => setDraft((d) => ({ ...d, install_date: e.target.value }))}
                    className="flex-1 rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring"
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  Warranty until
                  <input
                    type="date"
                    value={draft.warranty_expires_at}
                    onChange={(e) => setDraft((d) => ({ ...d, warranty_expires_at: e.target.value }))}
                    className="flex-1 rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring"
                  />
                </label>
              </div>
              <textarea
                placeholder="Notes (optional)"
                value={draft.notes}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                rows={2}
                className="mt-3 w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddEquipment(false)}
                  className="focus-ring rounded-lg px-3 py-1.5 text-xs font-medium text-text-secondary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleAddEquipment}
                  disabled={saving}
                  className="focus-ring rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {saving ? 'Saving…' : 'Save equipment'}
                </button>
              </div>
            </div>
          )}

          {equipment.length === 0 ? (
            <EmptyState icon={Wrench} title="No equipment on file" description="Add the units this customer owns to track service history and warranty per unit." />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {equipment.map((eq) => (
                <EquipmentCard key={eq.id} eq={eq} onDelete={setDeleteTarget} />
              ))}
            </div>
          )}
        </div>

        {/* Jobs + Calls timelines */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <h2 className="mb-3 text-sm font-semibold text-text-primary">Job history</h2>
            {jobs.length === 0 ? (
              <EmptyState icon={Briefcase} title="No jobs yet" />
            ) : (
              <div className="space-y-2">
                {jobs.map((job) => (
                  <motion.div
                    key={job.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl border border-border bg-bg-secondary px-4 py-3"
                  >
                    <p className="text-sm font-medium text-text-primary">{job.service_type ?? 'Service call'}</p>
                    <p className="text-xs text-text-secondary">
                      {job.scheduled_datetime ? formatDateTime(job.scheduled_datetime) : 'Unscheduled'} · {job.job_status}
                    </p>
                    {user && (
                      <JobEquipmentLinker
                        jobId={job.id}
                        userId={user.id}
                        equipmentOptions={activeEquipmentOptions}
                        linkedEquipment={linksByJob[job.id] ?? []}
                        onLinked={(link) => handleJobEquipmentLinked(job.id, link)}
                        onUnlinked={(equipmentId) => handleJobEquipmentUnlinked(job.id, equipmentId)}
                      />
                    )}
                  </motion.div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-text-primary">Call history</h2>
            {calls.length === 0 ? (
              <EmptyState icon={PhoneCall} title="No calls yet" />
            ) : (
              <div className="space-y-2">
                {calls.map((call) => (
                  <motion.div
                    key={call.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl border border-border bg-bg-secondary px-4 py-3"
                  >
                    <p className="text-xs text-text-secondary">{formatDateTime(call.call_datetime)} · {call.status}</p>
                    {call.summary && <p className="mt-1 text-sm text-text-primary">{call.summary}</p>}
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Remove this equipment?"
        description={`This removes "${deleteTarget?.equipment_type ?? ''}" from ${customer.name}'s record. Job history is not affected.`}
        confirmLabel="Yes, remove it"
        onConfirm={handleDeleteEquipment}
        onCancel={() => setDeleteTarget(null)}
      />
    </DashboardLayout>
  );
}
