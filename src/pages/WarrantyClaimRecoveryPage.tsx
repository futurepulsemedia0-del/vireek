import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { FileClock, Plus, Trash2, Pencil, X, Check, Download, AlertTriangle, Sparkles } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase, WarrantyClaim } from '@/lib/supabase';
import { downloadWarrantyClaimPacketPdf } from '@/lib/pdf';
import {
  ClaimStatus,
  CLAIM_STATUS_LABELS,
  CLAIM_STATUS_COLORS,
  CLAIM_STATUS_OPTIONS,
  CreditMethod,
  CREDIT_METHOD_LABELS,
  PacketChecklist,
  PACKET_ITEM_LABELS,
  EMPTY_CHECKLIST,
  isOpenClaim,
  isDeadlineAtRisk,
  packetProgress,
  formatCents,
  daysUntil,
} from '@/lib/warrantyClaimRecovery';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

type FilterKey = 'open' | 'closed' | 'all';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed / denied' },
  { key: 'all', label: 'All' },
];

interface EligibleJob {
  job_id: string;
  customer_name: string;
  customer_phone: string | null;
  property_address: string | null;
  service_type: string | null;
  completed_at: string | null;
  equipment_id: string;
  equipment_type: string | null;
  manufacturer: string | null;
  model_number: string | null;
  serial_number: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
}

// ============================================================
// CLAIM FORM (add / edit)
// ============================================================

interface ClaimFormState {
  job_id: string | null;
  equipment_id: string | null;
  customer_name: string;
  customer_phone: string;
  property_address: string;
  manufacturer: string;
  distributor: string;
  model_number: string;
  serial_number: string;
  part_description: string;
  failure_description: string;
  failure_date: string;
  claim_deadline: string;
  status: ClaimStatus;
  part_cost: string;
  labor_cost: string;
  rma_number: string;
  claim_number: string;
  approved_amount: string;
  credit_received: string;
  credit_received_at: string;
  credit_method: CreditMethod;
  denial_reason: string;
  packet_checklist: PacketChecklist;
  notes: string;
}

const EMPTY_FORM: ClaimFormState = {
  job_id: null,
  equipment_id: null,
  customer_name: '',
  customer_phone: '',
  property_address: '',
  manufacturer: '',
  distributor: '',
  model_number: '',
  serial_number: '',
  part_description: '',
  failure_description: '',
  failure_date: '',
  claim_deadline: '',
  status: 'eligible',
  part_cost: '',
  labor_cost: '',
  rma_number: '',
  claim_number: '',
  approved_amount: '',
  credit_received: '',
  credit_received_at: '',
  credit_method: 'account_credit',
  denial_reason: '',
  packet_checklist: EMPTY_CHECKLIST,
  notes: '',
};

function ClaimForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: ClaimFormState;
  onCancel: () => void;
  onSave: (form: ClaimFormState) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof ClaimFormState>(key: K, value: ClaimFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const toggleChecklistItem = (key: keyof PacketChecklist) =>
    setForm((f) => ({ ...f, packet_checklist: { ...f.packet_checklist, [key]: !f.packet_checklist[key] } }));

  const handleSave = async () => {
    if (!form.customer_name.trim()) return;
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <p className="mb-2 text-xs font-medium text-text-secondary">Customer & unit</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <input type="text" value={form.customer_name} onChange={(e) => set('customer_name', e.target.value)} placeholder="Customer name" className={inputClass} />
        <input type="tel" value={form.customer_phone} onChange={(e) => set('customer_phone', e.target.value)} placeholder="Phone" className={inputClass} />
        <input type="text" value={form.property_address} onChange={(e) => set('property_address', e.target.value)} placeholder="Property address" className={inputClass} />
      </div>

      <p className="mb-2 mt-4 text-xs font-medium text-text-secondary">Failed unit</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <input type="text" value={form.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} placeholder="Manufacturer" className={inputClass} />
        <input type="text" value={form.model_number} onChange={(e) => set('model_number', e.target.value)} placeholder="Model #" className={inputClass} />
        <input type="text" value={form.serial_number} onChange={(e) => set('serial_number', e.target.value)} placeholder="Serial #" className={inputClass} />
        <input type="text" value={form.distributor} onChange={(e) => set('distributor', e.target.value)} placeholder="Distributor claim is filed with" className={`${inputClass} sm:col-span-2`} />
        <input type="date" value={form.failure_date} onChange={(e) => set('failure_date', e.target.value)} className={inputClass} />
      </div>
      <input type="text" value={form.part_description} onChange={(e) => set('part_description', e.target.value)} placeholder="Part that failed" className={`${inputClass} mt-3`} />
      <textarea value={form.failure_description} onChange={(e) => set('failure_description', e.target.value)} placeholder="Failure description / diagnosis" rows={2} className={`${inputClass} mt-3`} />

      <p className="mb-2 mt-4 text-xs font-medium text-text-secondary">Claim & deadline</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <input type="date" value={form.claim_deadline} onChange={(e) => set('claim_deadline', e.target.value)} placeholder="Filing deadline" className={inputClass} />
        <input type="text" value={form.rma_number} onChange={(e) => set('rma_number', e.target.value)} placeholder="RMA #" className={inputClass} />
        <input type="text" value={form.claim_number} onChange={(e) => set('claim_number', e.target.value)} placeholder="Manufacturer claim #" className={inputClass} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <input type="number" min={0} step="0.01" value={form.part_cost} onChange={(e) => set('part_cost', e.target.value)} placeholder="Part cost ($)" className={inputClass} />
        <input type="number" min={0} step="0.01" value={form.labor_cost} onChange={(e) => set('labor_cost', e.target.value)} placeholder="Labor cost ($)" className={inputClass} />
        <select value={form.status} onChange={(e) => set('status', e.target.value as ClaimStatus)} className={inputClass}>
          {CLAIM_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{CLAIM_STATUS_LABELS[s]}</option>
          ))}
        </select>
      </div>

      <p className="mb-2 mt-4 text-xs font-medium text-text-secondary">Claim packet checklist</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {(Object.keys(PACKET_ITEM_LABELS) as (keyof PacketChecklist)[]).map((key) => (
          <label key={key} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-primary">
            <input type="checkbox" checked={form.packet_checklist[key]} onChange={() => toggleChecklistItem(key)} className="h-4 w-4 rounded border-border accent-accent" />
            {PACKET_ITEM_LABELS[key]}
          </label>
        ))}
      </div>

      {(form.status === 'approved' || form.status === 'credit_received' || form.status === 'closed') && (
        <>
          <p className="mb-2 mt-4 text-xs font-medium text-text-secondary">Recovery</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <input type="number" min={0} step="0.01" value={form.approved_amount} onChange={(e) => set('approved_amount', e.target.value)} placeholder="Approved amount ($)" className={inputClass} />
            <input type="number" min={0} step="0.01" value={form.credit_received} onChange={(e) => set('credit_received', e.target.value)} placeholder="Credit received ($)" className={inputClass} />
            <select value={form.credit_method} onChange={(e) => set('credit_method', e.target.value as CreditMethod)} className={inputClass}>
              {(Object.keys(CREDIT_METHOD_LABELS) as CreditMethod[]).map((m) => (
                <option key={m} value={m}>{CREDIT_METHOD_LABELS[m]}</option>
              ))}
            </select>
            <input type="date" value={form.credit_received_at} onChange={(e) => set('credit_received_at', e.target.value)} className={inputClass} />
          </div>
        </>
      )}

      {form.status === 'denied' && (
        <input type="text" value={form.denial_reason} onChange={(e) => set('denial_reason', e.target.value)} placeholder="Denial reason" className={`${inputClass} mt-3`} />
      )}

      <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Internal notes…" rows={2} className={`${inputClass} mt-3`} />

      <div className="mt-4 flex justify-end gap-2 border-t border-border/60 pt-3">
        <button type="button" onClick={onCancel} className="focus-ring flex items-center gap-1 rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
          <X size={14} /> Cancel
        </button>
        <button type="button" onClick={handleSave} disabled={saving || !form.customer_name.trim()} className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50">
          <Check size={14} /> Save claim
        </button>
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function WarrantyClaimRecoveryPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [claims, setClaims] = useState<WarrantyClaim[]>([]);
  const [eligibleJobs, setEligibleJobs] = useState<EligibleJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('open');
  const [prefill, setPrefill] = useState<ClaimFormState | null>(null);

  const fetchAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [claimsRes, eligibleRes] = await Promise.all([
      supabase.from('warranty_claims').select('*').order('created_at', { ascending: false }),
      supabase.from('warranty_eligible_jobs').select('*').order('completed_at', { ascending: false }).limit(50),
    ]);

    if (claimsRes.error) {
      toast('Failed to load warranty claims', 'error');
    } else {
      setClaims((claimsRes.data as WarrantyClaim[]) || []);
    }
    setEligibleJobs((eligibleRes.data as EligibleJob[]) || []);
    setLoading(false);
  }, [user, toast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const filtered = useMemo(() => {
    if (filter === 'all') return claims;
    if (filter === 'closed') return claims.filter((c) => !isOpenClaim(c.status));
    return claims.filter((c) => isOpenClaim(c.status));
  }, [claims, filter]);

  const stats = useMemo(() => {
    const open = claims.filter((c) => isOpenClaim(c.status));
    const claimedCents = open.reduce((sum, c) => sum + (c.claimed_amount_cents ?? 0), 0);
    const recoveredCents = claims.reduce((sum, c) => sum + (c.credit_received_cents ?? 0), 0);
    const atRisk = claims.filter((c) => isDeadlineAtRisk(c.status, c.claim_deadline)).length;
    return { openCount: open.length, claimedCents, recoveredCents, atRisk };
  }, [claims]);

  const buildPayload = (form: ClaimFormState, userId: string) => {
    const partCents = form.part_cost.trim() ? Math.round(Number(form.part_cost) * 100) : null;
    const laborCents = form.labor_cost.trim() ? Math.round(Number(form.labor_cost) * 100) : null;
    return {
      user_id: userId,
      job_id: form.job_id,
      equipment_id: form.equipment_id,
      customer_name: form.customer_name.trim(),
      customer_phone: form.customer_phone.trim() || null,
      property_address: form.property_address.trim() || null,
      manufacturer: form.manufacturer.trim() || null,
      distributor: form.distributor.trim() || null,
      model_number: form.model_number.trim() || null,
      serial_number: form.serial_number.trim() || null,
      part_description: form.part_description.trim() || null,
      failure_description: form.failure_description.trim() || null,
      failure_date: form.failure_date || null,
      claim_deadline: form.claim_deadline || null,
      status: form.status,
      part_cost_cents: partCents,
      labor_cost_cents: laborCents,
      claimed_amount_cents: partCents != null || laborCents != null ? (partCents ?? 0) + (laborCents ?? 0) : null,
      rma_number: form.rma_number.trim() || null,
      claim_number: form.claim_number.trim() || null,
      approved_amount_cents: form.approved_amount.trim() ? Math.round(Number(form.approved_amount) * 100) : null,
      credit_received_cents: form.credit_received.trim() ? Math.round(Number(form.credit_received) * 100) : null,
      credit_received_at: form.credit_received_at || null,
      credit_method: form.credit_method,
      denial_reason: form.denial_reason.trim() || null,
      packet_checklist: form.packet_checklist,
      notes: form.notes.trim() || null,
    };
  };

  const handleSaveClaim = async (form: ClaimFormState, claimId?: string) => {
    if (!user) return;
    const payload = buildPayload(form, user.id);
    const query = claimId
      ? supabase.from('warranty_claims').update(payload).eq('id', claimId)
      : supabase.from('warranty_claims').insert(payload);

    const { error } = await query;
    if (error) {
      toast('Could not save this claim', 'error');
      return;
    }
    toast('Claim saved', 'success');
    setAdding(false);
    setEditingId(null);
    setPrefill(null);
    fetchAll();
  };

  const handleQuickStatusChange = async (claim: WarrantyClaim, status: ClaimStatus) => {
    const patch: Record<string, unknown> = { status };
    if (status === 'submitted' && !claim.submitted_at) patch.submitted_at = new Date().toISOString();
    const { error } = await supabase.from('warranty_claims').update(patch).eq('id', claim.id);
    if (error) {
      toast('Could not update status', 'error');
      return;
    }
    setClaims((prev) => prev.map((c) => (c.id === claim.id ? { ...c, ...patch } as WarrantyClaim : c)));
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    const { error } = await supabase.from('warranty_claims').delete().eq('id', deletingId);
    if (error) {
      toast('Could not delete this claim', 'error');
    } else {
      setClaims((prev) => prev.filter((c) => c.id !== deletingId));
      toast('Claim deleted', 'success');
    }
    setDeletingId(null);
  };

  const startClaimFromJob = (job: EligibleJob) => {
    setAdding(false);
    setPrefill({
      ...EMPTY_FORM,
      job_id: job.job_id,
      equipment_id: job.equipment_id,
      customer_name: job.customer_name,
      customer_phone: job.customer_phone ?? '',
      property_address: job.property_address ?? '',
      manufacturer: job.manufacturer ?? '',
      model_number: job.model_number ?? '',
      serial_number: job.serial_number ?? '',
      part_description: job.service_type ?? '',
      failure_date: job.completed_at ? job.completed_at.slice(0, 10) : '',
    });
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <FileClock size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Warranty Claim Recovery</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Find jobs done under manufacturer warranty, build the claim packet, track the filing deadline, and
              follow the credit until it actually lands.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.openCount}</p>
                <p className="text-xs text-text-secondary">Open claims</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{formatCents(stats.claimedCents)}</p>
                <p className="text-xs text-text-secondary">Claimed, in progress</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-success-500">{formatCents(stats.recoveredCents)}</p>
                <p className="text-xs text-text-secondary">Credit recovered</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-danger">{stats.atRisk}</p>
                <p className="text-xs text-text-secondary">Deadline at risk</p>
              </div>
            </div>

            {eligibleJobs.length > 0 && (
              <div className="mb-6 rounded-2xl border border-dashed border-accent/40 bg-accent/5 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-accent">
                  <Sparkles size={14} /> {eligibleJobs.length} warranty-eligible job{eligibleJobs.length === 1 ? '' : 's'} found — no claim filed yet
                </div>
                <div className="space-y-2">
                  {eligibleJobs.slice(0, 5).map((job) => (
                    <div key={`${job.job_id}-${job.equipment_id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-bg-primary px-3 py-2">
                      <div>
                        <p className="text-sm font-medium text-text-primary">{job.customer_name}</p>
                        <p className="text-xs text-text-secondary">
                          {[job.manufacturer, job.model_number].filter(Boolean).join(' ') || job.equipment_type || 'Unit'}
                          {job.warranty_expires_at ? ` · warranty until ${job.warranty_expires_at}` : ''}
                        </p>
                      </div>
                      <button type="button" onClick={() => startClaimFromJob(job)} className="focus-ring flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110">
                        <Plus size={12} /> Start claim
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mb-3 flex items-center justify-between">
              <div className="flex gap-1.5">
                {FILTERS.map((f) => (
                  <button key={f.key} type="button" onClick={() => setFilter(f.key)} className={`focus-ring rounded-full px-3 py-1 text-xs font-medium transition-colors ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
                    {f.label}
                  </button>
                ))}
              </div>
              {!adding && !editingId && !prefill && (
                <button type="button" onClick={() => setAdding(true)} className="focus-ring flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent">
                  <Plus size={14} /> New claim
                </button>
              )}
            </div>

            {(adding || prefill) && (
              <div className="mb-4">
                <ClaimForm initial={prefill ?? EMPTY_FORM} onCancel={() => { setAdding(false); setPrefill(null); }} onSave={(form) => handleSaveClaim(form)} />
              </div>
            )}

            {filtered.length === 0 && !adding && !prefill ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                <p className="text-sm text-text-secondary">
                  {filter === 'open' ? 'No open warranty claims right now.' : 'Nothing in this view yet.'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((claim) => {
                  const progress = packetProgress(claim.packet_checklist as PacketChecklist);
                  const dLeft = daysUntil(claim.claim_deadline);
                  const atRisk = isDeadlineAtRisk(claim.status, claim.claim_deadline);
                  return editingId === claim.id ? (
                    <ClaimForm
                      key={claim.id}
                      initial={{
                        job_id: claim.job_id,
                        equipment_id: claim.equipment_id,
                        customer_name: claim.customer_name,
                        customer_phone: claim.customer_phone ?? '',
                        property_address: claim.property_address ?? '',
                        manufacturer: claim.manufacturer ?? '',
                        distributor: claim.distributor ?? '',
                        model_number: claim.model_number ?? '',
                        serial_number: claim.serial_number ?? '',
                        part_description: claim.part_description ?? '',
                        failure_description: claim.failure_description ?? '',
                        failure_date: claim.failure_date ?? '',
                        claim_deadline: claim.claim_deadline ?? '',
                        status: claim.status,
                        part_cost: claim.part_cost_cents != null ? String(claim.part_cost_cents / 100) : '',
                        labor_cost: claim.labor_cost_cents != null ? String(claim.labor_cost_cents / 100) : '',
                        rma_number: claim.rma_number ?? '',
                        claim_number: claim.claim_number ?? '',
                        approved_amount: claim.approved_amount_cents != null ? String(claim.approved_amount_cents / 100) : '',
                        credit_received: claim.credit_received_cents != null ? String(claim.credit_received_cents / 100) : '',
                        credit_received_at: claim.credit_received_at ?? '',
                        credit_method: (claim.credit_method as CreditMethod) ?? 'account_credit',
                        denial_reason: claim.denial_reason ?? '',
                        packet_checklist: (claim.packet_checklist as PacketChecklist) ?? EMPTY_CHECKLIST,
                        notes: claim.notes ?? '',
                      }}
                      onCancel={() => setEditingId(null)}
                      onSave={(form) => handleSaveClaim(form, claim.id)}
                    />
                  ) : (
                    <motion.div key={claim.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-border bg-bg-secondary p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-text-primary">{claim.customer_name}</p>
                            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">
                              {[claim.manufacturer, claim.model_number].filter(Boolean).join(' ') || 'Unit not set'}
                            </span>
                            {atRisk && (
                              <span className="flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
                                <AlertTriangle size={10} /> {dLeft !== null && dLeft < 0 ? 'Deadline passed' : `${dLeft}d to file`}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-text-secondary">
                            {claim.distributor || 'No distributor on file'}
                            {claim.claim_number ? ` · Claim #${claim.claim_number}` : ''}
                            {claim.rma_number ? ` · RMA ${claim.rma_number}` : ''}
                          </p>
                          <p className="mt-1 text-xs font-medium text-text-primary">
                            Claimed: {formatCents(claim.claimed_amount_cents)} · Credited: {formatCents(claim.credit_received_cents)}
                          </p>
                          <p className="mt-1 text-xs text-text-secondary">Packet: {progress.done}/{progress.total} documents ready</p>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <select value={claim.status} onChange={(e) => handleQuickStatusChange(claim, e.target.value as ClaimStatus)} className={`rounded-full border-0 px-3 py-1 text-xs font-medium ${CLAIM_STATUS_COLORS[claim.status]}`}>
                            {CLAIM_STATUS_OPTIONS.map((s) => (
                              <option key={s} value={s}>{CLAIM_STATUS_LABELS[s]}</option>
                            ))}
                          </select>
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => downloadWarrantyClaimPacketPdf(claim)} className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" aria-label="Download claim packet PDF">
                              <Download size={14} />
                            </button>
                            <button type="button" onClick={() => setEditingId(claim.id)} className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" aria-label="Edit claim">
                              <Pencil size={14} />
                            </button>
                            <button type="button" onClick={() => setDeletingId(claim.id)} className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger" aria-label="Delete claim">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="Delete this claim?"
        description="This removes the warranty claim record permanently. The linked job or equipment (if any) is not affected."
        confirmLabel="Yes, delete this claim"
        onConfirm={handleDelete}
        onCancel={() => setDeletingId(null)}
      />
    </DashboardLayout>
  );
}
