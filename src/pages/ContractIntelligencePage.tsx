import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, FileSearch, ShieldCheck, Timer } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { ContractTermsEditor, type StoredProfile } from '@/components/contracts/ContractTermsEditor';
import { supabase } from '@/lib/supabase';
import {
  ENGINE_VERSION,
  FLAG_LABELS,
  VERDICT_LABELS,
  VERDICT_STYLES,
  computePenaltyCents,
  coverageSignature,
  emptyTerms,
  evaluateJob,
  formatCountdown,
  normalizeTerms,
  type CoverageResult,
  type EngineContract,
  type EngineEquipment,
  type EngineProfile,
} from '@/lib/contractIntelligence';
import { formatCents } from '@/lib/contracts';

const CONTRACT_COLS =
  'id, contract_name, status, customer_id, start_date, end_date, auto_renew, renewal_notice_days, billing_frequency, contract_value_cents, sla_response_minutes_standard, sla_response_minutes_critical, sla_resolution_hours, penalty_percentage, penalty_cap_percentage';
const JOB_COLS =
  'id, customer_id, customer_name, service_type, tags, created_at, scheduled_datetime, job_status, invoice_amount, diagnosis_notes, first_response_at, call:call_id (is_emergency)';
const PROFILE_COLS =
  'id, contract_id, terms, evidence, missing_fields, source_kind, extraction_confidence, extraction_model, review_status, verified_at';
const HISTORY_DAYS = 45;
const OPEN_STATUSES = new Set(['scheduled', 'en_route', 'in_progress']);

interface JobRow {
  id: string;
  customer_id: string | null;
  customer_name: string;
  service_type: string | null;
  tags: string[] | null;
  created_at: string;
  scheduled_datetime: string | null;
  job_status: string;
  invoice_amount: number | null;
  diagnosis_notes: string | null;
  first_response_at: string | null;
  call: { is_emergency: boolean } | null;
}

interface CoverageRow {
  job_id: string;
  contract_id: string;
  verdict: string;
  billing_action: string;
  priority: string;
  response_deadline_at: string | null;
  terms_verified: boolean;
  flags: string[] | null;
  reasons: { tone: 'ok' | 'warn' | 'bad'; text: string }[] | null;
}

type Filter = 'open' | 'attention' | 'all';
type Tab = 'jobs' | 'contracts';

async function fetchIn<T>(ids: string[], build: (chunk: string[]) => PromiseLike<{ data: unknown }>, size = 80): Promise<T[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  const results = await Promise.all(chunks.map(build));
  return results.flatMap((r) => (r.data as T[] | null) ?? []);
}

const TONE_ICON = { ok: 'text-success-500', warn: 'text-warning-500', bad: 'text-danger' } as const;

function attentionRank(r: CoverageResult): number {
  if (r.flags.includes('sla_breached')) return 0;
  if (r.flags.includes('sla_at_risk')) return 1;
  if (r.verdict === 'needs_review') return 2;
  return 3;
}

function ResponseChip({ r }: { r: CoverageResult }) {
  const { status, remaining_ms, deadline_at, met_at } = r.response;
  if (status === 'not_applicable' || !deadline_at) return null;
  const deadline = new Date(deadline_at).getTime();
  let text: string;
  let cls: string;
  if (status === 'pending') {
    text = `Response deadline: ${formatCountdown(remaining_ms ?? 0)}`;
    cls = (remaining_ms ?? 0) < 3_600_000 ? 'bg-warning-500/10 text-warning-500' : 'bg-bg-tertiary text-text-secondary';
  } else if (status === 'met') {
    text = 'Responded within SLA';
    cls = 'bg-success-500/10 text-success-500';
  } else {
    const late = (met_at ? new Date(met_at).getTime() : Date.now()) - deadline;
    text = met_at ? `Responded ${formatCountdown(late)} late` : `SLA overdue by ${formatCountdown(late)}`;
    cls = 'bg-danger/10 text-danger';
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      <Timer size={11} /> {text}
    </span>
  );
}

