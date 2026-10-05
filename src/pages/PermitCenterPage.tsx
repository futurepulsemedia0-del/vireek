import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  FileCheck2,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
  ExternalLink,
  TriangleAlert as AlertTriangle,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  INACTIVE_STATUSES,
  PERMIT_TYPE_LABELS,
  PIPELINE_STAGES,
  PORTAL_SYSTEM_LABELS,
  STATUS_META,
  SUBMISSION_METHOD_LABELS,
  deleteAuthority,
  fetchAllPermits,
  fetchPermitAuthorities,
  isFollowUpDue,
  safeHttpUrl,
  saveAuthority,
  type AuthorityInput,
  type PermitApplicationWithJob,
  type PermitAuthority,
  type PermitStatus,
  type PortalSystem,
  type SubmissionMethod,
} from '@/lib/permitTransactions';

// <select> has no shared primitive yet; matches the Input recipe's look.
const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:opacity-50';
const labelClass = 'mb-1.5 block text-sm font-medium text-text-primary';

type Tab = 'pipeline' | 'authorities';

// Pipeline columns: the happy path, with side-states folded into the nearest column.
const COLUMNS: { key: string; label: string; statuses: PermitStatus[] }[] = [
  { key: 'prepare', label: 'Prepare', statuses: ['draft', 'ready_to_file'] },
  {
    key: 'filed',
    label: 'Filed / in review',
    statuses: ['submitted', 'in_review', 'corrections_required'],
  },
  { key: 'issued', label: 'Issued', statuses: ['issued'] },
  { key: 'inspection', label: 'Inspection', statuses: ['in_inspection'] },
  { key: 'passed', label: 'Passed', statuses: ['passed'] },
];

// ---------------------------------------------------------------------------
// Authority form
// ---------------------------------------------------------------------------

const EMPTY_AUTHORITY: AuthorityInput = {
  name: '',
  state: '',
  city: '',
  county: '',
  portal_system: 'other',
  submission_method: 'portal',
  portal_url: '',
  phone: '',
  email: '',
  typical_turnaround_days: null,
  fee_notes: '',
  notes: '',
  verified: false,
};

function toInput(a: PermitAuthority): AuthorityInput {
  const { id: _id, verified_at: _v, ...rest } = a;
  void _id;
  void _v;
  return rest;
}

function AuthorityForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: AuthorityInput;
  onCancel: () => void;
  onSave: (form: AuthorityInput) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof AuthorityInput>(key: K, value: AuthorityInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const text = (
    key: 'state' | 'city' | 'county' | 'phone' | 'email' | 'fee_notes' | 'notes' | 'portal_url',
  ) => (form[key] ?? '') as string;
  const urlInvalid = text('portal_url').trim() !== '' && !safeHttpUrl(text('portal_url').trim());

  const submit = async () => {
    if (form.name.trim().length < 2 || urlInvalid) return;
    setSaving(true);
    try {
      const blank = (v: string | null) => (v && v.trim() ? v.trim() : null);
      await onSave({
        ...form,
        state: blank(form.state)?.toUpperCase() ?? null,
        city: blank(form.city),
        county: blank(form.county),
        portal_url: blank(form.portal_url),
        phone: blank(form.phone),
        email: blank(form.email),
        fee_notes: blank(form.fee_notes),
        notes: blank(form.notes),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Input
            label="Authority name"
            required
            value={form.name}
            maxLength={120}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. City of Austin Development Services"
          />
        </div>
        <Input label="City" value={text('city')} onChange={(e) => set('city', e.target.value)} />
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="State"
            value={text('state')}
            maxLength={2}
            placeholder="TX"
            onChange={(e) => set('state', e.target.value)}
          />
          <Input
            label="County"
            value={text('county')}
            onChange={(e) => set('county', e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="pa-method">
            How applications are filed
          </label>
          <select
            id="pa-method"
            className={selectClass}
            value={form.submission_method}
            onChange={(e) => set('submission_method', e.target.value as SubmissionMethod)}
          >
            {(Object.keys(SUBMISSION_METHOD_LABELS) as SubmissionMethod[]).map((m) => (
              <option key={m} value={m}>
                {SUBMISSION_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="pa-system">
            Portal system
          </label>
          <select
            id="pa-system"
            className={selectClass}
            value={form.portal_system}
            onChange={(e) => set('portal_system', e.target.value as PortalSystem)}
          >
            {(Object.keys(PORTAL_SYSTEM_LABELS) as PortalSystem[]).map((m) => (
              <option key={m} value={m}>
                {PORTAL_SYSTEM_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <Input
            label="Portal / application URL"
            value={text('portal_url')}
            inputMode="url"
            placeholder="https://…"
            onChange={(e) => set('portal_url', e.target.value)}
            error={urlInvalid ? 'Enter a full http(s) link.' : undefined}
          />
        </div>
        <Input label="Phone" value={text('phone')} onChange={(e) => set('phone', e.target.value)} />
        <Input
          label="Email"
          value={text('email')}
          inputMode="email"
          onChange={(e) => set('email', e.target.value)}
        />
        <Input
          label="Typical turnaround (days)"
          type="number"
          min={0}
          max={365}
          value={form.typical_turnaround_days ?? ''}
          onChange={(e) =>
            set(
              'typical_turnaround_days',
              e.target.value === ''
                ? null
                : Math.min(365, Math.max(0, Math.round(Number(e.target.value)))),
            )
          }
        />
        <Input
          label="Fee notes"
          value={text('fee_notes')}
          onChange={(e) => set('fee_notes', e.target.value)}
        />
        <div className="sm:col-span-2">
          <Textarea
            label="Notes"
            rows={2}
            value={text('notes')}
            onChange={(e) => set('notes', e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-text-primary sm:col-span-2">
          <input
            type="checkbox"
            checked={form.verified}
            onChange={(e) => set('verified', e.target.checked)}
          />
          I verified these details with the authority
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          <X size={14} /> Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void submit()}
          disabled={saving || form.name.trim().length < 2 || urlInvalid}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function PermitCenterPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('pipeline');
  const [permits, setPermits] = useState<PermitApplicationWithJob[]>([]);
  const [authorities, setAuthorities] = useState<PermitAuthority[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; form: AuthorityInput } | null>(null);
  const [deleting, setDeleting] = useState<PermitAuthority | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [p, a] = await Promise.all([fetchAllPermits(), fetchPermitAuthorities()]);
      setPermits(p);
      setAuthorities(a);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const authorityById = useMemo(() => new Map(authorities.map((a) => [a.id, a])), [authorities]);
  const active = useMemo(() => permits.filter((p) => !INACTIVE_STATUSES.has(p.status)), [permits]);
  const inactive = useMemo(() => permits.filter((p) => INACTIVE_STATUSES.has(p.status)), [permits]);
  const needsAttention = useMemo(
    () =>
      active.filter(
        (p) =>
          p.status === 'corrections_required' ||
          isFollowUpDue(p, authorityById.get(p.authority_id ?? '')?.typical_turnaround_days),
      ).length,
    [active, authorityById],
  );

  const handleSaveAuthority = async (form: AuthorityInput) => {
    try {
      const saved = await saveAuthority(form, editing?.id ?? undefined);
      setAuthorities((prev) =>
        editing?.id
          ? prev.map((a) => (a.id === saved.id ? saved : a))
          : [...prev, saved].sort((x, y) => x.name.localeCompare(y.name)),
      );
      setEditing(null);
      toast('Authority saved.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this authority.', 'error');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteAuthority(deleting.id);
      setAuthorities((prev) => prev.filter((a) => a.id !== deleting.id));
      toast('Authority deleted.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete this authority.', 'error');
    } finally {
      setDeleting(null);
    }
  };

  const card = (p: PermitApplicationWithJob) => {
    const meta = STATUS_META[p.status];
    const authority = authorityById.get(p.authority_id ?? '');
    const due = isFollowUpDue(p, authority?.typical_turnaround_days);
    return (
      <li key={p.id} className="rounded-lg border border-border/70 bg-bg-primary p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-text-primary">
            {PERMIT_TYPE_LABELS[p.permit_type]}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>
            {meta.label}
          </span>
          {due && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] text-warning-500">
              <AlertTriangle size={10} /> Follow up
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-xs text-text-primary">{p.jobs?.customer_name ?? 'Job'}</p>
        <p className="truncate text-[11px] text-text-secondary">
          {p.jobs?.address ?? p.jobs?.service_type ?? ''}
        </p>
        <p className="mt-1 truncate text-[11px] text-text-secondary">
          {authority?.name ?? 'No authority selected'}
          {p.permit_number ? ` · #${p.permit_number}` : ''}
        </p>
      </li>
    );
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <FileCheck2 size={20} />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-text-primary">Permit Center</h1>
            <p className="text-sm text-text-secondary">
              Every permit across your jobs — from application to final inspection.
              {needsAttention > 0 && (
                <span className="ml-1 font-medium text-warning-500">
                  {needsAttention} need attention.
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="mb-5 flex gap-1 rounded-xl bg-bg-secondary p-1" role="tablist">
          {(['pipeline', 'authorities'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`focus-ring flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                tab === t
                  ? 'bg-bg-primary text-text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t === 'pipeline'
                ? `Pipeline (${active.length})`
                : `Authorities (${authorities.length})`}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-text-secondary" />
          </div>
        ) : loadError ? (
          <EmptyStateError
            icon={FileCheck2}
            title="Could not load permits"
            onRetry={() => void load()}
          />
        ) : tab === 'pipeline' ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {permits.length === 0 ? (
              <EmptyState
                icon={FileCheck2}
                title="No permits yet"
                description="Open a job and start one from its Permit Transaction panel, or add your permitting authorities first."
                action={{ label: 'Add authorities', onClick: () => setTab('authorities') }}
              />
            ) : (
              <>
                <div className="grid gap-3 md:grid-cols-5">
                  {COLUMNS.map((col) => {
                    const items = active.filter((p) => col.statuses.includes(p.status));
                    return (
                      <section
                        key={col.key}
                        className="rounded-xl border border-border bg-bg-secondary p-3"
                      >
                        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                          {col.label} <span className="ml-1 text-text-primary">{items.length}</span>
                        </h2>
                        <ul className="space-y-2">{items.map(card)}</ul>
                        {items.length === 0 && (
                          <p className="text-xs text-text-secondary">Nothing here.</p>
                        )}
                      </section>
                    );
                  })}
                </div>
                {inactive.length > 0 && (
                  <div className="mt-5">
                    <button
                      type="button"
                      onClick={() => setShowClosed((v) => !v)}
                      aria-expanded={showClosed}
                      className="focus-ring text-sm text-text-secondary hover:text-text-primary"
                    >
                      {showClosed ? 'Hide' : 'Show'} closed / withdrawn / rejected (
                      {inactive.length})
                    </button>
                    {showClosed && (
                      <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {inactive.map(card)}
                      </ul>
                    )}
                  </div>
                )}
                <p className="mt-5 text-xs text-text-secondary">
                  Stages: {PIPELINE_STAGES.map((s) => s.label).join(' → ')}. Manage a permit from
                  its job.{' '}
                  <Link to="/dashboard/jobs" className="focus-ring text-accent hover:underline">
                    Go to Jobs
                  </Link>
                </p>
              </>
            )}
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
            <p className="text-sm text-text-secondary">
              Vireek only uses authority details you enter here — it never guesses portals, forms or
              fees. Mark an authority as verified once you have confirmed its details.
            </p>
            {editing ? (
              <AuthorityForm
                initial={editing.form}
                onCancel={() => setEditing(null)}
                onSave={handleSaveAuthority}
              />
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => setEditing({ id: null, form: EMPTY_AUTHORITY })}
              >
                <Plus size={14} /> Add authority
              </Button>
            )}
            <ul className="space-y-2">
              {authorities.map((a) => {
                const url = safeHttpUrl(a.portal_url);
                return (
                  <li
                    key={a.id}
                    className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-bg-secondary p-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">
                        {a.name}
                        {a.verified && (
                          <span className="ml-2 rounded-full bg-success-500/10 px-2 py-0.5 text-[11px] text-success-500">
                            Verified
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {[a.city, a.state].filter(Boolean).join(', ') || 'No location set'} ·{' '}
                        {SUBMISSION_METHOD_LABELS[a.submission_method]}
                        {a.portal_system !== 'other' &&
                          ` · ${PORTAL_SYSTEM_LABELS[a.portal_system]}`}
                        {a.typical_turnaround_days != null &&
                          ` · ~${a.typical_turnaround_days} days`}
                      </p>
                      {url && (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="focus-ring mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline"
                        >
                          Open portal <ExternalLink size={10} />
                        </a>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        aria-label={`Edit ${a.name}`}
                        onClick={() => setEditing({ id: a.id, form: toInput(a) })}
                        className="focus-ring rounded-lg p-2 text-text-secondary hover:text-text-primary"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${a.name}`}
                        onClick={() => setDeleting(a)}
                        className="focus-ring rounded-lg p-2 text-text-secondary hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
              {authorities.length === 0 && !editing && (
                <li>
                  <EmptyState
                    icon={FileCheck2}
                    title="No authorities yet"
                    description="Add the permit offices you file with most often."
                  />
                </li>
              )}
            </ul>
          </motion.div>
        )}
      </div>

      {deleting && (
        <ConfirmDialog
          open
          title="Delete this authority?"
          description="Permits already linked to it keep their history but will show no authority."
          confirmLabel="Yes, delete"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </DashboardLayout>
  );
}
