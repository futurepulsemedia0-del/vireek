import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ClipboardCheck, ExternalLink, Pencil, Plus, RefreshCw, ShieldAlert, Trash2, X } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { JobCloseoutPanel } from '@/components/jobs/JobCloseoutPanel';
import { useToast } from '@/contexts/ToastContext';
import {
  ALL_EVIDENCE_KEYS,
  OWNER_LABELS,
  RISK_BADGE,
  RISK_LABELS,
  STATUS_LABELS,
  STEP_KINDS,
  STEP_LABELS,
  compareRisk,
  deleteRule,
  deadlineRisk,
  evidenceLabel,
  fetchCanSubmit,
  fetchCloseoutBoard,
  fetchCloseoutSummary,
  fetchRules,
  formatCents,
  moneyAtRisk,
  refreshDeadlines,
  ruleFreshness,
  safeHttpUrl,
  saveRule,
  todayISO,
  type BoardRow,
  type CloseoutRule,
  type CloseoutSummary,
  type OwnerRole,
  type RiskLevel,
  type RuleInput,
  type StepKind,
} from '@/lib/installCloseout';

type Tab = 'board' | 'rules' | 'summary';
type RiskFilter = 'all' | 'overdue' | 'critical' | 'high' | 'medium';

const RISK_FILTERS: { key: RiskFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'critical', label: '≤ 3 days' },
  { key: 'high', label: '≤ 7 days' },
  { key: 'medium', label: '≤ 14 days' },
];

const EMPTY_RULE: RuleInput = {
  step_kind: 'permit',
  name: '',
  equipment_type: null,
  manufacturer: null,
  deadline_days: 30,
  required_evidence: [],
  requires_pre_approval: false,
  requires_contractor_enrollment: false,
  default_owner_role: 'office',
  estimated_value_cents: null,
  source_url: '',
  last_verified_at: todayISO(),
  notes: null,
  is_active: true,
};

const selectClass =
  'focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

