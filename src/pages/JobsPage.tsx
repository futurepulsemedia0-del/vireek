import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Search,
  X,
  Plus,
  Wrench,
  MapPin,
  Calendar,
  User as UserIcon,
  ChevronUp,
  ChevronDown,
  GripVertical,
  Check,
  FileText,
  Calculator,
  Trash2,
  LayoutGrid,
  List,
  Star,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { getRescheduleLink } from '@/lib/reschedule';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Job, TeamMember } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';
import { useRealtimeSubscription } from '@/lib/realtime';
import { LiveIndicator } from '@/components/LiveIndicator';

// ============================================================
// TYPES & CONSTANTS
// ============================================================

type JobStatus = Job['job_status'];
type InvoiceStatus = Job['invoice_status'];
type ViewMode = 'board' | 'list';
type SortKey = 'customer_name' | 'service_type' | 'scheduled_datetime' | 'job_status' | 'invoice_status';
type SortDir = 'asc' | 'desc';

const BOARD_STAGES: { key: JobStatus; label: string; dotColor: string; borderColor: string }[] = [
  { key: 'scheduled', label: 'Scheduled', dotColor: 'bg-accent', borderColor: 'border-t-accent' },
  { key: 'en_route', label: 'En Route', dotColor: 'bg-blue-500', borderColor: 'border-t-blue-500' },
  { key: 'in_progress', label: 'In Progress', dotColor: 'bg-warning-500', borderColor: 'border-t-warning-500' },
  { key: 'completed', label: 'Completed', dotColor: 'bg-success-500', borderColor: 'border-t-success-500' },
];

const ALL_STATUSES: { key: JobStatus; label: string; color: string }[] = [
  ...BOARD_STAGES.map((s) => ({ key: s.key, label: s.label, color: s.dotColor })),
  { key: 'cancelled', label: 'Cancelled', color: 'bg-danger' },
];

const INVOICE_CONFIG: Record<InvoiceStatus, { label: string; badge: string }> = {
  not_sent: { label: 'Not Sent', badge: 'bg-bg-tertiary text-text-secondary' },
  sent: { label: 'Sent', badge: 'bg-blue-500/10 text-blue-500' },
  paid: { label: 'Paid', badge: 'bg-success-500/10 text-success-500' },
};

const STATUS_STEPPER: JobStatus[] = ['scheduled', 'en_route', 'in_progress', 'completed'];

// ============================================================
// HELPERS
// ============================================================

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function formatCurrency(amount: number | null): string {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

// ============================================================
// SHARED UI
// ============================================================

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

function InvoiceBadge({ status }: { status: InvoiceStatus }) {
  const cfg = INVOICE_CONFIG[status];
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${cfg.badge}`}>
      {cfg.label}
    </span>
  );
}

function TechnicianAvatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' }) {
  const sz = size === 'md' ? 'h-10 w-10 text-sm' : 'h-7 w-7 text-xs';
  return (
    <span className={`flex ${sz} shrink-0 items-center justify-center rounded-full bg-accent/15 font-semibold text-accent`}>
      {initials(name)}
    </span>
  );
}

// ============================================================
// JOB CARD (Board)
// ============================================================

function JobCard({
  job,
  technician,
  onClick,
  onDragStart,
  onDragEnd,
  isDragging,
}: {
  job: Job;
  technician: TeamMember | null;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  isDragging: boolean;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={`group cursor-pointer rounded-xl border border-border bg-bg-primary p-3.5 shadow-sm transition-all hover:border-accent/40 hover:shadow-card ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-text-primary truncate">{job.customer_name}</p>
          {job.service_type && (
            <p className="mt-0.5 text-xs text-text-secondary truncate">{job.service_type}</p>
          )}
        </div>
        <GripVertical size={14} className="mt-0.5 shrink-0 text-text-secondary/40 opacity-0 group-hover:opacity-100" />
      </div>
      <div className="mt-2 space-y-1.5">
        {job.scheduled_datetime && (
          <p className="flex items-center gap-1.5 text-xs text-text-secondary">
            <Calendar size={11} /> {formatDateTime(job.scheduled_datetime)}
          </p>
        )}
        {job.address && (
          <p className="flex items-center gap-1.5 text-xs text-text-secondary truncate">
            <MapPin size={11} /> {job.address}
          </p>
        )}
      </div>
      <div className="mt-2.5 flex items-center justify-between">
        {technician ? (
          <div className="flex items-center gap-1.5">
            <TechnicianAvatar name={technician.member_name ?? technician.member_email} />
            <span className="text-xs text-text-secondary">{technician.member_name ?? technician.member_email}</span>
          </div>
        ) : (
          <span className="text-xs text-text-secondary/60">Unassigned</span>
        )}
        <InvoiceBadge status={job.invoice_status} />
      </div>
    </div>
  );
}

