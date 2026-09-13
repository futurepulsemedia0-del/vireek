import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ShieldAlert, Plus, Trash2, Pencil, X, Check, Download, Clock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase, InsuranceClaim, Lead, Job } from '@/lib/supabase';
import { downloadInsuranceClaimPdf } from '@/lib/pdf';
import {
  LossType,
  ClaimStatus,
  LOSS_TYPE_LABELS,
  LOSS_TYPE_OPTIONS,
  CLAIM_STATUS_LABELS,
  CLAIM_STATUS_COLORS,
  CLAIM_STATUS_OPTIONS,
  isOpenClaim,
  formatCents,
  daysSince,
} from '@/lib/insuranceClaims';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

type FilterKey = 'open' | 'closed' | 'all';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed / denied' },
  { key: 'all', label: 'All' },
];

// ============================================================
// CLAIM FORM (add / edit)
// ============================================================

interface ClaimFormState {
  lead_id: string | null;
  job_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  property_address: string;
  loss_type: LossType;
  date_of_loss: string;
  insurance_carrier: string;
  policy_number: string;
  claim_number: string;
  adjuster_name: string;
  adjuster_phone: string;
  adjuster_email: string;
  deductible: string;
  estimated_damage: string;
  status: ClaimStatus;
  notes: string;
}

const EMPTY_FORM: ClaimFormState = {
  lead_id: null,
  job_id: null,
  customer_name: '',
  customer_phone: '',
  customer_email: '',
  property_address: '',
  loss_type: 'water_damage',
  date_of_loss: '',
  insurance_carrier: '',
  policy_number: '',
  claim_number: '',
  adjuster_name: '',
  adjuster_phone: '',
  adjuster_email: '',
  deductible: '',
  estimated_damage: '',
  status: 'intake',
  notes: '',
};