export function ContractIntelligencePage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('jobs');
  const [filter, setFilter] = useState<Filter>('open');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const [contracts, setContracts] = useState<EngineContract[]>([]);
  const [profiles, setProfiles] = useState<Map<string, StoredProfile>>(new Map());
  const [customers, setCustomers] = useState<Map<string, string>>(new Map());
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [equipmentByJob, setEquipmentByJob] = useState<Map<string, EngineEquipment[]>>(new Map());
  const [loggedBreaches, setLoggedBreaches] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [loggingId, setLoggingId] = useState<string | null>(null);
  const synced = useRef<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data: cRows, error } = await supabase.from('commercial_contracts').select(CONTRACT_COLS).in('status', ['active', 'expiring_soon']);
    if (error) {
      toast('Failed to load contracts', 'error');
      setLoading(false);
      return;
    }
    const cs = (cRows ?? []) as unknown as EngineContract[];
    const customerIds = [...new Set(cs.map((c) => c.customer_id).filter((x): x is string => !!x))];
    const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();

    const [profRows, custRows, jobRows] = await Promise.all([
      fetchIn<StoredProfile>(cs.map((c) => c.id), (ids) => supabase.from('contract_intelligence_profiles').select(PROFILE_COLS).in('contract_id', ids)),
      fetchIn<{ id: string; name: string }>(customerIds, (ids) => supabase.from('customers').select('id, name').in('id', ids)),
      fetchIn<JobRow>(customerIds, (ids) =>
        supabase.from('jobs').select(JOB_COLS).in('customer_id', ids).gte('created_at', since).order('created_at', { ascending: false }).limit(500)
      ),
    ]);
    const jobIds = jobRows.map((j) => j.id);
    const [eqRows, covRows, breachRows] = await Promise.all([
      fetchIn<{ job_id: string; equipment: EngineEquipment | null }>(jobIds, (ids) =>
        supabase.from('job_equipment').select('job_id, equipment:equipment_id (id, equipment_type, make, warranty_expires_at)').in('job_id', ids)
      ),
      fetchIn<CoverageRow>(jobIds, (ids) =>
        supabase.from('job_contract_coverage').select('job_id, contract_id, verdict, billing_action, priority, response_deadline_at, terms_verified, flags, reasons').in('job_id', ids)
      ),
      fetchIn<{ job_id: string; breach_type: string }>(jobIds, (ids) => supabase.from('contract_sla_breaches').select('job_id, breach_type').in('job_id', ids)),
    ]);

    const eq = new Map<string, EngineEquipment[]>();
    for (const row of eqRows) {
      if (!row.equipment) continue;
      eq.set(row.job_id, [...(eq.get(row.job_id) ?? []), row.equipment]);
    }
    // Seed "already persisted" fingerprints so unchanged evaluations are never re-written.
    synced.current = new Map(
      covRows.map((r) => [
        r.job_id,
        coverageSignature({
          contract_id: r.contract_id,
          verdict: r.verdict,
          billing_action: r.billing_action,
          priority: r.priority,
          deadline_at: r.response_deadline_at,
          terms_verified: r.terms_verified,
          flags: r.flags ?? [],
          reasons: r.reasons ?? [],
        }),
      ])
    );

    setContracts(cs);
    setProfiles(new Map(profRows.map((p) => [p.contract_id, p])));
    setCustomers(new Map(custRows.map((c) => [c.id, c.name])));
    setJobs(jobRows);
    setEquipmentByJob(eq);
    setLoggedBreaches(new Set(breachRows.filter((b) => b.breach_type === 'response_time').map((b) => b.job_id)));
    setLoading(false);
  }, [user, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const engineProfiles = useMemo(() => {
    const m = new Map<string, EngineProfile>();
    for (const [id, p] of profiles) m.set(id, { terms: normalizeTerms(p.terms), review_status: p.review_status });
    return m;
  }, [profiles]);

  const evaluations = useMemo(() => {
    const out = new Map<string, CoverageResult>();
    for (const j of jobs) {
      const r = evaluateJob({
        job: { ...j, is_emergency: j.call?.is_emergency ?? false },
        contracts,
        profiles: engineProfiles,
        equipment: equipmentByJob.get(j.id) ?? [],
        responseMetAt: j.first_response_at,
        now: new Date(now),
      });
      if (r) out.set(j.id, r);
    }
    return out;
  }, [jobs, contracts, engineProfiles, equipmentByJob, now]);

  // Persist evaluations that changed (verdicts, deadlines, flags) — best effort.
  useEffect(() => {
    if (loading || !user || evaluations.size === 0) return;
    const dirty: Record<string, unknown>[] = [];
    for (const r of evaluations.values()) {
      const sig = coverageSignature({
        contract_id: r.contract_id,
        verdict: r.verdict,
        billing_action: r.billing_action,
        priority: r.priority,
        deadline_at: r.response.deadline_at,
        terms_verified: r.terms_verified,
        flags: r.flags,
        reasons: r.reasons,
      });
      if (synced.current.get(r.job_id) === sig) continue;
      synced.current.set(r.job_id, sig);
      dirty.push({
        user_id: user.id,
        job_id: r.job_id,
        contract_id: r.contract_id,
        verdict: r.verdict,
        billing_action: r.billing_action,
        priority: r.priority,
        response_target_minutes: r.response.target_minutes,
        response_started_at: r.response.started_at,
        response_deadline_at: r.response.deadline_at,
        response_met_at: r.response.met_at,
        reasons: r.reasons,
        flags: r.flags,
        terms_verified: r.terms_verified,
        engine_version: ENGINE_VERSION,
        evaluated_at: new Date().toISOString(),
      });
    }
    if (dirty.length === 0) return;
    (async () => {
      for (let i = 0; i < dirty.length; i += 100) {
        const chunk = dirty.slice(i, i + 100);
        const { error } = await supabase.from('job_contract_coverage').upsert(chunk, { onConflict: 'job_id' });
        if (error) for (const row of chunk) synced.current.delete(row.job_id as string);
      }
    })();
  }, [evaluations, loading, user]);

  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const contractById = useMemo(() => new Map(contracts.map((c) => [c.id, c])), [contracts]);

  const rows = useMemo(() => {
    const all = [...evaluations.values()];
    const filtered = all.filter((r) => {
      const job = jobById.get(r.job_id);
      if (!job) return false;
      if (filter === 'open') return OPEN_STATUSES.has(job.job_status);
      if (filter === 'attention') return attentionRank(r) < 3;
      return true;
    });
    return filtered.sort((a, b) => {
      const d = attentionRank(a) - attentionRank(b);
      if (d !== 0) return d;
      const ad = a.response.deadline_at ? new Date(a.response.deadline_at).getTime() : Infinity;
      const bd = b.response.deadline_at ? new Date(b.response.deadline_at).getTime() : Infinity;
      return ad - bd;
    });
  }, [evaluations, jobById, filter]);

  const kpis = useMemo(() => {
    const all = [...evaluations.values()];
    return {
      covered: all.filter((r) => r.verdict === 'covered' || r.verdict === 'partially_covered').length,
      atRisk: all.filter((r) => r.flags.includes('sla_at_risk')).length,
      breached: all.filter((r) => r.flags.includes('sla_breached')).length,
      verified: [...profiles.values()].filter((p) => p.review_status === 'verified').length,
    };
  }, [evaluations, profiles]);

  const logBreach = async (r: CoverageResult) => {
    const job = jobById.get(r.job_id);
    const contract = contractById.get(r.contract_id);
    if (!user || !job || !contract || !r.response.deadline_at) return;
    setLoggingId(r.job_id);
    const deadline = new Date(r.response.deadline_at).getTime();
    const actual = r.response.met_at ? new Date(r.response.met_at).getTime() : Date.now();
    const minutesOver = Math.max(1, Math.round((actual - deadline) / 60000));
    const terms = engineProfiles.get(contract.id)?.terms ?? emptyTerms();
    const { error } = await supabase.from('contract_sla_breaches').insert({
      user_id: user.id,
      contract_id: contract.id,
      job_id: job.id,
      breach_type: 'response_time',
      severity: minutesOver <= 30 ? 'minor' : minutesOver <= 240 ? 'major' : 'critical',
      expected_at: r.response.deadline_at,
      actual_at: new Date(actual).toISOString(),
      minutes_over: minutesOver,
      penalty_amount_cents: computePenaltyCents(contract, terms, job.invoice_amount, minutesOver),
      resolved: false,
      notes: `Logged from Contract Intelligence (${r.priority} priority, ${r.response.target_minutes} min target).`,
    });
    setLoggingId(null);
    if (error) return toast('Could not log the SLA breach.', 'error');
    setLoggedBreaches((prev) => new Set(prev).add(job.id));
    toast('SLA breach logged.', 'success');
  };

  const editingContract = editing ? contractById.get(editing) : undefined;

  return (
    <DashboardLayout activeLabel="Contract Intelligence">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><FileSearch size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Service Contract Intelligence</h1>
          <p className="text-sm text-text-secondary">Every job checked against the contract: what’s covered, what to bill, and the SLA clock.</p>
        </div>
        <Link to="/dashboard/contracts" className="focus-ring ml-auto shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
          Commercial Contracts →
        </Link>
      </div>

      {loading ? (
        <div className="space-y-6">
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={3} rows={2} />
        </div>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: 'Contract-covered jobs', value: kpis.covered, icon: CheckCircle2, tone: 'text-success-500' },
              { label: 'SLA at risk (< 1h)', value: kpis.atRisk, icon: Timer, tone: 'text-warning-500' },
              { label: 'SLA breached', value: kpis.breached, icon: AlertTriangle, tone: 'text-danger' },
              { label: 'Contracts verified', value: `${kpis.verified}/${contracts.length}`, icon: ShieldCheck, tone: 'text-accent' },
            ].map((k) => (
              <div key={k.label} className="rounded-xl border border-border bg-bg-secondary p-4">
                <k.icon size={16} className={k.tone} />
                <p className="mt-2 text-2xl font-bold text-text-primary">{k.value}</p>
                <p className="text-xs text-text-secondary">{k.label}</p>
              </div>
            ))}
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Contract intelligence views">
            {([['jobs', 'Job coverage'], ['contracts', `Contracts (${contracts.length})`]] as [Tab, string][]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`focus-ring rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${tab === key ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {label}
              </button>
            ))}
            {tab === 'jobs' && (
              <div className="ml-auto flex gap-1">
                {([['open', 'Open'], ['attention', 'Needs attention'], ['all', `Last ${HISTORY_DAYS} days`]] as [Filter, string][]).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                    className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${filter === key ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {tab === 'jobs' &&
            (contracts.length === 0 ? (
              <EmptyState icon={FileSearch} title="No active contracts yet" description="Add a commercial contract linked to a customer, then analyse it here — jobs for that customer are evaluated automatically." />
            ) : rows.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="Nothing here" description="No jobs match this view. Jobs for customers with an active contract appear as soon as they’re created." />
            ) : (
              <div className="space-y-3">
                {rows.map((r) => {
                  const job = jobById.get(r.job_id);
                  if (!job) return null;
                  const open = expanded === r.job_id;
                  const canLog = r.flags.includes('sla_breached') && !loggedBreaches.has(r.job_id);
                  return (
                    <div key={r.job_id} className="rounded-xl border border-border bg-bg-secondary p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${VERDICT_STYLES[r.verdict]}`}>{VERDICT_LABELS[r.verdict]}</span>
                            <span className="text-sm font-semibold text-text-primary">{job.customer_name}</span>
                            <span className="text-xs text-text-secondary">{job.service_type ?? 'No service type'} · {r.priority}</span>
                          </div>
                          <p className="mt-1.5 text-sm font-medium text-text-primary">{r.headline}</p>
                          <p className="text-sm text-accent">{r.action_line}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <ResponseChip r={r} />
                            {r.flags.filter((f) => f !== 'sla_breached' && f !== 'sla_at_risk').map((f) => (
                              <span key={f} className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs text-text-secondary">{FLAG_LABELS[f] ?? f}</span>
                            ))}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {canLog && (
                            <Button type="button" size="sm" variant="secondary" disabled={loggingId === r.job_id} onClick={() => logBreach(r)}>
                              {loggingId === r.job_id ? 'Logging…' : 'Log SLA breach'}
                            </Button>
                          )}
                          <button type="button" onClick={() => setExpanded(open ? null : r.job_id)} aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary">
                            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </button>
                        </div>
                      </div>
                      {open && (
                        <div className="mt-3 space-y-1.5 border-t border-border pt-3">
                          <p className="text-xs text-text-secondary">Contract: {r.contract_name}{r.response.target_minutes ? ` · target ${r.response.target_minutes} min` : ''}</p>
                          {r.reasons.map((x, i) => (
                            <p key={i} className="flex items-start gap-2 text-sm text-text-secondary">
                              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current ${TONE_ICON[x.tone]}`} />
                              {x.text}
                            </p>
                          ))}
                          {loggedBreaches.has(r.job_id) && <p className="text-xs text-text-secondary">An SLA breach is already logged for this job.</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

          {tab === 'contracts' &&
            (contracts.length === 0 ? (
              <EmptyState icon={FileSearch} title="No active contracts yet" description="Create a commercial contract first, then come back to analyse it." />
            ) : (
              <div className="space-y-3">
                {contracts.map((c) => {
                  const p = profiles.get(c.id);
                  const terms = p ? normalizeTerms(p.terms) : null;
                  const status = !p ? ['Not analysed', 'bg-bg-tertiary text-text-secondary'] : p.review_status === 'verified' ? ['Verified', 'bg-success-500/10 text-success-500'] : ['Draft — needs review', 'bg-warning-500/10 text-warning-500'];
                  return (
                    <div key={c.id} className="rounded-xl border border-border bg-bg-secondary p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${status[1]}`}>{status[0]}</span>
                            <span className="text-sm font-semibold text-text-primary">{c.contract_name}</span>
                          </div>
                          <p className="mt-1 text-xs text-text-secondary">
                            {c.customer_id ? customers.get(c.customer_id) ?? 'Customer' : 'No customer linked'} · value {formatCents(c.contract_value_cents)}
                            {c.end_date ? ` · ends ${c.end_date}` : ''}
                          </p>
                          {terms && (
                            <p className="mt-1.5 text-xs text-text-secondary">
                              Labor: {terms.responsibility.labor} · Parts: {terms.responsibility.parts} · {terms.sla.clock === 'business' ? 'business-hours clock' : '24/7 clock'}
                              {terms.coverage.exclusions.length > 0 ? ` · ${terms.coverage.exclusions.length} exclusions` : ''}
                            </p>
                          )}
                          {!c.customer_id && (
                            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-warning-500">
                              <AlertTriangle size={12} /> Link this contract to a customer or its jobs can’t be matched.
                            </p>
                          )}
                        </div>
                        <Button type="button" size="sm" variant={p ? 'secondary' : 'primary'} onClick={() => setEditing(c.id)}>
                          {p ? 'Review terms' : 'Analyse contract'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
        </>
      )}

      {editingContract && (
        <ContractTermsEditor
          contract={{ ...editingContract, customer_name: editingContract.customer_id ? customers.get(editingContract.customer_id) : undefined }}
          profile={profiles.get(editingContract.id) ?? null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </DashboardLayout>
  );
}