// ============================================================
// STATUS STEPPER
// ============================================================

function StatusStepper({
  currentStatus,
  onAdvance,
}: {
  currentStatus: JobStatus;
  onAdvance: (status: JobStatus) => void;
}) {
  const currentIndex = STATUS_STEPPER.indexOf(currentStatus);

  return (
    <div className="flex items-center gap-1">
      {STATUS_STEPPER.map((step, i) => {
        const isDone = currentIndex > i;
        const isCurrent = currentIndex === i;
        const isCancelled = currentStatus === 'cancelled';
        return (
          <div key={step} className="flex flex-1 flex-col items-center gap-1.5">
            <button
              type="button"
              onClick={() => onAdvance(step)}
              disabled={isCancelled}
              className={`focus-ring flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-all disabled:cursor-not-allowed ${
                isCancelled
                  ? 'bg-bg-tertiary text-text-secondary/40'
                  : isDone
                  ? 'bg-success-500 text-white'
                  : isCurrent
                  ? 'bg-accent text-white ring-4 ring-accent/20'
                  : 'bg-bg-tertiary text-text-secondary hover:bg-bg-tertiary/80'
              }`}
            >
              {isDone ? <Check size={14} /> : i + 1}
            </button>
            <span className={`text-[10px] font-medium capitalize ${isCurrent ? 'text-accent' : isDone ? 'text-success-500' : 'text-text-secondary/60'}`}>
              {step.replace('_', ' ')}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// JOB DETAIL PANEL
// ============================================================

function JobDetailPanel({
  job,
  technicians,
  onClose,
  onUpdateStatus,
  onUpdateTechnician,
  onUpdateInvoice,
  onDelete,
  onRequestReview,
}: {
  job: Job;
  technicians: TeamMember[];
  onClose: () => void;
  onUpdateStatus: (status: JobStatus) => void;
  onUpdateTechnician: (techId: string | null) => void;
  onUpdateInvoice: (amount: number | null, status: InvoiceStatus) => void;
  onDelete: () => void;
  onRequestReview: (job: Job) => void;
}) {
  const { toast } = useToast();
  const [invoiceAmount, setInvoiceAmount] = useState(job.invoice_amount?.toString() ?? '');
  const [invoiceStatus, setInvoiceStatus] = useState<InvoiceStatus>(job.invoice_status);
  const [editingInvoice, setEditingInvoice] = useState(false);
  const assignedTech = technicians.find((t) => t.id === job.assigned_technician_id) ?? null;

  const saveInvoice = () => {
    const parsed = invoiceAmount.trim() ? parseFloat(invoiceAmount) : null;
    setEditingInvoice(false);
    if (parsed !== job.invoice_amount || invoiceStatus !== job.invoice_status) {
      onUpdateInvoice(parsed, invoiceStatus);
    }
  };

  return (
    <motion.div
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="fixed right-0 top-0 z-50 h-full w-full max-w-md overflow-y-auto border-l border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg-secondary/95 px-6 py-4 backdrop-blur-md">
        <h2 className="text-base font-semibold text-text-primary">Job Details</h2>
        <button
          type="button"
          onClick={onClose}
          className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          aria-label="Close panel"
        >
          <X size={18} />
        </button>
      </div>

      <div className="px-6 py-5 space-y-5">
        {/* Customer */}
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Wrench size={22} />
            </span>
            <div>
              <h3 className="text-lg font-bold text-text-primary">{job.customer_name}</h3>
              {job.service_type && <p className="text-sm text-text-secondary">{job.service_type}</p>}
            </div>
          </div>
        </div>

        {/* Meta */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border bg-bg-primary p-3">
            <p className="text-xs text-text-secondary">Scheduled</p>
            <p className="mt-1 text-sm font-medium text-text-primary">{formatDateTime(job.scheduled_datetime)}</p>
          </div>
          <div className="rounded-xl border border-border bg-bg-primary p-3">
            <p className="text-xs text-text-secondary">Address</p>
            <p className="mt-1 text-sm font-medium text-text-primary truncate">{job.address || '—'}</p>
          </div>
          <div className="col-span-2 rounded-xl border border-border bg-bg-primary p-3">
            <p className="text-xs text-text-secondary">Customer Phone</p>
            <p className="mt-1 text-sm font-medium text-text-primary">{job.customer_phone || '— not on file —'}</p>
          </div>
        </div>

        {/* Technician assignment */}
        <div>
          <p className="mb-2 text-xs font-medium text-text-secondary">Assigned Technician</p>
          <div className="flex items-center gap-2">
            {assignedTech ? (
              <TechnicianAvatar name={assignedTech.member_name ?? assignedTech.member_email} size="md" />
            ) : (
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-tertiary text-text-secondary">
                <UserIcon size={18} />
              </span>
            )}
            <select
              value={job.assigned_technician_id ?? ''}
              onChange={(e) => onUpdateTechnician(e.target.value || null)}
              className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
            >
              <option value="">Unassigned</option>
              {technicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.member_name ?? t.member_email}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Status stepper */}
        <div>
          <p className="mb-3 text-xs font-medium text-text-secondary">Job Progress</p>
          <StatusStepper currentStatus={job.job_status} onAdvance={onUpdateStatus} />
          {job.job_status !== 'cancelled' && (
            <button
              type="button"
              onClick={() => onUpdateStatus('cancelled')}
              className="focus-ring mt-3 w-full rounded-lg border border-danger/30 py-2 text-xs font-medium text-danger transition-colors hover:bg-danger/5"
            >
              Cancel Job
            </button>
          )}
          {job.job_status === 'scheduled' && (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(getRescheduleLink(job.reschedule_token));
                toast('Reschedule link copied', 'success');
              }}
              className="focus-ring mt-2 w-full rounded-lg border border-border py-2 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              Copy self-reschedule link
            </button>
          )}
        </div>

        {/* Invoice card */}
        <div className="rounded-xl border border-border bg-bg-primary p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
              <FileText size={12} /> Invoice
            </p>
            {!editingInvoice && (
              <button
                type="button"
                onClick={() => setEditingInvoice(true)}
                className="focus-ring text-xs text-accent hover:underline"
              >
                Edit
              </button>
            )}
          </div>
          {editingInvoice ? (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-text-secondary">Amount</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-secondary">$</span>
                  <input
                    type="number"
                    step="0.01"
                    value={invoiceAmount}
                    onChange={(e) => setInvoiceAmount(e.target.value)}
                    placeholder="0.00"
                    className="focus-ring w-full rounded-lg border border-border bg-bg-secondary py-2 pl-7 pr-3 text-sm text-text-primary"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-text-secondary">Status</label>
                <select
                  value={invoiceStatus}
                  onChange={(e) => setInvoiceStatus(e.target.value as InvoiceStatus)}
                  className="focus-ring w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
                >
                  <option value="not_sent">Not Sent</option>
                  <option value="sent">Sent</option>
                  <option value="paid">Paid</option>
                </select>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveInvoice}
                  className="focus-ring rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInvoiceAmount(job.invoice_amount?.toString() ?? '');
                    setInvoiceStatus(job.invoice_status);
                    setEditingInvoice(false);
                  }}
                  className="focus-ring rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold text-text-primary">{formatCurrency(job.invoice_amount)}</p>
                <div className="mt-1"><InvoiceBadge status={job.invoice_status} /></div>
              </div>
              {job.invoice_amount != null && job.invoice_status !== 'paid' && (
                
                  href={`/dashboard/payments?job=${job.id}`}
                  className="focus-ring rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  Send Payment Request
                </a>
              )}
            </div>
          )}
        </div>

        <Link
          to={`/dashboard/profitability?job=${job.id}`}
          className="focus-ring flex items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm font-medium text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
        >
          <span className="flex items-center gap-2">
            <Calculator size={15} /> View profitability & costs
          </span>
          <span className="text-text-secondary">→</span>
        </Link>

        {/* Request a review — only once the job is actually done */}
        {job.job_status === 'completed' && (
          <div className="rounded-xl border border-accent/20 bg-accent/5 p-4">
            <p className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
              <Star size={12} /> Review Request
            </p>
            <p className="mt-1.5 text-sm text-text-primary">
              Text {job.customer_name.split(' ')[0]} a link to leave a Google review while the job is fresh.
            </p>
            <button
              type="button"
              onClick={() => onRequestReview(job)}
              disabled={!job.customer_phone}
              className="focus-ring mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Star size={16} /> Request a Review
            </button>
            {!job.customer_phone && (
              <p className="mt-1.5 text-xs text-danger">Add a customer phone number to enable this.</p>
            )}
          </div>
        )}

        {/* Delete */}
        <div className="border-t border-border pt-4">
          <button
            type="button"
            onClick={onDelete}
            className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm font-medium text-text-secondary transition-colors hover:border-danger/40 hover:text-danger"
          >
            <Trash2 size={16} />
            Delete Job
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================
// CREATE JOB MODAL
// ============================================================

interface PrefillData {
  customer_name?: string;
  service_type?: string;
  lead_id?: string;
  call_id?: string;
}

function CreateJobModal({
  technicians,
  prefill,
  onClose,
  onCreated,
}: {
  technicians: TeamMember[];
  prefill: PrefillData | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [customerName, setCustomerName] = useState(prefill?.customer_name ?? '');
  const [customerPhone, setCustomerPhone] = useState('');
  const [serviceType, setServiceType] = useState(prefill?.service_type ?? '');
  const [address, setAddress] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [technicianId, setTechnicianId] = useState('');
  const [customerType, setCustomerType] = useState<'residential' | 'commercial'>('residential');
  const [slaResponseHours, setSlaResponseHours] = useState('');
  const [contractReference, setContractReference] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerName.trim()) return;
    setSubmitting(true);
    try {
      const insert: Record<string, unknown> = {
        customer_name: customerName.trim(),
        customer_phone: customerPhone.trim() || null,
        service_type: serviceType.trim() || null,
        address: address.trim() || null,
        job_status: 'scheduled',
        invoice_status: 'not_sent',
        customer_type: customerType,
        sla_response_hours: customerType === 'commercial' && slaResponseHours ? Number(slaResponseHours) : null,
        contract_reference: customerType === 'commercial' && contractReference.trim() ? contractReference.trim() : null,
      };
      if (prefill?.lead_id) insert.lead_id = prefill.lead_id;
      if (prefill?.call_id) insert.call_id = prefill.call_id;
      if (scheduledDate) insert.scheduled_datetime = new Date(scheduledDate).toISOString();
      if (technicianId) insert.assigned_technician_id = technicianId;

      const { error } = await supabase.from('jobs').insert(insert);
      if (error) throw error;
      onCreated();
    } catch {
      // parent handles toast
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-lg rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold text-text-primary">Create Job</h2>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">Customer Name</label>
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="e.g. John Smith"
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">Customer Phone</label>
            <input
              type="tel"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              placeholder="e.g. +1 555 123 4567"
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary"
            />
            <p className="mt-1 text-xs text-text-secondary/70">Used to text the customer a review request once the job is done.</p>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">Service Type</label>
            <input
              type="text"
              value={serviceType}
              onChange={(e) => setServiceType(e.target.value)}
              placeholder="e.g. Plumbing repair"
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">Service Address</label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="e.g. 123 Main St, Springfield"
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-primary">Scheduled Date</label>
              <input
                type="datetime-local"
                value={scheduledDate}
                onChange={(e) => setScheduledDate(e.target.value)}
                className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-primary">Technician</label>
              <select
                value={technicianId}
                onChange={(e) => setTechnicianId(e.target.value)}
                className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary"
              >
                <option value="">Unassigned</option>
                {technicians.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.member_name ?? t.member_email}
                  </option>
                ))}
              </select>
            </div>
          </div>
                     <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">Customer Type</label>
            <select
              value={customerType}
              onChange={(e) => setCustomerType(e.target.value as 'residential' | 'commercial')}
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary"
            >
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
            </select>
          </div>
          {customerType === 'commercial' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-primary">SLA Response (hours)</label>
                <input
                  type="number"
                  min="0"
                  value={slaResponseHours}
                  onChange={(e) => setSlaResponseHours(e.target.value)}
                  placeholder="e.g. 4"
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-primary">Contract / PO Reference</label>
                <input
                  type="text"
                  value={contractReference}
                  onChange={(e) => setContractReference(e.target.value)}
                  placeholder="e.g. PO-10293"
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary"
                />
              </div>
            </div>
          )}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting || !customerName.trim()}
              className="focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl bg-cta px-4 py-3 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
            >
              <Wrench size={16} />
              {submitting ? 'Creating…' : 'Create Job'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="focus-ring rounded-xl border border-border px-4 py-3 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

// ============================================================
// MAIN JOBS PAGE
// ============================================================

export function JobsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, profile, profileLoading, isOwner, permissions, teamMember } = useAuth();
  const { toast } = useToast();

  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [technicians, setTechnicians] = useState<TeamMember[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [prefill, setPrefill] = useState<PrefillData | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('board');
  const [search, setSearch] = useState('');
  const [techFilter, setTechFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<JobStatus | 'all'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('scheduled_datetime');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<JobStatus | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  const canViewAll = isOwner || permissions.can_view_all_jobs;

  const loadData = useCallback(async () => {
    if (!user) return;
    setDataLoading(true);
    try {
      const [jobsRes, techRes] = await Promise.all([
        supabase.from('jobs').select('*').order('created_at', { ascending: false }),
        supabase.from('team_members').select('*').eq('role', 'technician').eq('invite_status', 'active'),
      ]);
      let jobs = (jobsRes.data as Job[]) ?? [];
      // Technicians without can_view_all_jobs only see jobs assigned to them
      if (!canViewAll && teamMember) {
        jobs = jobs.filter((j) => j.assigned_technician_id === teamMember.id);
      }
      setAllJobs(jobs);
      if (techRes.data) setTechnicians(techRes.data as TeamMember[]);
    } catch {
      // empty states
    } finally {
      setDataLoading(false);
    }
  }, [user, canViewAll, teamMember]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Realtime: a status change from another session (or an automated
  // process) reflects live for anyone else viewing the board. Filtered by
  // account owner id (jobs rows are keyed by the owner's id, not the
  // logged-in user's own id for team members), and a technician without
  // can_view_all_jobs never receives a row that isn't assigned to them.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const jobsLiveStatus = useRealtimeSubscription<Job>({
    channelName: `jobs-page-${accountOwnerId ?? 'anon'}`,
    table: 'jobs',
    event: '*',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: !!accountOwnerId,
    onChange: (payload) => {
      if (payload.eventType === 'INSERT') {
        const row = payload.new as Job;
        if (!canViewAll && teamMember && row.assigned_technician_id !== teamMember.id) return;
        setAllJobs((prev) => (prev.some((j) => j.id === row.id) ? prev : [row, ...prev]));
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new as Job;
        if (!canViewAll && teamMember && row.assigned_technician_id !== teamMember.id) {
          setAllJobs((prev) => prev.filter((j) => j.id !== row.id));
          return;
        }
        setAllJobs((prev) =>
          prev.some((j) => j.id === row.id)
            ? prev.map((j) => (j.id === row.id ? row : j))
            : [row, ...prev]
        );
        setSelectedJob((prev) => (prev?.id === row.id ? row : prev));
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old as Job;
        setAllJobs((prev) => prev.filter((j) => j.id !== row.id));
      }
    },
  });

  // Handle prefill from Leads page navigation
  useEffect(() => {
    const state = location.state as { prefill?: PrefillData } | null;
    if (state?.prefill) {
      setPrefill(state.prefill);
      setShowCreateModal(true);
      // Clear state so it doesn't re-open on refresh
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location, navigate]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  useKeyboardShortcut({
    key: '/',
    handler: () => searchRef.current?.focus(),
  });

  useKeyboardShortcut({
    key: 'Escape',
    handler: () => {
      if (showCreateModal) {
        setShowCreateModal(false);
      } else if (selectedJob) {
        setSelectedJob(null);
      } else if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    },
  });

  const techMap = useMemo(() => {
    const m = new Map<string, TeamMember>();
    technicians.forEach((t) => m.set(t.id, t));
    return m;
  }, [technicians]);

  const filteredJobs = useMemo(() => {
    let result = [...allJobs];
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (j) =>
          j.customer_name.toLowerCase().includes(q) ||
          (j.service_type?.toLowerCase().includes(q) ?? false) ||
          (j.address?.toLowerCase().includes(q) ?? false)
      );
    }
    if (techFilter !== 'all') {
      if (techFilter === 'unassigned') {
        result = result.filter((j) => !j.assigned_technician_id);
      } else {
        result = result.filter((j) => j.assigned_technician_id === techFilter);
      }
    }
    if (statusFilter !== 'all') {
      result = result.filter((j) => j.job_status === statusFilter);
    }
    return result;
  }, [allJobs, search, techFilter, statusFilter]);

  const sortedJobs = useMemo(() => {
    const result = [...filteredJobs];
    result.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'customer_name') cmp = a.customer_name.localeCompare(b.customer_name);
      else if (sortKey === 'service_type') cmp = (a.service_type ?? '').localeCompare(b.service_type ?? '');
      else if (sortKey === 'scheduled_datetime') {
        const av = a.scheduled_datetime ? new Date(a.scheduled_datetime).getTime() : Infinity;
        const bv = b.scheduled_datetime ? new Date(b.scheduled_datetime).getTime() : Infinity;
        cmp = av - bv;
      } else if (sortKey === 'job_status') cmp = a.job_status.localeCompare(b.job_status);
      else if (sortKey === 'invoice_status') cmp = a.invoice_status.localeCompare(b.invoice_status);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return result;
  }, [filteredJobs, sortKey, sortDir]);

  const jobsByStatus = useMemo(() => {
    const map: Record<JobStatus, Job[]> = {
      scheduled: [],
      en_route: [],
      in_progress: [],
      completed: [],
      cancelled: [],
    };
    filteredJobs.forEach((j) => {
      if (map[j.job_status]) map[j.job_status].push(j);
    });
    return map;
  }, [filteredJobs]);

  // Drag and drop
  const handleDragStart = (e: React.DragEvent, job: Job) => {
    setDraggingId(job.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', job.id);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverStage(null);
  };

  const handleDragOver = (e: React.DragEvent, status: JobStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverStage(status);
  };

  const handleDrop = async (e: React.DragEvent, status: JobStatus) => {
    e.preventDefault();
    const jobId = e.dataTransfer.getData('text/plain');
    setDraggingId(null);
    setDragOverStage(null);
    if (!jobId) return;
    const job = allJobs.find((j) => j.id === jobId);
    if (!job || job.job_status === status) return;
    await updateJobStatus(jobId, status);
  };

  // Mutations
  const updateJobStatus = async (jobId: string, status: JobStatus) => {
    try {
      const { error } = await supabase.from('jobs').update({ job_status: status }).eq('id', jobId);
      if (error) throw error;
      setAllJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, job_status: status } : j)));
      if (selectedJob?.id === jobId) {
        setSelectedJob((prev) => (prev ? { ...prev, job_status: status } : null));
      }
      toast(`Job moved to ${ALL_STATUSES.find((s) => s.key === status)?.label}.`, 'success');
    } catch {
      toast('Could not update job status.', 'error');
    }
  };

  const updateTechnician = async (techId: string | null) => {
    if (!selectedJob) return;
    try {
      const { error } = await supabase
        .from('jobs')
        .update({ assigned_technician_id: techId })
        .eq('id', selectedJob.id);
      if (error) throw error;
      setAllJobs((prev) =>
        prev.map((j) => (j.id === selectedJob.id ? { ...j, assigned_technician_id: techId } : j))
      );
      setSelectedJob((prev) => (prev ? { ...prev, assigned_technician_id: techId } : null));
      toast('Technician assigned.', 'success');
    } catch {
      toast('Could not assign technician.', 'error');
    }
  };

  const updateInvoice = async (amount: number | null, status: InvoiceStatus) => {
    if (!selectedJob) return;
    try {
      const { error } = await supabase
        .from('jobs')
        .update({ invoice_amount: amount, invoice_status: status })
        .eq('id', selectedJob.id);
      if (error) throw error;
      setAllJobs((prev) =>
        prev.map((j) =>
          j.id === selectedJob.id ? { ...j, invoice_amount: amount, invoice_status: status } : j
        )
      );
      setSelectedJob((prev) =>
        prev ? { ...prev, invoice_amount: amount, invoice_status: status } : null
      );
      toast('Invoice updated.', 'success');
    } catch {
      toast('Could not update invoice.', 'error');
    }
  };

  const requestReview = async (job: Job) => {
    if (!job.customer_phone) {
      toast('Add a phone number for this job before requesting a review.', 'error');
      return;
    }
    try {
      const { data: bp } = await supabase
        .from('business_profile')
        .select('google_review_url')
        .maybeSingle();
      const reviewUrl = (bp as { google_review_url: string | null } | null)?.google_review_url;
      if (!reviewUrl) {
        toast('Add your Google review link on the Business Profile page first.', 'error');
        navigate('/dashboard/business-profile');
        return;
      }

      const businessName = profile?.company_name || 'us';
      const firstName = job.customer_name.split(' ')[0];
      const message = `Hi ${firstName}, thanks for choosing ${businessName}! Mind leaving us a quick review? ${reviewUrl}`;
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const separator = isIOS ? '&' : '?';
      const smsHref = `sms:${job.customer_phone}${separator}body=${encodeURIComponent(message)}`;

      const { error } = await supabase.from('review_requests').insert({
        job_id: job.id,
        customer_name: job.customer_name,
        customer_phone: job.customer_phone,
        status: 'sent',
      });
      if (error) throw error;

      window.open(smsHref, '_self');
      toast('Review request text is ready to send.', 'success');
    } catch {
      toast('Could not create the review request. Please try again.', 'error');
    }
  };

  const handleDelete = async () => {
    if (!selectedJob) return;
    try {
      const { error } = await supabase.from('jobs').delete().eq('id', selectedJob.id);
      if (error) throw error;
      setAllJobs((prev) => prev.filter((j) => j.id !== selectedJob.id));
      setSelectedJob(null);
      toast('Job deleted.', 'success');
    } catch {
      toast('Could not delete job.', 'error');
    }
  };

  const handleJobCreated = () => {
    setShowCreateModal(false);
    if (prefill?.lead_id) {
      supabase.from('leads').update({ stage: 'won' }).eq('id', prefill.lead_id).then();
    }
    setPrefill(null);
    loadData();
    toast('Job created.', 'success');
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ChevronDown size={14} className="text-text-secondary/40" />;
    return sortDir === 'asc' ? <ChevronUp size={14} className="text-accent" /> : <ChevronDown size={14} className="text-accent" />;
  };

  const hasActiveFilters = search || techFilter !== 'all' || statusFilter !== 'all';

  return (
    <DashboardLayout activeLabel={canViewAll ? 'Jobs' : 'My Jobs'}>
      {/* Page header */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
              aria-label="Back to dashboard"
            >
              <ArrowLeft size={18} />
            </button>
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">{canViewAll ? 'Jobs' : 'My Jobs'}</h1>
                <LiveIndicator status={jobsLiveStatus} />
              </div>
              <p className="mt-1 text-sm text-text-secondary">{canViewAll ? 'Track every job from scheduled to paid.' : 'Your assigned jobs, from scheduled to paid.'}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* View toggle */}
            <div className="flex rounded-xl border border-border bg-bg-secondary p-1">
              <button
                type="button"
                onClick={() => setViewMode('board')}
                className={`focus-ring flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  viewMode === 'board' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <LayoutGrid size={15} /> Board
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`focus-ring flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  viewMode === 'list' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <List size={15} /> List
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setPrefill(null);
                setShowCreateModal(true);
              }}
              className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:brightness-110 hover:shadow-glow-cta"
            >
              <Plus size={16} /> Create Job
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search jobs…  (press /)"
              className="focus-ring w-full rounded-xl border border-border bg-bg-secondary py-2.5 pl-10 pr-4 text-sm text-text-primary placeholder:text-text-secondary/60"
            />
          </div>
          <div className="flex items-center gap-2">
            <select
              value={techFilter}
              onChange={(e) => setTechFilter(e.target.value)}
              className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary"
            >
              <option value="all">All technicians</option>
              <option value="unassigned">Unassigned</option>
              {technicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.member_name ?? t.member_email}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as JobStatus | 'all')}
              className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary"
            >
              <option value="all">All statuses</option>
              {ALL_STATUSES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setTechFilter('all');
                  setStatusFilter('all');
                }}
                className="focus-ring flex items-center gap-1.5 rounded-lg px-3 py-2.5 text-sm text-text-secondary transition-colors hover:text-text-primary"
              >
                <X size={14} /> Clear
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        {dataLoading ? (
          viewMode === 'board' ? (
            <div className="grid gap-4 lg:grid-cols-4">
              {BOARD_STAGES.map((s) => (
                <div key={s.key} className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
                  <SkeletonBlock className="h-5 w-24" />
                  <div className="mt-4 space-y-3">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <SkeletonBlock key={i} className="h-24 w-full" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 border-b border-border p-4 last:border-0">
                  <SkeletonBlock className="h-5 w-32" />
                  <SkeletonBlock className="h-5 w-24" />
                  <SkeletonBlock className="h-5 w-32" />
                  <SkeletonBlock className="h-5 flex-1" />
                  <SkeletonBlock className="h-5 w-20" />
                </div>
              ))}
            </div>
          )
        ) : filteredJobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
              <Wrench size={26} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">
              {hasActiveFilters ? 'No jobs match your filters' : 'No jobs yet'}
            </h3>
            <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
              {hasActiveFilters
                ? 'Try adjusting or clearing your filters to see more jobs.'
                : 'Create your first job to start tracking work from scheduled through to paid.'}
            </p>
            {!hasActiveFilters && (
              <button
                type="button"
                onClick={() => setShowCreateModal(true)}
                className="focus-ring mt-4 flex items-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
              >
                <Plus size={16} /> Create your first job
              </button>
            )}
          </div>
        ) : viewMode === 'board' ? (
          /* Board view - desktop */
          <div className="hidden lg:grid lg:grid-cols-4 lg:gap-4">
            {BOARD_STAGES.map((stage) => (
              <div
                key={stage.key}
                onDragOver={(e) => handleDragOver(e, stage.key)}
                onDragLeave={() => setDragOverStage(null)}
                onDrop={(e) => handleDrop(e, stage.key)}
                className={`rounded-2xl border-t-4 ${stage.borderColor} border-x border-b border-border bg-bg-secondary p-4 shadow-card transition-colors dark:shadow-card-dark ${
                  dragOverStage === stage.key ? 'ring-2 ring-accent/40' : ''
                }`}
              >
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${stage.dotColor}`} />
                    <h2 className="text-sm font-semibold text-text-primary">{stage.label}</h2>
                  </div>
                  <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">
                    {jobsByStatus[stage.key].length}
                  </span>
                </div>
                <div className="space-y-2.5 min-h-[100px]">
                  {jobsByStatus[stage.key].map((job) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      technician={techMap.get(job.assigned_technician_id ?? '') ?? null}
                      onClick={() => setSelectedJob(job)}
                      onDragStart={(e) => handleDragStart(e, job)}
                      onDragEnd={handleDragEnd}
                      isDragging={draggingId === job.id}
                    />
                  ))}
                  {jobsByStatus[stage.key].length === 0 && (
                    <p className="py-4 text-center text-xs text-text-secondary/50">Drop jobs here</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* Mobile board */}
        {viewMode === 'board' && !dataLoading && filteredJobs.length > 0 && (
          <div className="space-y-4 lg:hidden">
            {BOARD_STAGES.map((stage) => (
              <div key={stage.key} className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
                <div className="mb-3 flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${stage.dotColor}`} />
                  <h2 className="text-sm font-semibold text-text-primary">{stage.label}</h2>
                  <span className="ml-auto rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">
                    {jobsByStatus[stage.key].length}
                  </span>
                </div>
                <div className="space-y-2.5">
                  {jobsByStatus[stage.key].map((job) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      technician={techMap.get(job.assigned_technician_id ?? '') ?? null}
                      onClick={() => setSelectedJob(job)}
                      onDragStart={(e) => handleDragStart(e, job)}
                      onDragEnd={handleDragEnd}
                      isDragging={draggingId === job.id}
                    />
                  ))}
                  {jobsByStatus[stage.key].length === 0 && (
                    <p className="py-2 text-center text-xs text-text-secondary/50">No jobs</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* List view */}
        {viewMode === 'list' && !dataLoading && filteredJobs.length > 0 && (
          <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-border bg-bg-tertiary/50">
                  <th className="px-4 py-3 text-left">
                    <button
                      type="button"
                      onClick={() => handleSort('customer_name')}
                      className="focus-ring flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-text-primary"
                    >
                      Customer <SortIcon col="customer_name" />
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button
                      type="button"
                      onClick={() => handleSort('service_type')}
                      className="focus-ring flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-text-primary"
                    >
                      Service <SortIcon col="service_type" />
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button
                      type="button"
                      onClick={() => handleSort('scheduled_datetime')}
                      className="focus-ring flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-text-primary"
                    >
                      Scheduled <SortIcon col="scheduled_datetime" />
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-secondary">Technician</th>
                  <th className="px-4 py-3 text-left">
                    <button
                      type="button"
                      onClick={() => handleSort('job_status')}
                      className="focus-ring flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-text-primary"
                    >
                      Status <SortIcon col="job_status" />
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button
                      type="button"
                      onClick={() => handleSort('invoice_status')}
                      className="focus-ring flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-text-primary"
                    >
                      Invoice <SortIcon col="invoice_status" />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedJobs.map((job) => {
                  const tech = techMap.get(job.assigned_technician_id ?? '') ?? null;
                  return (
                    <tr
                      key={job.id}
                      onClick={() => setSelectedJob(job)}
                      className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-bg-tertiary/50"
                    >
                      <td className="px-4 py-3 text-sm font-medium text-text-primary whitespace-nowrap">
                        {job.customer_name}
                      </td>
                      <td className="px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                        {job.service_type || '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                        {formatDateTime(job.scheduled_datetime)}
                      </td>
                      <td className="px-4 py-3">
                        {tech ? (
                          <div className="flex items-center gap-2">
                            <TechnicianAvatar name={tech.member_name ?? tech.member_email} />
                            <span className="text-sm text-text-secondary">{tech.member_name ?? tech.member_email}</span>
                          </div>
                        ) : (
                          <span className="text-sm text-text-secondary/60">Unassigned</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${ALL_STATUSES.find((s) => s.key === job.job_status)?.color ?? 'bg-bg-tertiary'} text-white`}>
                          {ALL_STATUSES.find((s) => s.key === job.job_status)?.label ?? job.job_status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <InvoiceBadge status={job.invoice_status} />
                          {job.invoice_amount !== null && (
                            <span className="text-sm text-text-secondary">{formatCurrency(job.invoice_amount)}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      {/* Detail panel */}
      <AnimatePresence>
        {selectedJob && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm"
              onClick={() => setSelectedJob(null)}
            />
            <JobDetailPanel
              job={selectedJob}
              technicians={technicians}
              onClose={() => setSelectedJob(null)}
              onUpdateStatus={(s) => updateJobStatus(selectedJob.id, s)}
              onUpdateTechnician={updateTechnician}
              onUpdateInvoice={updateInvoice}
              onDelete={handleDelete}
              onRequestReview={requestReview}
            />
          </>
        )}
      </AnimatePresence>

      {/* Create job modal */}
      <AnimatePresence>
        {showCreateModal && (
          <CreateJobModal
            technicians={technicians}
            prefill={prefill}
            onClose={() => {
              setShowCreateModal(false);
              setPrefill(null);
            }}
            onCreated={handleJobCreated}
          />
        )}
      </AnimatePresence>
    </DashboardLayout>
  );
}