export function CloseoutBoardPage() {
  const { t } = useTranslation('dashboard');
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('board');
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [rules, setRules] = useState<CloseoutRule[]>([]);
  const [summary, setSummary] = useState<CloseoutSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [canSubmit, setCanSubmit] = useState(false);
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const [ownerFilter, setOwnerFilter] = useState<'all' | OwnerRole>('all');
  const [query, setQuery] = useState('');
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id?: string; value: RuleInput } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);

  const today = todayISO();

  const load = useCallback(async () => {
    try {
      const [b, r, s, c] = await Promise.all([
        fetchCloseoutBoard(false),
        fetchRules(),
        fetchCloseoutSummary(6),
        fetchCanSubmit(),
      ]);
      setRows(b);
      setRules(r);
      setSummary(s);
      setCanSubmit(c);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const withRisk = useMemo(
    () => rows.map((r) => ({ row: r, risk: deadlineRisk({ status: r.status, deadline: r.deadline }, today) })),
    [rows, today],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return withRisk
      .filter(({ row, risk }) => {
        if (riskFilter !== 'all' && risk !== riskFilter) return false;
        if (ownerFilter !== 'all' && row.owner_role !== ownerFilter) return false;
        if (q && !`${row.customer_name ?? ''} ${row.address ?? ''}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => compareRisk(a.risk, b.risk) || (a.row.deadline ?? '9999').localeCompare(b.row.deadline ?? '9999'));
  }, [withRisk, riskFilter, ownerFilter, query]);

  const atRisk = useMemo(() => moneyAtRisk(rows, today), [rows, today]);
  const overdue = withRisk.filter(({ risk }) => risk === 'overdue').length;
  const gated = new Set(
    rows
      .filter((r) => r.step_kind === 'rebate' && r.pre_approval_required && r.pre_approval_status !== 'approved' && r.status !== 'waived' && r.status !== 'done')
      .map((r) => r.job_id),
  ).size;

  const runEngine = async () => {
    setRunning(true);
    try {
      const n = await refreshDeadlines();
      toast(n > 0 ? `${n} escalation(s) sent.` : 'Nothing new to escalate.', 'success');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  };

  const submitRule = async () => {
    if (!editing) return;
    const v = editing.value;
    if (v.name.trim().length < 3) return toast('Give the rule a name (3+ characters).', 'error');
    if (!safeHttpUrl(v.source_url)) return toast('A valid http(s) source URL is required for every rule.', 'error');
    if (!v.last_verified_at) return toast('Set the "last verified" date.', 'error');
    setSaving(true);
    try {
      await saveRule(
        {
          ...v,
          name: v.name.trim(),
          source_url: safeHttpUrl(v.source_url),
          equipment_type: v.equipment_type?.trim() || null,
          manufacturer: v.manufacturer?.trim() || null,
          requires_pre_approval: v.step_kind === 'rebate' ? v.requires_pre_approval : false,
        },
        editing.id,
      );
      toast('Rule saved.', 'success');
      setEditing(null);
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'board', label: t('closeout.tabBoard', { defaultValue: 'Board' }) },
    { key: 'rules', label: t('closeout.tabRules', { defaultValue: 'Rules' }) },
    { key: 'summary', label: t('closeout.tabSummary', { defaultValue: 'Monthly summary' }) },
  ];

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <ClipboardCheck size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-text-primary">{t('closeout.pageTitle', { defaultValue: 'Install Closeout Autopilot' })}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {t('closeout.pageSubtitle', {
                defaultValue: 'Permit, inspection, warranty registration, rebate claim and customer documents - tracked to the deadline. Nothing is ever submitted without a human.',
              })}
            </p>
          </div>
          {canSubmit && (
            <Button variant="secondary" size="sm" onClick={() => void runEngine()} disabled={running}>
              <RefreshCw size={14} className={running ? 'animate-spin' : ''} />
              {t('closeout.runEngine', { defaultValue: 'Check deadlines now' })}
            </Button>
          )}
        </div>

        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t('closeout.statAtRisk', { defaultValue: 'Money at risk (estimate)' })} value={formatCents(atRisk)} tone={atRisk > 0 ? 'warn' : 'ok'} />
          <Stat label={t('closeout.statOverdue', { defaultValue: 'Overdue steps' })} value={String(overdue)} tone={overdue > 0 ? 'bad' : 'ok'} />
          <Stat label={t('closeout.statGated', { defaultValue: 'Jobs blocked by pre-approval' })} value={String(gated)} tone={gated > 0 ? 'bad' : 'ok'} />
          <Stat label={t('closeout.statOpen', { defaultValue: 'Open steps' })} value={String(rows.filter((r) => r.status !== 'done' && r.status !== 'waived').length)} tone="ok" />
        </div>

        <div role="tablist" className="mb-4 flex gap-1 border-b border-border">
          {tabs.map((x) => (
            <button
              key={x.key}
              role="tab"
              aria-selected={tab === x.key}
              onClick={() => setTab(x.key)}
              className={`focus-ring -mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === x.key ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
              {x.label}
            </button>
          ))}
        </div>

        {loading ? (
          <SkeletonCardList count={3} rows={3} />
        ) : tab === 'board' ? (
          <>
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <div className="min-w-[200px] flex-1">
                <Input
                  label={t('closeout.search', { defaultValue: 'Search customer or address' })}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <label className="text-xs text-text-secondary">
                {t('closeout.filterRisk', { defaultValue: 'Deadline risk' })}
                <select className={`${selectClass} mt-1 block`} value={riskFilter} onChange={(e) => setRiskFilter(e.target.value as RiskFilter)}>
                  {RISK_FILTERS.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-text-secondary">
                {t('closeout.filterOwner', { defaultValue: 'Owner' })}
                <select className={`${selectClass} mt-1 block`} value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value as 'all' | OwnerRole)}>
                  <option value="all">All</option>
                  {(Object.keys(OWNER_LABELS) as OwnerRole[]).map((o) => (
                    <option key={o} value={o}>{OWNER_LABELS[o]}</option>
                  ))}
                </select>
              </label>
            </div>

            {rows.length === 0 ? (
              <EmptyState
                icon={ClipboardCheck}
                title={t('closeout.emptyTitle', { defaultValue: 'No closeouts yet' })}
                description={t('closeout.emptyBody', { defaultValue: 'Open a completed install job and press "Start closeout" in its Install Closeout panel.' })}
              />
            ) : (
              <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-5 lg:overflow-visible">
                {STEP_KINDS.map((kind) => {
                  const col = filtered.filter(({ row }) => row.step_kind === kind);
                  return (
                    <section key={kind} aria-label={STEP_LABELS[kind]} className="min-w-[270px] shrink-0 snap-start rounded-xl border border-border bg-bg-secondary p-2 lg:min-w-0">
                      <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-semibold text-text-primary">
                        {STEP_LABELS[kind]}
                        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">{col.length}</span>
                      </h2>
                      <ul className="space-y-2">
                        {col.map(({ row, risk }) => (
                          <li key={row.step_id}>
                            <BoardCard row={row} risk={risk} onOpen={() => setOpenJob(row.job_id)} />
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )}
          </>
        ) : tab === 'rules' ? (
          <RulesTab
            rules={rules}
            canEdit={canSubmit}
            today={today}
            onNew={() => setEditing({ value: { ...EMPTY_RULE, last_verified_at: today } })}
            onEdit={(r) => {
              const { id, ...rest } = r;
              setEditing({ id, value: { ...rest, source_url: rest.source_url ?? '' } });
            }}
            onDelete={(id) => setDeleting(id)}
          />
        ) : (
          <SummaryTab summary={summary} />
        )}
      </div>

      {openJob && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" role="dialog" aria-modal="true" onClick={() => setOpenJob(null)}>
          <div className="h-full w-full max-w-xl overflow-y-auto bg-bg-primary p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex justify-end">
              <button type="button" aria-label="Close" className="focus-ring rounded-md p-1 text-text-secondary" onClick={() => { setOpenJob(null); void load(); }}>
                <X size={18} />
              </button>
            </div>
            <JobCloseoutPanel job={{ id: openJob }} />
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-bg-primary p-5 shadow-xl">
            <h2 className="mb-3 text-lg font-semibold text-text-primary">
              {editing.id ? t('closeout.editRule', { defaultValue: 'Edit rule' }) : t('closeout.newRule', { defaultValue: 'New rule' })}
            </h2>
            <RuleForm value={editing.value} onChange={(v) => setEditing({ ...editing, value: v })} />
            <div className="mt-4 flex gap-2">
              <Button size="sm" onClick={() => void submitRule()} disabled={saving}>{t('closeout.save', { defaultValue: 'Save rule' })}</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('closeout.cancel', { defaultValue: 'Cancel' })}</Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={t('closeout.deleteTitle', { defaultValue: 'Delete this rule?' })}
        description={t('closeout.deleteBody', { defaultValue: 'Existing closeouts keep the rule they already copied. New closeouts will no longer use it.' })}
        confirmLabel={t('closeout.delete', { defaultValue: 'Delete rule' })}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const id = deleting;
          setDeleting(null);
          if (!id) return;
          try {
            await deleteRule(id);
            await load();
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        }}
      />
    </DashboardLayout>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning-500' : 'text-text-primary';
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-3">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-1 text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function BoardCard({ row, risk, onOpen }: { row: BoardRow; risk: RiskLevel; onOpen: () => void }) {
  const gated = row.step_kind === 'rebate' && row.pre_approval_required && row.pre_approval_status !== 'approved' && row.status !== 'waived' && row.status !== 'done';
  return (
    <button
      type="button"
      onClick={onOpen}
      className="focus-ring w-full rounded-lg border border-border bg-bg-primary p-3 text-left transition-colors hover:border-accent/50"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-sm font-semibold text-text-primary">{row.customer_name ?? 'Customer'}</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${RISK_BADGE[risk]}`}>{RISK_LABELS[risk]}</span>
      </div>
      {row.address && <p className="mt-0.5 truncate text-xs text-text-secondary">{row.address}</p>}
      <p className="mt-1 text-xs text-text-secondary">
        {STATUS_LABELS[row.status]} · {OWNER_LABELS[row.owner_role]}
        {row.deadline ? ` · ${row.deadline}` : ''}
      </p>
      {row.estimated_value_cents > 0 && row.status !== 'done' && row.status !== 'waived' && (
        <p className="mt-1 text-xs text-text-secondary">≈ {formatCents(row.estimated_value_cents)} (estimate)</p>
      )}
      {row.missing_evidence.length > 0 && row.status !== 'done' && row.status !== 'waived' && (
        <p className="mt-1 flex items-center gap-1 text-xs text-warning-500">
          <AlertTriangle size={12} /> {row.missing_evidence.length} missing: {row.missing_evidence.slice(0, 2).map(evidenceLabel).join(', ')}
          {row.missing_evidence.length > 2 ? '…' : ''}
        </p>
      )}
      {gated && (
        <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-danger">
          <ShieldAlert size={12} /> Pre-approval needed - job start blocked
        </p>
      )}
    </button>
  );
}

function RulesTab({
  rules, canEdit, today, onNew, onEdit, onDelete,
}: {
  rules: CloseoutRule[];
  canEdit: boolean;
  today: string;
  onNew: () => void;
  onEdit: (r: CloseoutRule) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">
          Rules are data you control. Every rule needs a source URL and a verified date - Vireek never states a customer is eligible, only "likely eligible, verify".
        </p>
        {canEdit && (
          <Button size="sm" onClick={onNew}><Plus size={14} /> New rule</Button>
        )}
      </div>
      {rules.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="No rules yet" description="Add the permit, warranty and rebate rules for your area. Closeouts started afterwards use them automatically." />
      ) : (
        <ul className="space-y-2">
          {rules.map((r) => {
            const fresh = ruleFreshness(r.last_verified_at, today);
            const src = safeHttpUrl(r.source_url);
            return (
              <li key={r.id} className="rounded-lg border border-border bg-bg-secondary p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-text-primary">{r.name}</span>
                  <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">{STEP_LABELS[r.step_kind]}</span>
                  {!r.is_active && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">inactive</span>}
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${fresh === 'fresh' ? 'bg-success/15 text-success' : 'bg-warning-500/15 text-warning-500'}`}>
                    {fresh === 'unverified' ? 'never verified' : fresh === 'stale' ? `stale · ${r.last_verified_at}` : `verified ${r.last_verified_at}`}
                  </span>
                  {canEdit && (
                    <span className="ml-auto flex gap-1">
                      <button type="button" aria-label="Edit rule" className="focus-ring rounded-md p-1 text-text-secondary hover:text-text-primary" onClick={() => onEdit(r)}><Pencil size={14} /></button>
                      <button type="button" aria-label="Delete rule" className="focus-ring rounded-md p-1 text-text-secondary hover:text-danger" onClick={() => onDelete(r.id)}><Trash2 size={14} /></button>
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  {r.deadline_days !== null ? `${r.deadline_days} days after install` : 'no fixed deadline'} · {OWNER_LABELS[r.default_owner_role]}
                  {r.equipment_type ? ` · ${r.equipment_type}` : ''}{r.manufacturer ? ` · ${r.manufacturer}` : ''}
                  {r.requires_pre_approval ? ' · pre-approval required' : ''}{r.requires_contractor_enrollment ? ' · contractor enrollment' : ''}
                </p>
                {r.required_evidence.length > 0 && (
                  <p className="mt-1 text-xs text-text-secondary">Evidence: {r.required_evidence.map(evidenceLabel).join(', ')}</p>
                )}
                {src && (
                  <a href={src} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-accent underline">
                    Source <ExternalLink size={11} />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RuleForm({ value, onChange }: { value: RuleInput; onChange: (v: RuleInput) => void }) {
  const set = <K extends keyof RuleInput>(k: K, v: RuleInput[K]) => onChange({ ...value, [k]: v });
  const toggle = (key: string) =>
    set('required_evidence', value.required_evidence.includes(key) ? value.required_evidence.filter((k) => k !== key) : [...value.required_evidence, key]);
  return (
    <div className="space-y-3">
      <label className="block text-xs text-text-secondary">
        Step
        <select className={`${selectClass} mt-1 block w-full`} value={value.step_kind} onChange={(e) => set('step_kind', e.target.value as StepKind)}>
          {STEP_KINDS.map((k) => <option key={k} value={k}>{STEP_LABELS[k]}</option>)}
        </select>
      </label>
      <Input label="Rule name" value={value.name} maxLength={160} onChange={(e) => set('name', e.target.value)} />
      <div className="grid grid-cols-2 gap-3">
        <Input label="Equipment type (optional)" value={value.equipment_type ?? ''} maxLength={80} onChange={(e) => set('equipment_type', e.target.value || null)} />
        <Input label="Manufacturer (optional)" value={value.manufacturer ?? ''} maxLength={80} onChange={(e) => set('manufacturer', e.target.value || null)} />
        <Input label="Deadline (days after install)" type="number" min={0} max={1095} value={value.deadline_days ?? ''} onChange={(e) => set('deadline_days', e.target.value === '' ? null : Math.max(0, Math.min(1095, Number(e.target.value))))} />
        <Input label="Estimated value (USD)" type="number" min={0} value={value.estimated_value_cents === null ? '' : Math.round(value.estimated_value_cents / 100)} onChange={(e) => set('estimated_value_cents', e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value) * 100)))} />
      </div>
      <Input label="Source URL (required)" type="url" value={value.source_url ?? ''} onChange={(e) => set('source_url', e.target.value)} />
      <Input label="Last verified (required)" type="date" value={value.last_verified_at ?? ''} onChange={(e) => set('last_verified_at', e.target.value || null)} />
      <label className="block text-xs text-text-secondary">
        Default owner
        <select className={`${selectClass} mt-1 block w-full`} value={value.default_owner_role} onChange={(e) => set('default_owner_role', e.target.value as OwnerRole)}>
          {(Object.keys(OWNER_LABELS) as OwnerRole[]).map((o) => <option key={o} value={o}>{OWNER_LABELS[o]}</option>)}
        </select>
      </label>
      <fieldset>
        <legend className="mb-1 text-xs text-text-secondary">Required evidence</legend>
        <div className="grid grid-cols-2 gap-1">
          {ALL_EVIDENCE_KEYS.filter((k) => k !== 'rebate_preapproval' && k !== 'contractor_enrollment').map((k) => (
            <label key={k} className="flex items-center gap-2 text-xs text-text-primary">
              <input type="checkbox" checked={value.required_evidence.includes(k)} onChange={() => toggle(k)} /> {evidenceLabel(k)}
            </label>
          ))}
        </div>
      </fieldset>
      {value.step_kind === 'rebate' && (
        <label className="flex items-center gap-2 text-xs text-text-primary">
          <input type="checkbox" checked={value.requires_pre_approval} onChange={(e) => set('requires_pre_approval', e.target.checked)} />
          Program requires pre-approval before work starts (blocks job start)
        </label>
      )}
      <label className="flex items-center gap-2 text-xs text-text-primary">
        <input type="checkbox" checked={value.requires_contractor_enrollment} onChange={(e) => set('requires_contractor_enrollment', e.target.checked)} />
        Requires contractor enrollment
      </label>
      <label className="flex items-center gap-2 text-xs text-text-primary">
        <input type="checkbox" checked={value.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active
      </label>
    </div>
  );
}

function SummaryTab({ summary }: { summary: CloseoutSummary | null }) {
  if (!summary) return null;
  const months = [...summary.months].sort((a, b) => b.month.localeCompare(a.month));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Money at risk now (estimate)" value={formatCents(summary.at_risk_cents)} tone={summary.at_risk_cents > 0 ? 'warn' : 'ok'} />
        <Stat label="Claims / steps at risk" value={String(summary.at_risk_steps)} tone={summary.at_risk_steps > 0 ? 'warn' : 'ok'} />
        <Stat label="Overdue steps" value={String(summary.overdue_steps)} tone={summary.overdue_steps > 0 ? 'bad' : 'ok'} />
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="bg-bg-secondary text-xs text-text-secondary">
            <tr>
              <th className="px-3 py-2">Month</th>
              <th className="px-3 py-2">Recovered (paid rebates)</th>
              <th className="px-3 py-2">Protected (estimate)</th>
              <th className="px-3 py-2">Lost (estimate)</th>
              <th className="px-3 py-2">Missed steps</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month} className="border-t border-border text-text-primary">
                <td className="px-3 py-2">{m.month}</td>
                <td className="px-3 py-2">{formatCents(m.recovered_cents)}</td>
                <td className="px-3 py-2">{formatCents(m.protected_cents)}</td>
                <td className="px-3 py-2">{formatCents(m.lost_cents)}</td>
                <td className="px-3 py-2">{m.missed_steps}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-text-secondary">
        "Recovered" is the paid amount recorded on linked rebate applications. "Protected" and "Lost" are based on the estimated value you set on each step - they are estimates, not accounting figures.
      </p>
    </div>
  );
}
