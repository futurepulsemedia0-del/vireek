import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  FileSignature,
  Plus,
  Trash2,
  Pencil,
  X,
  Check,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Download,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase, CommercialContract, ContractSlaBreach, Customer } from '@/lib/supabase';
import { downloadContractPdf } from '@/lib/pdf';
import {
  ContractType,
  ContractStatus,
  BillingFrequency,
  BreachType,
  BreachSeverity,
  CONTRACT_TYPE_LABELS,
  CONTRACT_TYPE_OPTIONS,
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUS_COLORS,
  CONTRACT_STATUS_OPTIONS,
  BILLING_FREQUENCY_LABELS,
  BILLING_FREQUENCY_OPTIONS,
  BREACH_TYPE_LABELS,
  BREACH_TYPE_OPTIONS,
  BREACH_SEVERITY_LABELS,
  BREACH_SEVERITY_COLORS,
  BREACH_SEVERITY_OPTIONS,
  isLiveContract,
  daysUntil,
  isWithinRenewalWindow,
  formatCents,
  formatMinutes,
  totalPenaltyCents,
} from '@/lib/contracts';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

const labelClass = 'mb-1.5 block text-xs font-medium text-text-secondary';

type FilterKey = 'live' | 'expiring' | 'all';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'live', label: 'Active' },
  { key: 'expiring', label: 'Expiring / attention' },
  { key: 'all', label: 'All' },
];

// ============================================================
// CONTRACT FORM (add / edit)
// ============================================================

interface ContractFormState {
  customer_id: string | null;
  contract_number: string;
  contract_name: string;
  contract_type: ContractType;
  status: ContractStatus;
  start_date: string;
  end_date: string;
  auto_renew: boolean;
  renewal_notice_days: string;
  billing_frequency: BillingFrequency;
  contract_value: string;
  sla_response_minutes_standard: string;
  sla_response_minutes_critical: string;
  sla_resolution_hours: string;
  penalty_percentage: string;
  penalty_cap_percentage: string;
  signed_by: string;
  signed_at: string;
  document_url: string;
  notes: string;
}

const EMPTY_FORM: ContractFormState = {
  customer_id: null,
  contract_number: '',
  contract_name: '',
  contract_type: 'service_agreement',
  status: 'draft',
  start_date: '',
  end_date: '',
  auto_renew: false,
  renewal_notice_days: '30',
  billing_frequency: 'monthly',
  contract_value: '',
  sla_response_minutes_standard: '',
  sla_response_minutes_critical: '',
  sla_resolution_hours: '',
  penalty_percentage: '',
  penalty_cap_percentage: '100',
  signed_by: '',
  signed_at: '',
  document_url: '',
  notes: '',
};

function contractToForm(c: CommercialContract): ContractFormState {
  return {
    customer_id: c.customer_id,
    contract_number: c.contract_number ?? '',
    contract_name: c.contract_name,
    contract_type: c.contract_type,
    status: c.status,
    start_date: c.start_date ?? '',
    end_date: c.end_date ?? '',
    auto_renew: c.auto_renew,
    renewal_notice_days: String(c.renewal_notice_days ?? 30),
    billing_frequency: c.billing_frequency,
    contract_value: c.contract_value_cents != null ? String(c.contract_value_cents / 100) : '',
    sla_response_minutes_standard: c.sla_response_minutes_standard != null ? String(c.sla_response_minutes_standard) : '',
    sla_response_minutes_critical: c.sla_response_minutes_critical != null ? String(c.sla_response_minutes_critical) : '',
    sla_resolution_hours: c.sla_resolution_hours != null ? String(c.sla_resolution_hours) : '',
    penalty_percentage: c.penalty_percentage != null ? String(c.penalty_percentage) : '',
    penalty_cap_percentage: c.penalty_cap_percentage != null ? String(c.penalty_cap_percentage) : '100',
    signed_by: c.signed_by ?? '',
    signed_at: c.signed_at ?? '',
    document_url: c.document_url ?? '',
    notes: c.notes ?? '',
  };
}

