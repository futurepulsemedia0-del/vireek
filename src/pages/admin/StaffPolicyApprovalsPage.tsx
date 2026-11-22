// /staff/compliance-policies — policy approval workflow + workforce completion records (SOC 2 READINESS; GOV-01, GOV-02).
// Staff only (wrapped in <StaffRoute>; every write is an RPC that re-checks is_vireek_staff in SQL).
// Not an attestation. Workforce records hold completion FACTS only — never results, notes or documents.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonTable } from '@/components/Skeleton';
import { useComplianceT } from '@/i18n/complianceNamespace';
import { useSEO } from '@/lib/seo';
import {
  acknowledgePolicyVersion,
  addWorkforceRecord,
  approvePolicyVersion,
  fetchAckMatrix,
  fetchPolicyOverview,
  fetchWorkforceOverview,
  setWorkforceRequirement,
  submitPolicyVersion,
  withdrawPolicyVersion,
} from '@/lib/compliance/api';
import {
  buildPolicyCsv,
  isSelfApproval,
  latestKnownVersion,
  needsAttention,
  pendingAcknowledgements,
  sortPolicies,
  suggestNextVersion,
  summarizePolicies,
  validateSubmit,
  type AckMatrix,
  type PolicyOverview,
  type PolicyRow,
  type ReviewState,
} from '@/lib/compliance/policyApproval';
import {
  RECORD_TYPES,
  TRAINING_COURSES,
  WAIVER_CODES,
  summarizeWorkforce,
  validateRecordInput,
  type RecordInput,
  type RequirementState,
  type WorkforceOverview,
} from '@/lib/compliance/workforce';

type Tab = 'policies' | 'workforce';
type Load<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T };