function ClaimForm({
  initial,
  leadOptions,
  jobOptions,
  onCancel,
  onSave,
}: {
  initial: ClaimFormState;
  leadOptions: Lead[];
  jobOptions: Job[];
  onCancel: () => void;
  onSave: (form: ClaimFormState) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof ClaimFormState>(key: K, value: ClaimFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const handleLeadPick = (leadId: string) => {
    const lead = leadOptions.find((l) => l.id === leadId);
    setForm((f) => ({
      ...f,
      lead_id: leadId || null,
      customer_name: lead ? lead.name : f.customer_name,
      customer_phone: lead?.phone ?? f.customer_phone,
      customer_email: lead?.email ?? f.customer_email,
    }));
  };

  const handleJobPick = (jobId: string) => {
    const job = jobOptions.find((j) => j.id === jobId);
    setForm((f) => ({
      ...f,
      job_id: jobId || null,
      customer_name: job ? job.customer_name : f.customer_name,
      customer_phone: job?.customer_phone ?? f.customer_phone,
      property_address: job?.address ?? f.property_address,
    }));
  };

  const handleSave = async () => {
    if (!form.customer_name.trim()) return;
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {leadOptions.length > 0 && (
          <div>
            <label className="mb-1 block text-xs text-text-secondary">Link to an existing lead (optional)</label>
            <select value={form.lead_id ?? ''} onChange={(e) => handleLeadPick(e.target.value)} className={inputClass}>
              <option value="">Not linked to a lead</option>
              {leadOptions.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} {l.service_interested ? `— ${l.service_interested}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        {jobOptions.length > 0 && (
          <div>
            <label className="mb-1 block text-xs text-text-secondary">Link to an existing job (optional)</label>
            <select value={form.job_id ?? ''} onChange={(e) => handleJobPick(e.target.value)} className={inputClass}>
              <option value="">Not linked to a job</option>
              {jobOptions.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.customer_name} {j.service_type ? `— ${j.service_type}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <p className="mb-2 mt-4 text-xs font-medium text-text-secondary">Customer</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <input
          type="text"
          value={form.customer_name}
          onChange={(e) => set('customer_name', e.target.value)}
          placeholder="Customer name"
          className={inputClass}
        />
        <input
          type="tel"
          value={form.customer_phone}
          onChange={(e) => set('customer_phone', e.target.value)}
          placeholder="Phone"
          className={inputClass}
        />
        <input
          type="email"
          value={form.customer_email}
          onChange={(e) => set('customer_email', e.target.value)}
          placeholder="Email"
          className={inputClass}
        />
      </div>

      <p className="mb-2 mt-4 text-xs font-medium text-text-secondary">Loss details</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <input
          type="text"
          value={form.property_address}
          onChange={(e) => set('property_address', e.target.value)}
          placeholder="Property address"
          className={`${inputClass} sm:col-span-2`}
        />
        <input
          type="date"
          value={form.date_of_loss}
          onChange={(e) => set('date_of_loss', e.target.value)}
          className={inputClass}
        />
      </div>
      <select
        value={form.loss_type}
        onChange={(e) => set('loss_type', e.target.value as LossType)}
        className={`${inputClass} mt-3`}
      >
        {LOSS_TYPE_OPTIONS.map((t) => (
          <option key={t} value={t}>
            {LOSS_TYPE_LABELS[t]}
          </option>
        ))}
      </select>

      <p className="mb-2 mt-4 text-xs font-medium text-text-secondary">Insurance</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <input
          type="text"
          value={form.insurance_carrier}
          onChange={(e) => set('insurance_carrier', e.target.value)}
          placeholder="Carrier (e.g. State Farm)"
          className={inputClass}
        />
        <input
          type="text"
          value={form.policy_number}
          onChange={(e) => set('policy_number', e.target.value)}
          placeholder="Policy number"
          className={inputClass}
        />
        <input
          type="text"
          value={form.claim_number}
          onChange={(e) => set('claim_number', e.target.value)}
          placeholder="Claim number"
          className={inputClass}
        />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <input
          type="number"
          min={0}
          step="0.01"
          value={form.deductible}
          onChange={(e) => set('deductible', e.target.value)}
          placeholder="Deductible ($)"
          className={inputClass}
        />
        <input
          type="number"
          min={0}
          step="0.01"
          value={form.estimated_damage}
          onChange={(e) => set('estimated_damage', e.target.value)}
          placeholder="Estimated damage ($)"
          className={inputClass}
        />
      </div>

      <p className="mb-2 mt-4 text-xs font-medium text-text-secondary">Adjuster</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <input
          type="text"
          value={form.adjuster_name}
          onChange={(e) => set('adjuster_name', e.target.value)}
          placeholder="Adjuster name"
          className={inputClass}
        />
        <input
          type="tel"
          value={form.adjuster_phone}
          onChange={(e) => set('adjuster_phone', e.target.value)}
          placeholder="Adjuster phone"
          className={inputClass}
        />
        <input
          type="email"
          value={form.adjuster_email}
          onChange={(e) => set('adjuster_email', e.target.value)}
          placeholder="Adjuster email"
          className={inputClass}
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <select value={form.status} onChange={(e) => set('status', e.target.value as ClaimStatus)} className={inputClass}>
          {CLAIM_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {CLAIM_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      <textarea
        value={form.notes}
        onChange={(e) => set('notes', e.target.value)}
        placeholder="Notes for your crew or the front office — scope of damage, access instructions, anything the adjuster asked for…"
        rows={3}
        className={`${inputClass} mt-3`}
      />

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
          disabled={saving || !form.customer_name.trim()}
          className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
        >
          <Check size={14} /> Save claim
        </button>
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function InsuranceClaimsPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [claims, setClaims] = useState<InsuranceClaim[]>([]);
  const [leadOptions, setLeadOptions] = useState<Lead[]>([]);
  const [jobOptions, setJobOptions] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('open');

  const fetchAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [claimsRes, leadsRes, jobsRes] = await Promise.all([
      supabase.from('insurance_claims').select('*').order('created_at', { ascending: false }),
      supabase.from('leads').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100),
      supabase.from('jobs').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100),
    ]);

    if (claimsRes.error) {
      toast('Failed to load insurance claims', 'error');
    } else {
      setClaims((claimsRes.data as InsuranceClaim[]) || []);
    }
    setLeadOptions((leadsRes.data as Lead[]) || []);
    setJobOptions((jobsRes.data as Job[]) || []);
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
    const estimatedCents = open.reduce((sum, c) => sum + (c.estimated_damage_cents ?? 0), 0);
    const awaitingAdjuster = claims.filter((c) => c.status === 'submitted_to_carrier').length;
    return { openCount: open.length, estimatedCents, awaitingAdjuster };
  }, [claims]);

  const handleSaveClaim = async (form: ClaimFormState, claimId?: string) => {
    if (!user) return;
    const payload = {
      user_id: user.id,
      lead_id: form.lead_id,
      job_id: form.job_id,
      customer_name: form.customer_name.trim(),
      customer_phone: form.customer_phone.trim() || null,
      customer_email: form.customer_email.trim() || null,
      property_address: form.property_address.trim() || null,
      loss_type: form.loss_type,
      date_of_loss: form.date_of_loss || null,
      insurance_carrier: form.insurance_carrier.trim() || null,
      policy_number: form.policy_number.trim() || null,
      claim_number: form.claim_number.trim() || null,
      adjuster_name: form.adjuster_name.trim() || null,
      adjuster_phone: form.adjuster_phone.trim() || null,
      adjuster_email: form.adjuster_email.trim() || null,
      deductible_cents: form.deductible.trim() ? Math.round(Number(form.deductible) * 100) : null,
      estimated_damage_cents: form.estimated_damage.trim() ? Math.round(Number(form.estimated_damage) * 100) : null,
      status: form.status,
      notes: form.notes.trim() || null,
    };

    const query = claimId
      ? supabase.from('insurance_claims').update(payload).eq('id', claimId)
      : supabase.from('insurance_claims').insert(payload);

    const { error } = await query;
    if (error) {
      toast('Could not save this claim', 'error');
      return;
    }

    toast('Claim saved', 'success');
    setAdding(false);
    setEditingId(null);
    fetchAll();
  };

  const handleQuickStatusChange = async (claim: InsuranceClaim, status: ClaimStatus) => {
    const { error } = await supabase.from('insurance_claims').update({ status }).eq('id', claim.id);
    if (error) {
      toast('Could not update status', 'error');
      return;
    }
    setClaims((prev) => prev.map((c) => (c.id === claim.id ? { ...c, status } : c)));
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    const { error } = await supabase.from('insurance_claims').delete().eq('id', deletingId);
    if (error) {
      toast('Could not delete this claim', 'error');
    } else {
      setClaims((prev) => prev.filter((c) => c.id !== deletingId));
      toast('Claim deleted', 'success');
    }
    setDeletingId(null);
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <ShieldAlert size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Insurance Claims</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Track every water, fire, smoke, or mold claim from first call to closed file — carrier, policy and
              claim numbers, adjuster contact, and where it stands, all in one place.
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
            <div className="mb-8 grid grid-cols-3 gap-3">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.openCount}</p>
                <p className="text-xs text-text-secondary">Open claims</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{formatCents(stats.estimatedCents)}</p>
                <p className="text-xs text-text-secondary">Est. value in progress</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.awaitingAdjuster}</p>
                <p className="text-xs text-text-secondary">Awaiting adjuster</p>
              </div>
            </div>

            <div className="mb-3 flex items-center justify-between">
              <div className="flex gap-1.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setFilter(f.key)}
                    className={`focus-ring rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      filter === f.key
                        ? 'bg-accent text-white'
                        : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {!adding && !editingId && (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="focus-ring flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                >
                  <Plus size={14} /> New claim
                </button>
              )}
            </div>

            {adding && (
              <div className="mb-4">
                <ClaimForm
                  initial={EMPTY_FORM}
                  leadOptions={leadOptions}
                  jobOptions={jobOptions}
                  onCancel={() => setAdding(false)}
                  onSave={(form) => handleSaveClaim(form)}
                />
              </div>
            )}

            {filtered.length === 0 && !adding ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                <p className="text-sm text-text-secondary">
                  {filter === 'open'
                    ? 'No open claims right now — new ones from restoration calls will show up here.'
                    : 'Nothing in this view yet.'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((claim) =>
                  editingId === claim.id ? (
                    <ClaimForm
                      key={claim.id}
                      leadOptions={leadOptions}
                      jobOptions={jobOptions}
                      initial={{
                        lead_id: claim.lead_id,
                        job_id: claim.job_id,
                        customer_name: claim.customer_name,
                        customer_phone: claim.customer_phone ?? '',
                        customer_email: claim.customer_email ?? '',
                        property_address: claim.property_address ?? '',
                        loss_type: claim.loss_type,
                        date_of_loss: claim.date_of_loss ?? '',
                        insurance_carrier: claim.insurance_carrier ?? '',
                        policy_number: claim.policy_number ?? '',
                        claim_number: claim.claim_number ?? '',
                        adjuster_name: claim.adjuster_name ?? '',
                        adjuster_phone: claim.adjuster_phone ?? '',
                        adjuster_email: claim.adjuster_email ?? '',
                        deductible: claim.deductible_cents != null ? String(claim.deductible_cents / 100) : '',
                        estimated_damage:
                          claim.estimated_damage_cents != null ? String(claim.estimated_damage_cents / 100) : '',
                        status: claim.status,
                        notes: claim.notes ?? '',
                      }}
                      onCancel={() => setEditingId(null)}
                      onSave={(form) => handleSaveClaim(form, claim.id)}
                    />
                  ) : (
                    <motion.div
                      key={claim.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="rounded-xl border border-border bg-bg-secondary p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-text-primary">{claim.customer_name}</p>
                            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">
                              {LOSS_TYPE_LABELS[claim.loss_type]}
                            </span>
                            {claim.status === 'intake' && daysSince(claim.date_of_loss) !== null && daysSince(claim.date_of_loss)! <= 2 && (
                              <span className="flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
                                <Clock size={10} /> Fresh loss — move fast
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-text-secondary">
                            {claim.property_address || 'No property address on file'}
                            {claim.customer_phone ? ` · ${claim.customer_phone}` : ''}
                          </p>
                          <p className="mt-1 text-xs text-text-secondary">
                            {claim.insurance_carrier || 'No carrier on file'}
                            {claim.claim_number ? ` · Claim #${claim.claim_number}` : ''}
                            {claim.adjuster_name ? ` · Adjuster: ${claim.adjuster_name}` : ''}
                          </p>
                          <p className="mt-1 text-xs font-medium text-text-primary">
                            Est. damage: {formatCents(claim.estimated_damage_cents)} · Deductible:{' '}
                            {formatCents(claim.deductible_cents)}
                          </p>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <select
                            value={claim.status}
                            onChange={(e) => handleQuickStatusChange(claim, e.target.value as ClaimStatus)}
                            className={`rounded-full border-0 px-3 py-1 text-xs font-medium ${CLAIM_STATUS_COLORS[claim.status]}`}
                          >
                            {CLAIM_STATUS_OPTIONS.map((s) => (
                              <option key={s} value={s}>
                                {CLAIM_STATUS_LABELS[s]}
                              </option>
                            ))}
                          </select>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => downloadInsuranceClaimPdf(claim)}
                              className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                              aria-label="Download claim summary PDF"
                            >
                              <Download size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(claim.id)}
                              className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                              aria-label="Edit claim"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeletingId(claim.id)}
                              className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger"
                              aria-label="Delete claim"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      </div>
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
        title="Delete this claim?"
        description="This removes the claim record permanently. The linked lead or job (if any) is not affected."
        confirmLabel="Yes, delete this claim"
        onConfirm={handleDelete}
        onCancel={() => setDeletingId(null)}
      />
    </DashboardLayout>
  );
}
