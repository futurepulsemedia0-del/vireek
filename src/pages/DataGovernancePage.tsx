import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DatabaseBackup,
  ShieldCheck,
  Trash2,
  Plus,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Lock,
  FileClock,
  History,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  GOVERNABLE_DATASETS,
  RetentionPolicy,
  fetchRetentionPolicies,
  saveRetentionPolicy,
  DeletionRequest,
  fetchDeletionRequests,
  createDeletionRequest,
  cancelDeletionRequest,
  ConsentRecord,
  fetchConsentRecords,
  recordConsent,
  PiiFieldEntry,
  fetchPiiRegistry,
  fetchDrHealthSummary,
  fetchRecentBackupRuns,
  fetchRecentRestoreDrills,
  DrHealthSummary,
  BackupRun,
  RestoreDrill,
} from '@/lib/dataGovernance';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

type Tab = 'overview' | 'retention' | 'consent' | 'pii' | 'deletion';

function Section({ title, icon: Icon, children }: { title: string; icon: typeof ShieldCheck; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="mb-4 flex items-center gap-2">
        <Icon size={18} className="text-accent" />
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function fmtBytes(n: number | null): string {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function DataGovernancePage() {
  const { user, isOwner } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);

  const [health, setHealth] = useState<DrHealthSummary | null>(null);
  const [backupRuns, setBackupRuns] = useState<BackupRun[]>([]);
  const [drills, setDrills] = useState<RestoreDrill[]>([]);

  const [policies, setPolicies] = useState<RetentionPolicy[]>([]);
  const [savingDataset, setSavingDataset] = useState<string | null>(null);

  const [consents, setConsents] = useState<ConsentRecord[]>([]);
  const [newConsentType, setNewConsentType] = useState<ConsentRecord['consent_type']>('marketing_sms');
  const [newConsentContact, setNewConsentContact] = useState('');
  const [newConsentGranted, setNewConsentGranted] = useState(true);
  const [savingConsent, setSavingConsent] = useState(false);

  const [pii, setPii] = useState<PiiFieldEntry[]>([]);

  const [requests, setRequests] = useState<DeletionRequest[]>([]);
  const [newRequestType, setNewRequestType] = useState<'full_account' | 'dataset'>('dataset');
  const [newRequestDataset, setNewRequestDataset] = useState(GOVERNABLE_DATASETS[0].id);
  const [newRequestReason, setNewRequestReason] = useState('');
  const [creatingRequest, setCreatingRequest] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<DeletionRequest | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [h, b, d, p, c, registry, r] = await Promise.all([
        fetchDrHealthSummary(),
        fetchRecentBackupRuns(10),
        fetchRecentRestoreDrills(10),
        fetchRetentionPolicies(),
        fetchConsentRecords(100),
        fetchPiiRegistry(),
        fetchDeletionRequests(),
      ]);
      setHealth(h);
      setBackupRuns(b);
      setDrills(d);
      setPolicies(p);
      setConsents(c);
      setPii(registry);
      setRequests(r);
    } catch {
      toast('Could not load Data Governance settings', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (isOwner) loadAll();
    else setLoading(false);
  }, [isOwner, loadAll]);

  const policyByDataset = useMemo(() => {
    const map = new Map<string, RetentionPolicy>();
    policies.forEach((p) => map.set(p.dataset, p));
    return map;
  }, [policies]);

  if (!isOwner) {
    return (
      <DashboardLayout>
        <BackButton />
        <p className="mt-6 text-sm text-text-secondary">Only the account owner can manage Data Governance settings.</p>
      </DashboardLayout>
    );
  }

  const handleSavePolicy = async (
    dataset: string,
    patch: Partial<Pick<RetentionPolicy, 'retention_days' | 'auto_delete_enabled' | 'anonymize_instead_of_delete' | 'legal_hold' | 'legal_hold_reason'>>
  ) => {
    if (!user) return;
    setSavingDataset(dataset);
    try {
      const existing = policyByDataset.get(dataset);
      await saveRetentionPolicy(user.id, dataset, { ...existing, ...patch }, existing?.id);
      toast('Retention policy saved', 'success');
      loadAll();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this policy', 'error');
    } finally {
      setSavingDataset(null);
    }
  };

  const handleRecordConsent = async () => {
    if (!user || !newConsentContact.trim()) return;
    setSavingConsent(true);
    try {
      const isEmail = newConsentContact.includes('@');
      await recordConsent({
        userId: user.id,
        consentType: newConsentType,
        granted: newConsentGranted,
        contactPhone: isEmail ? undefined : newConsentContact.trim(),
        contactEmail: isEmail ? newConsentContact.trim() : undefined,
        source: 'manual',
      });
      toast('Consent recorded', 'success');
      setNewConsentContact('');
      loadAll();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not record this consent', 'error');
    } finally {
      setSavingConsent(false);
    }
  };

  const handleCreateRequest = async () => {
    if (!user) return;
    setCreatingRequest(true);
    try {
      const req = await createDeletionRequest({
        userId: user.id,
        requestType: newRequestType,
        targetDataset: newRequestType === 'dataset' ? newRequestDataset : undefined,
        reason: newRequestReason.trim() || undefined,
      });
      toast(
        req.status === 'blocked_legal_hold'
          ? 'Request blocked — an active legal hold covers this data.'
          : `Deletion scheduled for ${new Date(req.scheduled_for).toLocaleDateString()}. You can cancel any time before then.`,
        req.status === 'blocked_legal_hold' ? 'error' : 'success'
      );
      setNewRequestReason('');
      loadAll();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create this request', 'error');
    } finally {
      setCreatingRequest(false);
    }
  };

  const handleConfirmCancel = async () => {
    if (!cancelTarget) return;
    try {
      await cancelDeletionRequest(cancelTarget.id);
      toast('Deletion request cancelled', 'success');
      setCancelTarget(null);
      loadAll();
    } catch {
      toast('Could not cancel this request', 'error');
    }
  };

  const tabs: { key: Tab; label: string; icon: typeof ShieldCheck }[] = [
    { key: 'overview', label: 'DR Overview', icon: DatabaseBackup },
    { key: 'retention', label: 'Retention', icon: FileClock },
    { key: 'consent', label: 'Consent', icon: ShieldCheck },
    { key: 'pii', label: 'PII Registry', icon: Lock },
    { key: 'deletion', label: 'Deletion Requests', icon: Trash2 },
  ];

  return (
    <DashboardLayout>
      <BackButton />
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <DatabaseBackup size={20} />
        </span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Disaster Recovery &amp; Data Governance</h1>
          <p className="text-sm text-text-secondary">Backups, restore drills, retention, deletion, consent, and PII controls.</p>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`focus-ring flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.key ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary hover:text-text-primary'
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />
      ) : (
        <>
          {tab === 'overview' && (
            <div className="space-y-6">
              <Section title="Disaster recovery health" icon={DatabaseBackup}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-xl border border-border bg-bg-primary p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Last backup</p>
                    {health?.lastBackup ? (
                      <div className="mt-2 flex items-center gap-2">
                        {health.lastBackup.status === 'completed' ? (
                          <CheckCircle2 size={16} className="text-success" />
                        ) : (
                          <XCircle size={16} className="text-danger" />
                        )}
                        <p className="text-sm text-text-primary">
                          {new Date(health.lastBackup.started_at).toLocaleString()} ·{' '}
                          {fmtBytes(health.lastBackup.size_bytes)}
                        </p>
                      </div>
                    ) : (
                      <p className="mt-2 text-sm text-text-secondary">No backups recorded yet.</p>
                    )}
                    {health?.lastBackupAgeHours != null && (
                      <p className="mt-1 text-xs text-text-secondary">{health.lastBackupAgeHours.toFixed(1)}h ago</p>
                    )}
                  </div>
                  <div className="rounded-xl border border-border bg-bg-primary p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Last restore drill</p>
                    {health?.lastDrill ? (
                      <div className="mt-2 flex items-center gap-2">
                        {health.drillPassed ? (
                          <CheckCircle2 size={16} className="text-success" />
                        ) : (
                          <AlertTriangle size={16} className="text-warning-500" />
                        )}
                        <p className="text-sm text-text-primary capitalize">{health.lastDrill.status}</p>
                      </div>
                    ) : (
                      <p className="mt-2 text-sm text-text-secondary">No restore drills recorded yet.</p>
                    )}
                    {health?.lastDrill?.rto_seconds != null && (
                      <p className="mt-1 text-xs text-text-secondary">RTO: {health.lastDrill.rto_seconds.toFixed(1)}s</p>
                    )}
                  </div>
                </div>
              </Section>

              <Section title="Recent backup runs" icon={History}>
                <div className="space-y-2">
                  {backupRuns.length === 0 ? (
                    <p className="text-sm text-text-secondary">No backup runs yet.</p>
                  ) : (
                    backupRuns.map((b) => (
                      <div key={b.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-4 py-2.5">
                        <div>
                          <p className="text-sm font-medium text-text-primary">{new Date(b.started_at).toLocaleString()}</p>
                          <p className="text-xs text-text-secondary capitalize">{b.status} · {fmtBytes(b.size_bytes)}</p>
                        </div>
                        {b.status === 'completed' && <CheckCircle2 size={16} className="text-success" />}
                        {b.status === 'failed' && <XCircle size={16} className="text-danger" />}
                        {b.status === 'running' && <Loader2 size={16} className="animate-spin text-text-secondary" />}
                      </div>
                    ))
                  )}
                </div>
              </Section>

              <Section title="Recent restore drills" icon={Clock}>
                <div className="space-y-2">
                  {drills.length === 0 ? (
                    <p className="text-sm text-text-secondary">No restore drills yet.</p>
                  ) : (
                    drills.map((d) => (
                      <div key={d.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-4 py-2.5">
                        <div>
                          <p className="text-sm font-medium text-text-primary">{new Date(d.started_at).toLocaleString()}</p>
                          <p className="text-xs text-text-secondary">{d.notes || '—'}</p>
                        </div>
                        {d.status === 'passed' && <CheckCircle2 size={16} className="text-success" />}
                        {d.status === 'failed' && <AlertTriangle size={16} className="text-danger" />}
                        {d.status === 'running' && <Loader2 size={16} className="animate-spin text-text-secondary" />}
                      </div>
                    ))
                  )}
                </div>
              </Section>
            </div>
          )}

          {tab === 'retention' && (
            <Section title="Retention policies" icon={FileClock}>
              <p className="mb-4 text-sm text-text-secondary">
                Automatically delete or anonymize data past its useful life. A legal hold overrides every policy —
                nothing under hold is ever swept.
              </p>
              <div className="space-y-3">
                {GOVERNABLE_DATASETS.map((ds) => {
                  const policy = policyByDataset.get(ds.id);
                  return (
                    <div key={ds.id} className="rounded-xl border border-border bg-bg-primary p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-text-primary">{ds.label}</p>
                        {policy?.legal_hold && (
                          <span className="flex items-center gap-1 rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] font-semibold text-warning-500">
                            <Lock size={11} /> Legal hold
                          </span>
                        )}
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-3">
                        <label className="text-xs text-text-secondary">
                          Retention (days)
                          <input
                            type="number"
                            min={1}
                            defaultValue={policy?.retention_days ?? ''}
                            onBlur={(e) => handleSavePolicy(ds.id, { retention_days: e.target.value ? Number(e.target.value) : null })}
                            className={`${inputClass} mt-1`}
                            placeholder="Indefinite"
                          />
                        </label>
                        <label className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
                          <input
                            type="checkbox"
                            checked={policy?.auto_delete_enabled ?? false}
                            onChange={(e) => handleSavePolicy(ds.id, { auto_delete_enabled: e.target.checked })}
                          />
                          Auto-enforce
                        </label>
                        <label className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
                          <input
                            type="checkbox"
                            checked={policy?.anonymize_instead_of_delete ?? true}
                            onChange={(e) => handleSavePolicy(ds.id, { anonymize_instead_of_delete: e.target.checked })}
                          />
                          Anonymize instead of delete
                        </label>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-2 text-xs text-text-secondary">
                          <input
                            type="checkbox"
                            checked={policy?.legal_hold ?? false}
                            onChange={(e) => handleSavePolicy(ds.id, { legal_hold: e.target.checked })}
                          />
                          Place legal hold
                        </label>
                        {savingDataset === ds.id && <Loader2 size={12} className="animate-spin text-text-secondary" />}
                        {policy?.last_swept_at && (
                          <span className="text-[11px] text-text-secondary">Last swept {new Date(policy.last_swept_at).toLocaleDateString()}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {tab === 'consent' && (
            <Section title="Consent ledger" icon={ShieldCheck}>
              <p className="mb-4 text-sm text-text-secondary">
                Every grant or revoke is recorded as its own row — the latest row per contact is the current state.
              </p>
              <div className="mb-4 grid gap-3 sm:grid-cols-4">
                <select value={newConsentType} onChange={(e) => setNewConsentType(e.target.value as ConsentRecord['consent_type'])} className={inputClass}>
                  <option value="marketing_sms">Marketing SMS</option>
                  <option value="marketing_email">Marketing email</option>
                  <option value="call_recording">Call recording</option>
                  <option value="data_processing">Data processing</option>
                </select>
                <input
                  type="text"
                  value={newConsentContact}
                  onChange={(e) => setNewConsentContact(e.target.value)}
                  placeholder="Phone or email"
                  className={inputClass}
                />
                <select value={newConsentGranted ? '1' : '0'} onChange={(e) => setNewConsentGranted(e.target.value === '1')} className={inputClass}>
                  <option value="1">Granted</option>
                  <option value="0">Revoked</option>
                </select>
                <button
                  type="button"
                  onClick={handleRecordConsent}
                  disabled={savingConsent}
                  className="focus-ring flex items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
                >
                  {savingConsent ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Record
                </button>
              </div>
              <div className="space-y-2">
                {consents.length === 0 ? (
                  <p className="text-sm text-text-secondary">No consent records yet.</p>
                ) : (
                  consents.slice(0, 30).map((c) => (
                    <div key={c.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-4 py-2.5">
                      <div>
                        <p className="text-sm font-medium text-text-primary">{c.contact_phone || c.contact_email || '—'}</p>
                        <p className="text-xs text-text-secondary">{c.consent_type.replace('_', ' ')} · {c.source} · {new Date(c.created_at).toLocaleDateString()}</p>
                      </div>
                      {c.granted ? <CheckCircle2 size={16} className="text-success" /> : <XCircle size={16} className="text-danger" />}
                    </div>
                  ))
                )}
              </div>
            </Section>
          )}

          {tab === 'pii' && (
            <Section title="PII field registry" icon={Lock}>
              <p className="mb-4 text-sm text-text-secondary">
                Read-only catalog of every column classified as personal data, and how it's handled on export or deletion.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-text-secondary">
                      <th className="py-2 pr-3">Table</th>
                      <th className="py-2 pr-3">Column</th>
                      <th className="py-2 pr-3">Classification</th>
                      <th className="py-2 pr-3">Sensitivity</th>
                      <th className="py-2">Masking</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pii.map((p) => (
                      <tr key={p.id} className="border-b border-border/50">
                        <td className="py-2 pr-3 font-mono text-xs text-text-primary">{p.table_name}</td>
                        <td className="py-2 pr-3 font-mono text-xs text-text-primary">{p.column_name}</td>
                        <td className="py-2 pr-3 text-text-secondary">{p.classification.replace('_', ' ')}</td>
                        <td className="py-2 pr-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                              p.sensitivity === 'critical'
                                ? 'bg-danger/10 text-danger'
                                : p.sensitivity === 'high'
                                ? 'bg-warning-500/10 text-warning-500'
                                : 'bg-bg-tertiary text-text-secondary'
                            }`}
                          >
                            {p.sensitivity}
                          </span>
                        </td>
                        <td className="py-2 text-text-secondary">{p.masking_strategy.replace(/_/g, ' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {tab === 'deletion' && (
            <Section title="Deletion requests" icon={Trash2}>
              <p className="mb-4 text-sm text-text-secondary">
                Requests sit in a grace period before anything is removed, so a mistake can still be cancelled. An
                active legal hold blocks a request automatically.
              </p>
              <div className="mb-4 grid gap-3 sm:grid-cols-4">
                <select value={newRequestType} onChange={(e) => setNewRequestType(e.target.value as 'full_account' | 'dataset')} className={inputClass}>
                  <option value="dataset">One dataset</option>
                  <option value="full_account">Entire account</option>
                </select>
                {newRequestType === 'dataset' && (
                  <select value={newRequestDataset} onChange={(e) => setNewRequestDataset(e.target.value)} className={inputClass}>
                    {GOVERNABLE_DATASETS.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>
                )}
                <input
                  type="text"
                  value={newRequestReason}
                  onChange={(e) => setNewRequestReason(e.target.value)}
                  placeholder="Reason (optional)"
                  className={`${inputClass} ${newRequestType === 'full_account' ? 'sm:col-span-2' : ''}`}
                />
                <button
                  type="button"
                  onClick={handleCreateRequest}
                  disabled={creatingRequest}
                  className="focus-ring flex items-center justify-center gap-1.5 rounded-xl bg-danger px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
                >
                  {creatingRequest ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Request deletion
                </button>
              </div>
              <div className="space-y-2">
                {requests.length === 0 ? (
                  <p className="text-sm text-text-secondary">No deletion requests.</p>
                ) : (
                  requests.map((r) => (
                    <div key={r.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-4 py-2.5">
                      <div>
                        <p className="text-sm font-medium text-text-primary">
                          {r.request_type === 'full_account' ? 'Entire account' : r.target_dataset || r.request_type}
                        </p>
                        <p className="text-xs text-text-secondary capitalize">
                          {r.status.replace('_', ' ')} · scheduled {new Date(r.scheduled_for).toLocaleDateString()}
                        </p>
                      </div>
                      {r.status === 'grace_period' && (
                        <button type="button" onClick={() => setCancelTarget(r)} className="focus-ring text-text-secondary hover:text-danger">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </Section>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!cancelTarget}
        title="Cancel this deletion request?"
        description="No data has been removed yet — cancelling keeps everything exactly as it is."
        confirmLabel="Cancel request"
        onConfirm={handleConfirmCancel}
        onCancel={() => setCancelTarget(null)}
      />
    </DashboardLayout>
  );
}