const STATE_STYLE: Record<ReviewState, string> = {
  current: 'bg-success-subtle text-success',
  review_due: 'bg-warning-subtle text-warning',
  overdue: 'bg-danger/10 text-danger',
  content_changed: 'bg-danger/10 text-danger',
  never_approved: 'bg-bg-tertiary text-text-secondary',
};
const REQ_STYLE: Record<RequirementState, string> = {
  current: 'bg-success-subtle text-success',
  waived: 'bg-bg-tertiary text-text-secondary',
  expired: 'bg-warning-subtle text-warning',
  missing: 'bg-danger/10 text-danger',
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const fieldCls = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function StaffPolicyApprovalsPage() {
  const { t, language } = useComplianceT();
  useSEO({ title: `${t('policies.title')} | Vireek`, description: t('policies.subtitle') });
  const [tab, setTab] = useState<Tab>('policies');
  const [policies, setPolicies] = useState<Load<PolicyOverview>>({ status: 'loading' });
  const [workforce, setWorkforce] = useState<Load<WorkforceOverview>>({ status: 'loading' });
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const loadPolicies = useCallback(async () => {
    setPolicies({ status: 'loading' });
    try {
      setPolicies({ status: 'ready', data: await fetchPolicyOverview() });
    } catch {
      setPolicies({ status: 'error' });
    }
  }, []);
  const loadWorkforce = useCallback(async () => {
    setWorkforce({ status: 'loading' });
    try {
      setWorkforce({ status: 'ready', data: await fetchWorkforceOverview() });
    } catch {
      setWorkforce({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    void loadPolicies();
    void loadWorkforce();
  }, [loadPolicies, loadWorkforce]);

  const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' }) : t('policies.ack.none'));
  const ok = (key: string) => setMessage({ kind: 'ok', text: t(key) });
  const fail = (e: unknown, genericKey: string) => setMessage({ kind: 'error', text: e instanceof Error && e.message ? e.message : t(genericKey) });

  return (
    <>
      <Header />
      <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">{t('policies.title')}</h1>
            <p className="mt-1 text-sm text-text-secondary">{t('policies.subtitle')}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void (tab === 'policies' ? loadPolicies() : loadWorkforce())} loading={(tab === 'policies' ? policies : workforce).status === 'loading'}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t('policies.refresh')}
          </Button>
        </div>

        <p role="note" className="mt-4 flex gap-2 rounded-xl border border-border bg-bg-tertiary p-3 text-sm text-text-secondary">
          <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('policies.notice')}
        </p>

        <div role="tablist" aria-label={t('policies.title')} className="mt-6 flex gap-2 border-b border-border">
          {(['policies', 'workforce'] as const).map((k) => (
            <button
              key={k}
              role="tab"
              type="button"
              id={`tab-${k}`}
              aria-selected={tab === k}
              aria-controls={`panel-${k}`}
              onClick={() => setTab(k)}
              className={`focus-ring -mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === k ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary'}`}
            >
              {t(`policies.tab.${k}`)}
            </button>
          ))}
        </div>

        {message && (
          <p role={message.kind === 'error' ? 'alert' : 'status'} className={`mt-4 text-sm ${message.kind === 'error' ? 'text-danger' : 'text-success'}`}>
            {message.text}
          </p>
        )}

        <div id="panel-policies" role="tabpanel" aria-labelledby="tab-policies" hidden={tab !== 'policies'}>
          {tab === 'policies' && (
            <PoliciesPanel
              state={policies}
              reload={loadPolicies}
              date={date}
              onOk={ok}
              onFail={fail}
              clearMessage={() => setMessage(null)}
            />
          )}
        </div>
        <div id="panel-workforce" role="tabpanel" aria-labelledby="tab-workforce" hidden={tab !== 'workforce'}>
          {tab === 'workforce' && <WorkforcePanel state={workforce} reload={loadWorkforce} date={date} onOk={ok} onFail={fail} clearMessage={() => setMessage(null)} />}
        </div>
      </main>
    </>
  );
}

// ------------------------------------------------------------------ policies

interface PanelProps<T> {
  state: Load<T>;
  reload: () => Promise<void>;
  date: (iso: string | null | undefined) => string;
  onOk: (key: string) => void;
  onFail: (e: unknown, genericKey: string) => void;
  clearMessage: () => void;
}

function PoliciesPanel({ state, reload, date, onOk, onFail, clearMessage }: PanelProps<PolicyOverview>) {
  const { t } = useComplianceT();
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [open, setOpen] = useState<{ slug: string; mode: 'submit' | 'approve' | 'acks' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [changeSummary, setChangeSummary] = useState('');
  const [effective, setEffective] = useState(todayIso());
  const [selfOk, setSelfOk] = useState(false);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [matrix, setMatrix] = useState<AckMatrix | null>(null);

  const data = state.status === 'ready' ? state.data : null;
  const rows = useMemo(() => (data ? sortPolicies(data.policies) : []), [data]);
  const summary = useMemo(() => (data ? summarizePolicies(data) : null), [data]);
  const visible = filter === 'attention' ? rows.filter(needsAttention) : rows;

  async function run(key: string, fn: () => Promise<unknown>, okKey: string) {
    clearMessage();
    setBusy(key);
    try {
      await fn();
      onOk(okKey);
      setOpen(null);
      setSelfOk(false);
      await reload();
    } catch (e) {
      onFail(e, 'policies.errors.generic');
    } finally {
      setBusy(null);
    }
  }

  function openSubmit(p: PolicyRow) {
    setVersion(suggestNextVersion(latestKnownVersion(p)));
    setChangeSummary('');
    setFormErrors([]);
    setOpen({ slug: p.slug, mode: 'submit' });
  }
  function doSubmit(p: PolicyRow) {
    const errs = validateSubmit({ version, changeSummary }, p, latestKnownVersion(p));
    setFormErrors(errs);
    if (errs.length) return;
    void run(`s-${p.slug}`, () => submitPolicyVersion(p.slug, version.trim(), changeSummary), 'policies.success.submitted');
  }
  async function openAcks(p: PolicyRow) {
    setOpen({ slug: p.slug, mode: 'acks' });
    setMatrix(null);
    try {
      setMatrix(await fetchAckMatrix(p.slug));
    } catch (e) {
      onFail(e, 'policies.errors.generic');
    }
  }

  if (state.status === 'loading') {
    return (
      <div className="mt-6" role="status" aria-label={t('policies.loading')}>
        <SkeletonTable rows={8} columns={6} />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="mt-6">
        <EmptyState icon={ShieldAlert} variant="load-failed" title={t('policies.error.title')} description={t('policies.error.body')} onRetry={() => void reload()} />
      </div>
    );
  }
  if (!data || rows.length === 0 || !summary) {
    return (
      <div className="mt-6">
        <EmptyState icon={ShieldQuestion} title={t('policies.empty.title')} description={t('policies.empty.body')} />
      </div>
    );
  }

  return (
    <>
      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {(
          [
            ['total', summary.total],
            ['current', summary.byState.current],
            ['attention', summary.total - summary.byState.current],
            ['selfApproved', summary.selfApproved],
            ['pendingAcks', summary.pendingAcknowledgements],
            ['inReview', summary.inReview],
          ] as const
        ).map(([k, v]) => (
          <Card key={k} interactive={false} className="!p-4">
            <dt className="text-xs text-text-secondary">{t(`policies.summary.${k}`)}</dt>
            <dd className="mt-1 text-2xl font-bold text-text-primary">{v}</dd>
          </Card>
        ))}
      </dl>

      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <label className="text-sm text-text-secondary">
          <span className="me-2">{t('dashboard.filter.label')}</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'attention')} className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
            <option value="all">{t('dashboard.filter.all')}</option>
            <option value="attention">{t('dashboard.filter.attention')}</option>
          </select>
        </label>
        <Button variant="secondary" size="sm" onClick={() => download(`vireek-policy-approvals-${todayIso()}.csv`, buildPolicyCsv(data))}>
          <Download className="h-4 w-4" aria-hidden="true" />
          {t('policies.export')}
        </Button>
      </div>

      <div className="mt-4 overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[60rem] text-start text-sm">
          <caption className="sr-only">{t('policies.table.caption')}</caption>
          <thead className="bg-bg-tertiary text-xs text-text-secondary">
            <tr>
              {(['policy', 'state', 'version', 'approved', 'nextReview', 'acks', 'actions'] as const).map((h) => (
                <th key={h} scope="col" className="px-3 py-2 text-start font-semibold">
                  {t(`policies.table.${h}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const pendingAcks = pendingAcknowledgements(p, data.active_staff);
              const self = p.pending ? isSelfApproval(p.pending, data.me) : false;
              return (
                <Fragment key={p.slug}>
                  <tr className="border-t border-border align-top">
                    <th scope="row" className="px-3 py-2 text-start font-normal">
                      <span className="text-text-primary">{p.title}</span>
                      <br />
                      <span className="font-mono text-xs text-text-secondary">{p.control_ids.join(', ')}</span>
                    </th>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATE_STYLE[p.review_state]}`}>{t(`policies.state.${p.review_state}`)}</span>
                      {p.pending && <p className="mt-1 text-xs text-text-secondary">{t('policies.pending.label', { version: p.pending.version })}</p>}
                    </td>
                    <td className="px-3 py-2 text-xs">{p.current?.version ?? t('policies.ack.none')}</td>
                    <td className="px-3 py-2 text-xs">
                      {p.current ? (
                        <>
                          {date(p.current.approved_at)}
                          <br />
                          <span className="text-text-secondary">{p.current.approver_email ?? t('policies.badge.noApprover')}</span>
                          {p.current.self_approved && <span className="ms-1 rounded-full bg-warning-subtle px-2 py-0.5 text-[11px] font-semibold text-warning">{t('policies.badge.self')}</span>}
                        </>
                      ) : (
                        t('policies.ack.none')
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{date(p.current?.next_review_due)}</td>
                    <td className="px-3 py-2 text-xs">
                      {p.current && p.requires_acknowledgement ? (
                        <button type="button" onClick={() => void openAcks(p)} className="focus-ring rounded underline-offset-2 hover:underline">
                          {t('policies.ack.count', { done: p.current.ack_count, total: data.active_staff })}
                        </button>
                      ) : (
                        t('policies.ack.none')
                      )}
                      {pendingAcks > 0 && p.current && !p.current.i_acknowledged && <p className="mt-1 text-text-secondary">{t('policies.ack.you')}</p>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        {!p.pending && (
                          <Button size="xs" variant="secondary" disabled={!p.repo_synced} disabledReason={t('policies.submit.hashMissing')} onClick={() => openSubmit(p)}>
                            {t('policies.action.submit')}
                          </Button>
                        )}
                        {p.pending && (
                          <>
                            <Button
                              size="xs"
                              variant="primary"
                              disabled={!p.pending.hash_matches_repo}
                              disabledReason={t('policies.approve.mismatch')}
                              onClick={() => {
                                setEffective(todayIso());
                                setSelfOk(false);
                                setOpen({ slug: p.slug, mode: 'approve' });
                              }}
                            >
                              {t('policies.action.approve')}
                            </Button>
                            <Button size="xs" variant="ghost" loading={busy === `w-${p.slug}`} onClick={() => void run(`w-${p.slug}`, () => withdrawPolicyVersion(p.pending!.version_id), 'policies.success.withdrawn')}>
                              {t('policies.action.withdraw')}
                            </Button>
                          </>
                        )}
                        {p.current && p.requires_acknowledgement && !p.current.i_acknowledged && (
                          <Button size="xs" variant="secondary" loading={busy === `a-${p.slug}`} onClick={() => void run(`a-${p.slug}`, () => acknowledgePolicyVersion(p.current!.version_id), 'policies.success.acknowledged')}>
                            {t('policies.action.acknowledge')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>

                  {open?.slug === p.slug && open.mode === 'submit' && (
                    <tr className="bg-bg-secondary">
                      <td colSpan={7} className="px-3 py-3">
                        <fieldset className="grid max-w-xl gap-3">
                          <legend className="text-sm font-semibold text-text-primary">{t('policies.submit.title')}</legend>
                          <label className="text-xs text-text-secondary">
                            {t('policies.submit.version')}
                            <input value={version} onChange={(e) => setVersion(e.target.value)} className={`${fieldCls} mt-1`} dir="ltr" inputMode="decimal" maxLength={8} />
                          </label>
                          <label className="text-xs text-text-secondary">
                            {t('policies.submit.summary')}
                            <textarea value={changeSummary} onChange={(e) => setChangeSummary(e.target.value)} className={`${fieldCls} mt-1`} rows={2} maxLength={300} />
                          </label>
                          {formErrors.length > 0 && (
                            <ul role="alert" className="text-xs text-danger">
                              {formErrors.map((er) => (
                                <li key={er}>{t(`policies.errors.${er}`)}</li>
                              ))}
                            </ul>
                          )}
                          <div className="flex gap-2">
                            <Button size="sm" variant="primary" loading={busy === `s-${p.slug}`} onClick={() => doSubmit(p)}>
                              {t('policies.action.submit')}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                              {t('policies.action.cancel')}
                            </Button>
                          </div>
                        </fieldset>
                      </td>
                    </tr>
                  )}

                  {open?.slug === p.slug && open.mode === 'approve' && p.pending && (
                    <tr className="bg-bg-secondary">
                      <td colSpan={7} className="px-3 py-3">
                        <fieldset className="grid max-w-xl gap-3">
                          <legend className="text-sm font-semibold text-text-primary">
                            {t('policies.action.approve')} · {p.pending.version}
                          </legend>
                          <label className="text-xs text-text-secondary">
                            {t('policies.approve.effective')}
                            <input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} className={`${fieldCls} mt-1`} dir="ltr" />
                          </label>
                          {self && (
                            <>
                              <p role="note" className="text-xs text-warning">
                                {t('policies.approve.selfWarning')}
                              </p>
                              <label className="flex items-start gap-2 text-xs text-text-primary">
                                <input type="checkbox" checked={selfOk} onChange={(e) => setSelfOk(e.target.checked)} className="mt-0.5" />
                                {t('policies.approve.selfConfirm')}
                              </label>
                            </>
                          )}
                          <div className="flex gap-2">
                            <Button size="sm" variant="primary" disabled={(self && !selfOk) || !effective} loading={busy === `p-${p.slug}`} onClick={() => void run(`p-${p.slug}`, () => approvePolicyVersion(p.pending!.version_id, effective), 'policies.success.approved')}>
                              {t('policies.action.confirm')}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                              {t('policies.action.cancel')}
                            </Button>
                          </div>
                        </fieldset>
                      </td>
                    </tr>
                  )}

                  {open?.slug === p.slug && open.mode === 'acks' && (
                    <tr className="bg-bg-secondary">
                      <td colSpan={7} className="px-3 py-3 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-text-primary">{t('policies.action.whoAcked')}</span>
                          <Button size="xs" variant="ghost" onClick={() => setOpen(null)}>
                            {t('policies.action.hide')}
                          </Button>
                        </div>
                        {!matrix ? (
                          <p className="mt-2 text-text-secondary" role="status">
                            {t('policies.loading')}
                          </p>
                        ) : (
                          <ul className="mt-2 grid gap-1">
                            {matrix.staff.map((s) => (
                              <li key={s.id} className="flex justify-between gap-4">
                                <span dir="ltr">{s.email}</span>
                                <span className={s.acknowledged_at ? 'text-success' : 'text-text-secondary'}>{s.acknowledged_at ? date(s.acknowledged_at) : t('policies.ack.none')}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ workforce

function WorkforcePanel({ state, reload, date, onOk, onFail, clearMessage }: PanelProps<WorkforceOverview>) {
  const { t } = useComplianceT();
  const blank: RecordInput = { subjectId: '', recordType: 'security_training', courseKey: 'security_awareness_annual', status: 'completed', completedOn: '', validUntil: '', waiverCode: '', providerLabel: '', externalRef: '' };
  const [form, setForm] = useState<RecordInput>(blank);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const data = state.status === 'ready' ? state.data : null;
  const summary = useMemo(() => (data ? summarizeWorkforce(data) : null), [data]);
  const staff = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of data?.matrix ?? []) m.set(c.subject_id, c.subject_email);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const set = <K extends keyof RecordInput>(k: K, v: RecordInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    const errs = validateRecordInput(form, todayIso());
    setErrors(errs);
    if (errs.length) return;
    clearMessage();
    setBusy('save');
    try {
      await addWorkforceRecord(form);
      onOk('workforce.success.recorded');
      setForm(blank);
      await reload();
    } catch (e) {
      onFail(e, 'workforce.errors.generic');
    } finally {
      setBusy(null);
    }
  }
  async function toggle(key: string, required: boolean) {
    clearMessage();
    setBusy(`r-${key}`);
    try {
      await setWorkforceRequirement(key, required);
      onOk('workforce.success.requirement');
      await reload();
    } catch (e) {
      onFail(e, 'workforce.errors.generic');
    } finally {
      setBusy(null);
    }
  }

  if (state.status === 'loading') {
    return (
      <div className="mt-6" role="status" aria-label={t('policies.loading')}>
        <SkeletonTable rows={6} columns={6} />
      </div>
    );
  }
  if (state.status === 'error' || !data || !summary) {
    return (
      <div className="mt-6">
        <EmptyState icon={ShieldAlert} variant="load-failed" title={t('policies.error.title')} description={t('policies.error.body')} onRetry={() => void reload()} />
      </div>
    );
  }

  return (
    <div className="mt-6 grid gap-8">
      <p role="note" className="rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-secondary">
        {t('workforce.notice')}
      </p>

      <section aria-labelledby="req-h">
        <h2 id="req-h" className="text-lg font-semibold text-text-primary">
          {t('workforce.requirements.title')}
        </h2>
        <ul className="mt-3 grid gap-2">
          {data.requirements.map((r) => (
            <li key={r.requirement_key} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3 text-sm">
              <div>
                <p className="font-medium text-text-primary">{t(`workforce.requirementName.${r.requirement_key}`, { defaultValue: r.requirement_key })}</p>
                <p className="text-xs text-text-secondary">
                  {r.required ? t('workforce.requirements.required') : t('workforce.requirements.notRequired')} · {r.max_age_days ? t('workforce.requirements.maxAge', { days: r.max_age_days }) : t('workforce.requirements.noExpiry')}
                  {!r.decided_at && ` · ${t('workforce.requirements.pending')}`}
                </p>
              </div>
              <Button size="xs" variant="secondary" loading={busy === `r-${r.requirement_key}`} onClick={() => void toggle(r.requirement_key, !r.required)}>
                {r.required ? t('workforce.requirements.setOptional') : t('workforce.requirements.setRequired')}
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="mx-h">
        <h2 id="mx-h" className="text-lg font-semibold text-text-primary">
          {t('workforce.matrix.title')}
        </h2>
        {data.matrix.length === 0 ? (
          <p className="mt-3 text-sm text-text-secondary">{t('workforce.matrix.empty')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[44rem] text-start text-sm">
              <caption className="sr-only">{t('workforce.matrix.caption')}</caption>
              <thead className="bg-bg-tertiary text-xs text-text-secondary">
                <tr>
                  {(['staff', 'requirement', 'state', 'completed', 'validUntil', 'provider'] as const).map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 text-start font-semibold">
                      {t(`workforce.matrix.${h}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.matrix.map((c) => (
                  <tr key={`${c.subject_id}-${c.requirement_key}`} className="border-t border-border">
                    <th scope="row" className="px-3 py-2 text-start font-normal" dir="ltr">
                      {c.subject_email}
                    </th>
                    <td className="px-3 py-2 text-xs">
                      {t(`workforce.requirementName.${c.requirement_key}`, { defaultValue: c.requirement_key })}
                      {!c.required && <span className="ms-1 text-text-secondary">({t('workforce.requirements.notRequired')})</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${REQ_STYLE[c.state]}`}>{t(`workforce.state.${c.state}`)}</span>
                    </td>
                    <td className="px-3 py-2 text-xs">{date(c.completed_on)}</td>
                    <td className="px-3 py-2 text-xs">{date(c.valid_until)}</td>
                    <td className="px-3 py-2 text-xs">{c.provider_label ?? t('policies.ack.none')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="add-h" className="max-w-2xl">
        <h2 id="add-h" className="text-lg font-semibold text-text-primary">
          {t('workforce.form.title')}
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-secondary">
            {t('workforce.form.subject')}
            <select value={form.subjectId} onChange={(e) => set('subjectId', e.target.value)} className={`${fieldCls} mt-1`}>
              <option value="">{t('workforce.form.none')}</option>
              {staff.map(([id, email]) => (
                <option key={id} value={id}>
                  {email}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-text-secondary">
            {t('workforce.form.type')}
            <select
              value={form.recordType}
              onChange={(e) => {
                const v = e.target.value as RecordInput['recordType'];
                setForm((f) => ({ ...f, recordType: v, courseKey: v === 'security_training' ? 'security_awareness_annual' : '' }));
              }}
              className={`${fieldCls} mt-1`}
            >
              {RECORD_TYPES.map((r) => (
                <option key={r} value={r}>
                  {t(`workforce.type.${r}`)}
                </option>
              ))}
            </select>
          </label>
          {form.recordType === 'security_training' && (
            <label className="text-xs text-text-secondary">
              {t('workforce.form.course')}
              <select value={form.courseKey} onChange={(e) => set('courseKey', e.target.value)} className={`${fieldCls} mt-1`}>
                {TRAINING_COURSES.map((c) => (
                  <option key={c} value={c}>
                    {t(`workforce.course.${c}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="text-xs text-text-secondary">
            {t('workforce.form.status')}
            <select value={form.status} onChange={(e) => set('status', e.target.value as RecordInput['status'])} className={`${fieldCls} mt-1`}>
              {(['completed', 'waived'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`workforce.status.${s}`)}
                </option>
              ))}
            </select>
          </label>
          {form.status === 'completed' ? (
            <>
              <label className="text-xs text-text-secondary">
                {t('workforce.form.completed')}
                <input type="date" max={todayIso()} value={form.completedOn} onChange={(e) => set('completedOn', e.target.value)} className={`${fieldCls} mt-1`} dir="ltr" />
              </label>
              <label className="text-xs text-text-secondary">
                {t('workforce.form.validUntil')}
                <input type="date" value={form.validUntil} onChange={(e) => set('validUntil', e.target.value)} className={`${fieldCls} mt-1`} dir="ltr" />
              </label>
            </>
          ) : (
            <label className="text-xs text-text-secondary">
              {t('workforce.form.waiver')}
              <select value={form.waiverCode} onChange={(e) => set('waiverCode', e.target.value)} className={`${fieldCls} mt-1`}>
                <option value="">{t('workforce.form.none')}</option>
                {WAIVER_CODES.map((w) => (
                  <option key={w} value={w}>
                    {t(`workforce.waiver.${w}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="text-xs text-text-secondary">
            {t('workforce.form.provider')}
            <input value={form.providerLabel} onChange={(e) => set('providerLabel', e.target.value)} className={`${fieldCls} mt-1`} maxLength={80} />
          </label>
          <label className="text-xs text-text-secondary">
            {t('workforce.form.reference')}
            <input value={form.externalRef} onChange={(e) => set('externalRef', e.target.value)} className={`${fieldCls} mt-1`} maxLength={64} dir="ltr" autoComplete="off" />
          </label>
        </div>
        {errors.length > 0 && (
          <ul role="alert" className="mt-3 text-xs text-danger">
            {errors.map((er) => (
              <li key={er}>{t(`workforce.errors.${er}`)}</li>
            ))}
          </ul>
        )}
        <div className="mt-4">
          <Button variant="primary" size="sm" loading={busy === 'save'} onClick={() => void save()}>
            {t('workforce.form.submit')}
          </Button>
        </div>
      </section>
    </div>
  );
}
