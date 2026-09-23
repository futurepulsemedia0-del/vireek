import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ShieldCheck, Plus, Trash2, Pencil, X, Check } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase, TeamMember, TechnicianCredential, ComplianceRequirement } from '@/lib/supabase';
import { computeCredentialStatus, CREDENTIAL_STATUS_LABELS, CREDENTIAL_STATUS_COLORS } from '@/lib/complianceGate';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

type Tab = 'credentials' | 'requirements';

// ============================================================
// CREDENTIAL FORM
// ============================================================

interface CredentialFormState {
  technician_id: string;
  credential_type: string;
  credential_name: string;
  issuing_authority: string;
  credential_number: string;
  issued_at: string;
  expires_at: string;
  status: 'active' | 'revoked' | 'pending_renewal';
}

const EMPTY_CREDENTIAL: CredentialFormState = {
  technician_id: '',
  credential_type: '',
  credential_name: '',
  issuing_authority: '',
  credential_number: '',
  issued_at: '',
  expires_at: '',
  status: 'active',
};

function CredentialForm({
  initial,
  technicians,
  onCancel,
  onSave,
}: {
  initial: CredentialFormState;
  technicians: TeamMember[];
  onCancel: () => void;
  onSave: (form: CredentialFormState) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof CredentialFormState>(key: K, value: CredentialFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const handleSave = async () => {
    if (!form.technician_id || !form.credential_type.trim()) return;
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <select value={form.technician_id} onChange={(e) => set('technician_id', e.target.value)} className={inputClass}>
          <option value="">Select technician…</option>
          {technicians.map((t) => (
            <option key={t.id} value={t.id}>{t.member_name || t.member_email}</option>
          ))}
        </select>
        <input type="text" value={form.credential_type} onChange={(e) => set('credential_type', e.target.value)} placeholder="Credential type code (e.g. epa_608)" className={inputClass} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <input type="text" value={form.credential_name} onChange={(e) => set('credential_name', e.target.value)} placeholder="Display name (e.g. EPA 608 Refrigerant Cert)" className={inputClass} />
        <input type="text" value={form.issuing_authority} onChange={(e) => set('issuing_authority', e.target.value)} placeholder="Issuing authority" className={inputClass} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <input type="text" value={form.credential_number} onChange={(e) => set('credential_number', e.target.value)} placeholder="Credential #" className={inputClass} />
        <input type="date" value={form.issued_at} onChange={(e) => set('issued_at', e.target.value)} className={inputClass} />
        <input type="date" value={form.expires_at} onChange={(e) => set('expires_at', e.target.value)} placeholder="Expires" className={inputClass} />
      </div>
      <select value={form.status} onChange={(e) => set('status', e.target.value as CredentialFormState['status'])} className={`${inputClass} mt-3`}>
        <option value="active">Active</option>
        <option value="pending_renewal">Pending renewal</option>
        <option value="revoked">Revoked</option>
      </select>
      <div className="mt-4 flex justify-end gap-2 border-t border-border/60 pt-3">
        <button type="button" onClick={onCancel} className="focus-ring flex items-center gap-1 rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
          <X size={14} /> Cancel
        </button>
        <button type="button" onClick={handleSave} disabled={saving || !form.technician_id || !form.credential_type.trim()} className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50">
          <Check size={14} /> Save credential
        </button>
      </div>
    </div>
  );
}

// ============================================================
// REQUIREMENT FORM
// ============================================================

interface RequirementFormState {
  service_type: string;
  credential_type: string;
  credential_label: string;
  is_blocking: boolean;
}

const EMPTY_REQUIREMENT: RequirementFormState = { service_type: '', credential_type: '', credential_label: '', is_blocking: true };

function RequirementForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: RequirementFormState;
  onCancel: () => void;
  onSave: (form: RequirementFormState) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof RequirementFormState>(key: K, value: RequirementFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const handleSave = async () => {
    if (!form.service_type.trim() || !form.credential_type.trim()) return;
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <input type="text" value={form.service_type} onChange={(e) => set('service_type', e.target.value)} placeholder="Service type (must match a technician skill)" className={inputClass} />
        <input type="text" value={form.credential_type} onChange={(e) => set('credential_type', e.target.value)} placeholder="Required credential type code" className={inputClass} />
      </div>
      <input type="text" value={form.credential_label} onChange={(e) => set('credential_label', e.target.value)} placeholder="Display name" className={`${inputClass} mt-3`} />
      <label className="mt-3 flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-primary">
        <input type="checkbox" checked={form.is_blocking} onChange={(e) => set('is_blocking', e.target.checked)} className="h-4 w-4 rounded border-border accent-accent" />
        Block dispatch entirely if missing (uncheck for advisory-only)
      </label>
      <div className="mt-4 flex justify-end gap-2 border-t border-border/60 pt-3">
        <button type="button" onClick={onCancel} className="focus-ring flex items-center gap-1 rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
          <X size={14} /> Cancel
        </button>
        <button type="button" onClick={handleSave} disabled={saving || !form.service_type.trim() || !form.credential_type.trim()} className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50">
          <Check size={14} /> Save rule
        </button>
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function ComplianceCenterPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>('credentials');
  const [technicians, setTechnicians] = useState<TeamMember[]>([]);
  const [credentials, setCredentials] = useState<TechnicianCredential[]>([]);
  const [requirements, setRequirements] = useState<ComplianceRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; kind: Tab } | null>(null);

  const fetchAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [techRes, credRes, reqRes] = await Promise.all([
      supabase.from('team_members').select('*').eq('role', 'technician'),
      supabase.from('technician_credentials').select('*').order('created_at', { ascending: false }),
      supabase.from('compliance_requirements').select('*').order('created_at', { ascending: false }),
    ]);
    setTechnicians((techRes.data as TeamMember[]) || []);
    setCredentials((credRes.data as TechnicianCredential[]) || []);
    setRequirements((reqRes.data as ComplianceRequirement[]) || []);
    if (credRes.error || reqRes.error) toast('Failed to load compliance data', 'error');
    setLoading(false);
  }, [user, toast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const techName = useMemo(() => {
    const map: Record<string, string> = {};
    technicians.forEach((t) => { map[t.id] = t.member_name || t.member_email; });
    return map;
  }, [technicians]);

  const stats = useMemo(() => {
    const flagged = credentials.filter((c) => {
      const s = computeCredentialStatus(c.status, c.expires_at);
      return s === 'expired' || s === 'revoked';
    });
    const expiringSoon = credentials.filter((c) => computeCredentialStatus(c.status, c.expires_at) === 'expiring_soon');
    const blockingRules = requirements.filter((r) => r.is_blocking).length;
    return { flaggedCount: flagged.length, expiringSoonCount: expiringSoon.length, blockingRules };
  }, [credentials, requirements]);

  const handleSaveCredential = async (form: CredentialFormState, id?: string) => {
    if (!user) return;
    const payload = {
      user_id: user.id,
      technician_id: form.technician_id,
      credential_type: form.credential_type.trim(),
      credential_name: form.credential_name.trim() || null,
      issuing_authority: form.issuing_authority.trim() || null,
      credential_number: form.credential_number.trim() || null,
      issued_at: form.issued_at || null,
      expires_at: form.expires_at || null,
      status: form.status,
    };
    const query = id
      ? supabase.from('technician_credentials').update(payload).eq('id', id)
      : supabase.from('technician_credentials').insert(payload);
    const { error } = await query;
    if (error) { toast('Could not save this credential', 'error'); return; }
    toast('Credential saved', 'success');
    setAdding(false);
    setEditingId(null);
    fetchAll();
  };

  const handleSaveRequirement = async (form: RequirementFormState, id?: string) => {
    if (!user) return;
    const payload = {
      user_id: user.id,
      service_type: form.service_type.trim(),
      credential_type: form.credential_type.trim(),
      credential_label: form.credential_label.trim() || null,
      is_blocking: form.is_blocking,
    };
    const query = id
      ? supabase.from('compliance_requirements').update(payload).eq('id', id)
      : supabase.from('compliance_requirements').insert(payload);
    const { error } = await query;
    if (error) { toast('Could not save this rule — check the service type + credential type aren\u2019t already paired', 'error'); return; }
    toast('Rule saved', 'success');
    setAdding(false);
    setEditingId(null);
    fetchAll();
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const table = deleting.kind === 'credentials' ? 'technician_credentials' : 'compliance_requirements';
    const { error } = await supabase.from(table).delete().eq('id', deleting.id);
    if (error) {
      toast('Could not delete this', 'error');
    } else {
      if (deleting.kind === 'credentials') setCredentials((prev) => prev.filter((c) => c.id !== deleting.id));
      else setRequirements((prev) => prev.filter((r) => r.id !== deleting.id));
      toast('Deleted', 'success');
    }
    setDeleting(null);
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <ShieldCheck size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Compliance Center</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Track every technician's license, certification, permit and training — and the rules that gate
              dispatch when one is missing or expired.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />)}
          </div>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-3 gap-3">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-danger">{stats.flaggedCount}</p>
                <p className="text-xs text-text-secondary">Expired / revoked</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-warning-500">{stats.expiringSoonCount}</p>
                <p className="text-xs text-text-secondary">Expiring within 30d</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.blockingRules}</p>
                <p className="text-xs text-text-secondary">Active dispatch gates</p>
              </div>
            </div>

            <div className="mb-4 flex items-center justify-between">
              <div className="flex gap-1.5">
                {(['credentials', 'requirements'] as Tab[]).map((t) => (
                  <button key={t} type="button" onClick={() => { setTab(t); setAdding(false); setEditingId(null); }} className={`focus-ring rounded-full px-3 py-1 text-xs font-medium transition-colors ${tab === t ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
                    {t === 'credentials' ? 'Technician credentials' : 'Dispatch requirements'}
                  </button>
                ))}
              </div>
              {!adding && !editingId && (
                <button type="button" onClick={() => setAdding(true)} className="focus-ring flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent">
                  <Plus size={14} /> {tab === 'credentials' ? 'New credential' : 'New rule'}
                </button>
              )}
            </div>

            {tab === 'credentials' ? (
              <>
                {adding && (
                  <div className="mb-4">
                    <CredentialForm initial={EMPTY_CREDENTIAL} technicians={technicians} onCancel={() => setAdding(false)} onSave={(f) => handleSaveCredential(f)} />
                  </div>
                )}
                {credentials.length === 0 && !adding ? (
                  <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                    <p className="text-sm text-text-secondary">No credentials on file yet.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {credentials.map((c) => {
                      const status = computeCredentialStatus(c.status, c.expires_at);
                      return editingId === c.id ? (
                        <CredentialForm
                          key={c.id}
                          technicians={technicians}
                          initial={{
                            technician_id: c.technician_id,
                            credential_type: c.credential_type,
                            credential_name: c.credential_name ?? '',
                            issuing_authority: c.issuing_authority ?? '',
                            credential_number: c.credential_number ?? '',
                            issued_at: c.issued_at ?? '',
                            expires_at: c.expires_at ?? '',
                            status: c.status,
                          }}
                          onCancel={() => setEditingId(null)}
                          onSave={(f) => handleSaveCredential(f, c.id)}
                        />
                      ) : (
                        <motion.div key={c.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary p-4">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-semibold text-text-primary">{techName[c.technician_id] || 'Unknown technician'}</p>
                              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CREDENTIAL_STATUS_COLORS[status]}`}>{CREDENTIAL_STATUS_LABELS[status]}</span>
                            </div>
                            <p className="mt-1 text-xs text-text-secondary">
                              {c.credential_name || c.credential_type} · type: {c.credential_type}
                              {c.expires_at ? ` · expires ${c.expires_at}` : ' · no expiration'}
                            </p>
                          </div>
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => setEditingId(c.id)} className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" aria-label="Edit credential"><Pencil size={14} /></button>
                            <button type="button" onClick={() => setDeleting({ id: c.id, kind: 'credentials' })} className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger" aria-label="Delete credential"><Trash2 size={14} /></button>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <>
                {adding && (
                  <div className="mb-4">
                    <RequirementForm initial={EMPTY_REQUIREMENT} onCancel={() => setAdding(false)} onSave={(f) => handleSaveRequirement(f)} />
                  </div>
                )}
                {requirements.length === 0 && !adding ? (
                  <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                    <p className="text-sm text-text-secondary">No dispatch gates configured yet — every technician can be dispatched to every service type.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {requirements.map((r) =>
                      editingId === r.id ? (
                        <RequirementForm
                          key={r.id}
                          initial={{ service_type: r.service_type, credential_type: r.credential_type, credential_label: r.credential_label ?? '', is_blocking: r.is_blocking }}
                          onCancel={() => setEditingId(null)}
                          onSave={(f) => handleSaveRequirement(f, r.id)}
                        />
                      ) : (
                        <motion.div key={r.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary p-4">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-semibold text-text-primary">{r.service_type}</p>
                              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${r.is_blocking ? 'bg-danger/10 text-danger' : 'bg-bg-tertiary text-text-secondary'}`}>
                                {r.is_blocking ? 'Blocks dispatch' : 'Advisory only'}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-text-secondary">Requires: {r.credential_label || r.credential_type} ({r.credential_type})</p>
                          </div>
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => setEditingId(r.id)} className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" aria-label="Edit rule"><Pencil size={14} /></button>
                            <button type="button" onClick={() => setDeleting({ id: r.id, kind: 'requirements' })} className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger" aria-label="Delete rule"><Trash2 size={14} /></button>
                          </div>
                        </motion.div>
                      )
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deleting)}
        title={deleting?.kind === 'credentials' ? 'Delete this credential?' : 'Delete this dispatch rule?'}
        description={deleting?.kind === 'credentials' ? 'This removes the credential record permanently.' : 'Technicians will no longer be gated on this requirement.'}
        confirmLabel="Yes, delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </DashboardLayout>
  );
}