function ContractForm({
  initial,
  customerOptions,
  onCancel,
  onSave,
}: {
  initial: ContractFormState;
  customerOptions: Customer[];
  onCancel: () => void;
  onSave: (form: ContractFormState) => Promise<void>;
}) {
  const [form, setForm] = useState<ContractFormState>(initial);
  const [saving, setSaving] = useState(false);

  const update = <K extends keyof ContractFormState>(key: K, value: ContractFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelClass}>Contract name *</label>
          <input
            className={inputClass}
            value={form.contract_name}
            onChange={(e) => update('contract_name', e.target.value)}
            placeholder="Acme Manufacturing — HVAC maintenance"
          />
        </div>

        <div>
          <label className={labelClass}>Customer</label>
          <select
            className={inputClass}
            value={form.customer_id ?? ''}
            onChange={(e) => update('customer_id', e.target.value || null)}
          >
            <option value="">Not linked</option>
            {customerOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass}>Contract number</label>
          <input
            className={inputClass}
            value={form.contract_number}
            onChange={(e) => update('contract_number', e.target.value)}
            placeholder="CTR-2026-0142"
          />
        </div>

        <div>
          <label className={labelClass}>Contract type</label>
          <select className={inputClass} value={form.contract_type} onChange={(e) => update('contract_type', e.target.value as ContractType)}>
            {CONTRACT_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {CONTRACT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass}>Status</label>
          <select className={inputClass} value={form.status} onChange={(e) => update('status', e.target.value as ContractStatus)}>
            {CONTRACT_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {CONTRACT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass}>Start date</label>
          <input type="date" className={inputClass} value={form.start_date} onChange={(e) => update('start_date', e.target.value)} />
        </div>

        <div>
          <label className={labelClass}>End date</label>
          <input type="date" className={inputClass} value={form.end_date} onChange={(e) => update('end_date', e.target.value)} />
        </div>

        <div className="flex items-center gap-2 pt-6">
          <input
            id="auto_renew"
            type="checkbox"
            checked={form.auto_renew}
            onChange={(e) => update('auto_renew', e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          <label htmlFor="auto_renew" className="text-sm text-text-primary">
            Auto-renews
          </label>
        </div>

        <div>
          <label className={labelClass}>Renewal notice (days)</label>
          <input
            type="number"
            min={0}
            className={inputClass}
            value={form.renewal_notice_days}
            onChange={(e) => update('renewal_notice_days', e.target.value)}
          />
        </div>

        <div>
          <label className={labelClass}>Billing frequency</label>
          <select
            className={inputClass}
            value={form.billing_frequency}
            onChange={(e) => update('billing_frequency', e.target.value as BillingFrequency)}
          >
            {BILLING_FREQUENCY_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {BILLING_FREQUENCY_LABELS[f]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass}>Contract value ($)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            className={inputClass}
            value={form.contract_value}
            onChange={(e) => update('contract_value', e.target.value)}
          />
        </div>

        <div className="sm:col-span-2 mt-2 border-t border-border/60 pt-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">SLA commitments</p>
        </div>

        <div>
          <label className={labelClass}>Response time — standard (min)</label>
          <input
            type="number"
            min={0}
            className={inputClass}
            value={form.sla_response_minutes_standard}
            onChange={(e) => update('sla_response_minutes_standard', e.target.value)}
          />
        </div>

        <div>
          <label className={labelClass}>Response time — critical (min)</label>
          <input
            type="number"
            min={0}
            className={inputClass}
            value={form.sla_response_minutes_critical}
            onChange={(e) => update('sla_response_minutes_critical', e.target.value)}
          />
        </div>

        <div>
          <label className={labelClass}>Resolution time (hours)</label>
          <input
            type="number"
            min={0}
            className={inputClass}
            value={form.sla_resolution_hours}
            onChange={(e) => update('sla_resolution_hours', e.target.value)}
          />
        </div>

        <div>
          <label className={labelClass}>Penalty per breach (%)</label>
          <input
            type="number"
            min={0}
            step="0.1"
            className={inputClass}
            value={form.penalty_percentage}
            onChange={(e) => update('penalty_percentage', e.target.value)}
          />
        </div>

        <div>
          <label className={labelClass}>Penalty cap (% of contract value)</label>
          <input
            type="number"
            min={0}
            step="0.1"
            className={inputClass}
            value={form.penalty_cap_percentage}
            onChange={(e) => update('penalty_cap_percentage', e.target.value)}
          />
        </div>

        <div className="sm:col-span-2 mt-2 border-t border-border/60 pt-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Signature & document</p>
        </div>

        <div>
          <label className={labelClass}>Signed by</label>
          <input className={inputClass} value={form.signed_by} onChange={(e) => update('signed_by', e.target.value)} />
        </div>

        <div>
          <label className={labelClass}>Signed date</label>
          <input type="date" className={inputClass} value={form.signed_at} onChange={(e) => update('signed_at', e.target.value)} />
        </div>

        <div className="sm:col-span-2">
          <label className={labelClass}>Document URL</label>
          <input
            className={inputClass}
            value={form.document_url}
            onChange={(e) => update('document_url', e.target.value)}
            placeholder="Link to the signed PDF (Drive, S3, etc.)"
          />
        </div>

        <div className="sm:col-span-2">
          <label className={labelClass}>Notes</label>
          <textarea
            className={inputClass}
            rows={3}
            value={form.notes}
            onChange={(e) => update('notes', e.target.value)}
          />
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2 border-t border-border/60 pt-3">
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring flex items-center gap-1 rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          <X size={14} /> Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !form.contract_name.trim()}
          className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
        >
          <Check size={14} /> Save contract
        </button>
      </div>
    </div>
  );
}

// ============================================================
// BREACH LOG FORM (quick add, inline)
// ============================================================

function BreachForm({ onCancel, onSave }: { onCancel: () => void; onSave: (form: BreachFormState) => Promise<void> }) {
  const [form, setForm] = useState<BreachFormState>({
    breach_type: 'response_time',
    severity: 'minor',
    expected_at: '',
    actual_at: '',
    minutes_over: '',
    penalty_amount: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);

  const update = <K extends keyof BreachFormState>(key: K, value: BreachFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="mt-3 rounded-xl border border-border bg-bg-primary p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass}>Breach type</label>
          <select className={inputClass} value={form.breach_type} onChange={(e) => update('breach_type', e.target.value as BreachType)}>
            {BREACH_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {BREACH_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Severity</label>
          <select className={inputClass} value={form.severity} onChange={(e) => update('severity', e.target.value as BreachSeverity)}>
            {BREACH_SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {BREACH_SEVERITY_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Expected by</label>
          <input
            type="datetime-local"
            className={inputClass}
            value={form.expected_at}
            onChange={(e) => update('expected_at', e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass}>Actually happened</label>
          <input type="datetime-local" className={inputClass} value={form.actual_at} onChange={(e) => update('actual_at', e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Minutes over</label>
          <input
            type="number"
            min={0}
            className={inputClass}
            value={form.minutes_over}
            onChange={(e) => update('minutes_over', e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass}>Penalty owed ($)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            className={inputClass}
            value={form.penalty_amount}
            onChange={(e) => update('penalty_amount', e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Notes</label>
          <input className={inputClass} value={form.notes} onChange={(e) => update('notes', e.target.value)} />
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="focus-ring rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            await onSave(form);
            setSaving(false);
          }}
          className="focus-ring flex items-center gap-1 rounded-xl bg-danger px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
        >
          <AlertTriangle size={14} /> Log breach
        </button>
      </div>
    </div>
  );
}

interface BreachFormState {
  breach_type: BreachType;
  severity: BreachSeverity;
  expected_at: string;
  actual_at: string;
  minutes_over: string;
  penalty_amount: string;
  notes: string;
}

// ============================================================
// PAGE
// ============================================================

export function CommercialContractsPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [contracts, setContracts] = useState<CommercialContract[]>([]);
  const [customerOptions, setCustomerOptions] = useState<Customer[]>([]);
  const [breachesByContract, setBreachesByContract] = useState<Record<string, ContractSlaBreach[]>>({});
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loggingBreachFor, setLoggingBreachFor] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('live');

  const fetchAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [contractsRes, customersRes] = await Promise.all([
      supabase.from('commercial_contracts').select('*').order('created_at', { ascending: false }),
      supabase
        .from('customers')
        .select('*')
        .eq('user_id', user.id)
        .eq('customer_type', 'commercial')
        .order('name', { ascending: true }),
    ]);

    if (contractsRes.error) {
      toast('Failed to load contracts', 'error');
    } else {
      setContracts((contractsRes.data as CommercialContract[]) || []);
    }
    setCustomerOptions((customersRes.data as Customer[]) || []);
    setLoading(false);
  }, [user, toast]);

  const fetchBreaches = useCallback(async (contractId: string) => {
    const { data, error } = await supabase
      .from('contract_sla_breaches')
      .select('*')
      .eq('contract_id', contractId)
      .order('created_at', { ascending: false });
    if (!error) {
      setBreachesByContract((prev) => ({ ...prev, [contractId]: (data as ContractSlaBreach[]) || [] }));
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const toggleExpand = (contractId: string) => {
    if (expandedId === contractId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(contractId);
    if (!breachesByContract[contractId]) fetchBreaches(contractId);
  };

  const filtered = useMemo(() => {
    if (filter === 'all') return contracts;
    if (filter === 'expiring')
      return contracts.filter((c) => isWithinRenewalWindow(c.end_date, c.renewal_notice_days) || c.status === 'expired');
    return contracts.filter((c) => isLiveContract(c.status));
  }, [contracts, filter]);

  const stats = useMemo(() => {
    const live = contracts.filter((c) => isLiveContract(c.status));
    const totalValueCents = live.reduce((sum, c) => sum + (c.contract_value_cents ?? 0), 0);
    const expiringCount = contracts.filter((c) => isWithinRenewalWindow(c.end_date, c.renewal_notice_days)).length;
    return { liveCount: live.length, totalValueCents, expiringCount };
  }, [contracts]);

  const handleSaveContract = async (form: ContractFormState, contractId?: string) => {
    if (!user) return;
    const payload = {
      user_id: user.id,
      customer_id: form.customer_id,
      contract_number: form.contract_number.trim() || null,
      contract_name: form.contract_name.trim(),
      contract_type: form.contract_type,
      status: form.status,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      auto_renew: form.auto_renew,
      renewal_notice_days: Number(form.renewal_notice_days) || 30,
      billing_frequency: form.billing_frequency,
      contract_value_cents: form.contract_value.trim() ? Math.round(Number(form.contract_value) * 100) : null,
      sla_response_minutes_standard: form.sla_response_minutes_standard.trim()
        ? Number(form.sla_response_minutes_standard)
        : null,
      sla_response_minutes_critical: form.sla_response_minutes_critical.trim()
        ? Number(form.sla_response_minutes_critical)
        : null,
      sla_resolution_hours: form.sla_resolution_hours.trim() ? Number(form.sla_resolution_hours) : null,
      penalty_percentage: form.penalty_percentage.trim() ? Number(form.penalty_percentage) : 0,
      penalty_cap_percentage: form.penalty_cap_percentage.trim() ? Number(form.penalty_cap_percentage) : 100,
      signed_by: form.signed_by.trim() || null,
      signed_at: form.signed_at || null,
      document_url: form.document_url.trim() || null,
      notes: form.notes.trim() || null,
    };

    const query = contractId
      ? supabase.from('commercial_contracts').update(payload).eq('id', contractId)
      : supabase.from('commercial_contracts').insert(payload);

    const { error } = await query;
    if (error) {
      toast('Could not save this contract', 'error');
      return;
    }

    toast('Contract saved', 'success');
    setAdding(false);
    setEditingId(null);
    fetchAll();
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    const { error } = await supabase.from('commercial_contracts').delete().eq('id', deletingId);
    if (error) {
      toast('Could not delete this contract', 'error');
    } else {
      setContracts((prev) => prev.filter((c) => c.id !== deletingId));
      toast('Contract deleted', 'success');
    }
    setDeletingId(null);
  };

  const handleSaveBreach = async (contractId: string, form: BreachFormState) => {
    if (!user) return;
    const payload = {
      user_id: user.id,
      contract_id: contractId,
      breach_type: form.breach_type,
      severity: form.severity,
      expected_at: form.expected_at || null,
      actual_at: form.actual_at || null,
      minutes_over: form.minutes_over.trim() ? Number(form.minutes_over) : null,
      penalty_amount_cents: form.penalty_amount.trim() ? Math.round(Number(form.penalty_amount) * 100) : 0,
      notes: form.notes.trim() || null,
    };
    const { error } = await supabase.from('contract_sla_breaches').insert(payload);
    if (error) {
      toast('Could not log this breach', 'error');
      return;
    }
    toast('Breach logged', 'success');
    setLoggingBreachFor(null);
    fetchBreaches(contractId);
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <FileSignature size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Commercial Contracts & SLA</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Every signed commercial agreement, its response/resolution commitments, and a running log of any
                SLA misses — all in one place.
              </p>
            </div>
          </div>
          {!adding && !editingId && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110"
            >
              <Plus size={16} /> New contract
            </button>
          )}
        </div>

        {adding && (
          <div className="mb-6">
            <ContractForm
              initial={EMPTY_FORM}
              customerOptions={customerOptions}
              onCancel={() => setAdding(false)}
              onSave={(form) => handleSaveContract(form)}
            />
          </div>
        )}

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <div className="mb-8 grid grid-cols-3 gap-3">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-2xl font-bold text-text-primary">{stats.liveCount}</p>
                <p className="mt-1 text-xs text-text-secondary">Active contracts</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-2xl font-bold text-text-primary">{formatCents(stats.totalValueCents)}</p>
                <p className="mt-1 text-xs text-text-secondary">Active contract value</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-2xl font-bold text-warning-500">{stats.expiringCount}</p>
                <p className="mt-1 text-xs text-text-secondary">Up for renewal soon</p>
              </div>
            </div>

            <div className="mb-4 flex gap-2">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`focus-ring rounded-xl px-3 py-1.5 text-sm font-medium transition-colors ${
                    filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-text-secondary">
                No contracts here yet.
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((contract) =>
                  editingId === contract.id ? (
                    <ContractForm
                      key={contract.id}
                      initial={contractToForm(contract)}
                      customerOptions={customerOptions}
                      onCancel={() => setEditingId(null)}
                      onSave={(form) => handleSaveContract(form, contract.id)}
                    />
                  ) : (
                    <motion.div
                      key={contract.id}
                      layout
                      className="rounded-2xl border border-border bg-bg-secondary p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => toggleExpand(contract.id)}
                          className="focus-ring flex flex-1 items-start gap-2 text-left"
                        >
                          {expandedId === contract.id ? (
                            <ChevronUp size={16} className="mt-0.5 shrink-0 text-text-secondary" />
                          ) : (
                            <ChevronDown size={16} className="mt-0.5 shrink-0 text-text-secondary" />
                          )}
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium text-text-primary">{contract.contract_name}</p>
                              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CONTRACT_STATUS_COLORS[contract.status]}`}>
                                {CONTRACT_STATUS_LABELS[contract.status]}
                              </span>
                              {isWithinRenewalWindow(contract.end_date, contract.renewal_notice_days) && (
                                <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs font-medium text-warning-500">
                                  Renews in {daysUntil(contract.end_date)}d
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-xs text-text-secondary">
                              {CONTRACT_TYPE_LABELS[contract.contract_type]} · {formatCents(contract.contract_value_cents)} ·{' '}
                              {BILLING_FREQUENCY_LABELS[contract.billing_frequency]}
                            </p>
                          </div>
                        </button>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => downloadContractPdf(contract, breachesByContract[contract.id] || [])}
                            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                            aria-label="Download contract summary PDF"
                          >
                            <Download size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(contract.id)}
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setEditingId(contract.id)}
                            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                            aria-label="Edit contract"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeletingId(contract.id)}
                            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger"
                            aria-label="Delete contract"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>

                      {expandedId === contract.id && (
                        <div className="mt-4 border-t border-border/60 pt-4">
                          <div className="grid grid-cols-2 gap-3 text-xs text-text-secondary sm:grid-cols-3">
                            <p>
                              Response (standard): <span className="text-text-primary">{formatMinutes(contract.sla_response_minutes_standard)}</span>
                            </p>
                            <p>
                              Response (critical): <span className="text-text-primary">{formatMinutes(contract.sla_response_minutes_critical)}</span>
                            </p>
                            <p>
                              Resolution: <span className="text-text-primary">{contract.sla_resolution_hours ?? 'Not set'} hr</span>
                            </p>
                            <p>
                              Penalty: <span className="text-text-primary">{contract.penalty_percentage ?? 0}% / breach</span>
                            </p>
                            <p>
                              Cap: <span className="text-text-primary">{contract.penalty_cap_percentage ?? 100}%</span>
                            </p>
                            <p>
                              Signed: <span className="text-text-primary">{contract.signed_by || 'Not on file'}</span>
                            </p>
                          </div>

                          <div className="mt-4 flex items-center justify-between">
                            <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                              SLA breach log
                              {breachesByContract[contract.id]?.length ? (
                                <span className="ml-2 text-danger">
                                  {formatCents(totalPenaltyCents(breachesByContract[contract.id]))} owed
                                </span>
                              ) : null}
                            </p>
                            {loggingBreachFor !== contract.id && (
                              <button
                                type="button"
                                onClick={() => setLoggingBreachFor(contract.id)}
                                className="focus-ring flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10"
                              >
                                <AlertTriangle size={12} /> Log breach
                              </button>
                            )}
                          </div>

                          {loggingBreachFor === contract.id && (
                            <BreachForm
                              onCancel={() => setLoggingBreachFor(null)}
                              onSave={(form) => handleSaveBreach(contract.id, form)}
                            />
                          )}

                          <div className="mt-3 space-y-2">
                            {(breachesByContract[contract.id] || []).length === 0 ? (
                              <p className="text-xs text-text-secondary">No breaches logged — clean record.</p>
                            ) : (
                              breachesByContract[contract.id].map((b) => (
                                <div key={b.id} className="flex items-center justify-between rounded-xl bg-bg-primary px-3 py-2 text-xs">
                                  <div className="flex items-center gap-2">
                                    <span className={`rounded-full px-2 py-0.5 font-medium ${BREACH_SEVERITY_COLORS[b.severity]}`}>
                                      {BREACH_SEVERITY_LABELS[b.severity]}
                                    </span>
                                    <span className="text-text-secondary">{BREACH_TYPE_LABELS[b.breach_type]}</span>
                                    {b.minutes_over != null && <span className="text-text-secondary">· {b.minutes_over} min over</span>}
                                  </div>
                                  <span className="font-medium text-text-primary">{formatCents(b.penalty_amount_cents)}</span>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                    </motion.div>
                  )
                )}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="Delete this contract?"
        description="This removes the contract and its entire SLA breach log permanently. The linked customer is not affected."
        confirmLabel="Yes, delete this contract"
        onConfirm={handleDelete}
        onCancel={() => setDeletingId(null)}
      />
    </DashboardLayout>
  );
}
