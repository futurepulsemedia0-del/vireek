import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Link2, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { JobEvidenceChainPanel } from '@/components/jobs/JobEvidenceChainPanel';
import { supabase, type Job } from '@/lib/supabase';
import {
  LEVEL_META,
  fetchChainPortfolio,
  fetchChainRequirements,
  saveChainRequirement,
  shortHash,
  type ChainLevel,
  type ChainPortfolioRow,
  type ChainRequirement,
} from '@/lib/jobEvidenceChain';

const TONE_TEXT = {
  success: 'text-success-500',
  warning: 'text-warning-500',
  danger: 'text-danger',
  neutral: 'text-text-secondary',
} as const;

const TONE_BAR = {
  success: 'bg-success-500',
  warning: 'bg-warning-500',
  danger: 'bg-danger',
  neutral: 'bg-border',
} as const;

const LEVEL_FILTERS: { key: 'all' | ChainLevel; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'audit_ready', label: 'Audit-ready' },
  { key: 'strong', label: 'Strong' },
  { key: 'partial', label: 'Partial' },
  { key: 'weak', label: 'Weak' },
  { key: 'compromised', label: 'Compromised' },
  { key: 'not_started', label: 'Not started' },
];

const MIN_SCORES = [60, 70, 80, 90];
const DEFAULT_KEY = '*';

function ExpandedJob({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) setFailed(true);
        else setJob(data as Job);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (failed) return <p className="px-4 py-3 text-xs text-text-secondary">Could not load this job.</p>;
  if (!job) return <p className="px-4 py-3 text-xs text-text-secondary">Loading…</p>;
  return (
    <div className="p-3">
      <JobEvidenceChainPanel job={job} defaultExpanded />
    </div>
  );
}

export function EvidenceChainPage() {
  const { user, isOwner } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<ChainPortfolioRow[]>([]);
  const [requirements, setRequirements] = useState<Record<string, ChainRequirement | undefined>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<'all' | ChainLevel>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const [portfolio, reqs] = await Promise.all([fetchChainPortfolio(100), fetchChainRequirements()]);
      setRows(portfolio);
      setRequirements(Object.fromEntries(reqs.map((r) => [r.service_type, r])));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const serviceTypes = useMemo(
    () => [DEFAULT_KEY, ...Array.from(new Set(rows.map((r) => r.service_type).filter((v): v is string => !!v))).sort()],
    [rows],
  );

  const started = useMemo(() => rows.filter((r) => r.level !== 'not_started'), [rows]);
  const kpis = useMemo(() => {
    const avg = started.length ? Math.round(started.reduce((s, r) => s + r.score, 0) / started.length) : 0;
    const ready = started.filter((r) => r.level === 'audit_ready').length;
    return {
      avg,
      readyPct: started.length ? Math.round((ready / started.length) * 100) : 0,
      compromised: rows.filter((r) => r.level === 'compromised').length,
      blocked: started.filter((r) => r.blocking > 0).length,
    };
  }, [rows, started]);

  const visible = useMemo(() => {
    const list = filter === 'all' ? rows : rows.filter((r) => r.level === filter);
    return [...list].sort((a, b) => (a.level === 'compromised' ? -1 : b.level === 'compromised' ? 1 : a.score - b.score));
  }, [rows, filter]);

  const updateRequirement = async (serviceType: string, patch: Partial<Pick<ChainRequirement, 'enforce_on_close' | 'min_score'>>) => {
    if (!user) return;
    const current = requirements[serviceType] ?? { id: '', service_type: serviceType, enforce_on_close: false, min_score: 70 };
    const next = { ...current, ...patch };
    setRequirements((prev) => ({ ...prev, [serviceType]: next }));
    try {
      await saveChainRequirement(serviceType, { enforce_on_close: next.enforce_on_close, min_score: next.min_score }, user.id);
    } catch {
      toast('Could not save this requirement.', 'error');
      void load();
    }
  };

  return (
    <DashboardLayout activeLabel="Evidence Chain">
      <div className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
          <Link2 size={22} /> Job Evidence Chain
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-text-secondary">
          Every job carries a tamper-evident chain: Problem → Diagnosis → Evidence → Recommendation → Customer Approval → Part →
          Technician → Work → Test → Result → Payment → Warranty. No more "Compressor replaced" without the why, the proof and the test.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : failed ? (
        <EmptyState
          icon={Link2}
          title="Evidence chain is not available yet"
          description="Run the latest database migration (job evidence chain) and reload this page."
          action={{ label: 'Retry', onClick: () => void load() }}
        />
      ) : (
        <div className="space-y-8">
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: 'Average chain score', value: started.length ? `${kpis.avg}/100` : '—' },
              { label: 'Audit-ready jobs', value: started.length ? `${kpis.readyPct}%` : '—' },
              { label: 'Jobs with blocking gaps', value: String(kpis.blocked) },
              { label: 'Integrity failures', value: String(kpis.compromised), danger: kpis.compromised > 0 },
            ].map((k) => (
              <Card key={k.label} className="p-5">
                <p className="text-xs font-medium text-text-secondary">{k.label}</p>
                <p className={`mt-1 text-2xl font-bold ${k.danger ? 'text-danger' : 'text-text-primary'}`}>{k.value}</p>
              </Card>
            ))}
          </div>

          {/* Portfolio */}
          <section aria-labelledby="chain-portfolio">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="chain-portfolio" className="text-lg font-semibold text-text-primary">
                Recent jobs
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {LEVEL_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setFilter(f.key)}
                    aria-pressed={filter === f.key}
                    className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${
                      filter === f.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {visible.length === 0 ? (
              <EmptyState icon={ShieldCheck} title="No jobs to show" description="Jobs appear here as soon as they exist. New jobs start their chain automatically." />
            ) : (
              <ul className="divide-y divide-border/70 overflow-hidden rounded-2xl border border-border/80 bg-bg-secondary">
                {visible.map((r) => {
                  const meta = LEVEL_META[r.level];
                  const open = openId === r.job_id;
                  return (
                    <li key={r.job_id}>
                      <button
                        type="button"
                        onClick={() => setOpenId(open ? null : r.job_id)}
                        aria-expanded={open}
                        className="focus-ring flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg-primary/60"
                      >
                        {open ? <ChevronDown size={14} className="shrink-0 text-text-secondary" /> : <ChevronRight size={14} className="shrink-0 text-text-secondary" />}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-text-primary">{r.customer_name}</span>
                          <span className="block truncate text-xs text-text-secondary">
                            {r.service_type ?? 'General service'} · {r.job_status.replace(/_/g, ' ')} · {new Date(r.created_at).toLocaleDateString()}
                          </span>
                        </span>
                        <span className="hidden w-28 shrink-0 sm:block" aria-hidden="true">
                          <span className="block h-1.5 overflow-hidden rounded-full bg-border/60">
                            <span className={`block h-full rounded-full ${TONE_BAR[meta.tone]}`} style={{ width: `${r.level === 'not_started' ? 0 : r.score}%` }} />
                          </span>
                        </span>
                        <span className={`w-24 shrink-0 text-right text-xs font-semibold ${TONE_TEXT[meta.tone]}`}>
                          {r.level === 'not_started' ? meta.label : `${r.score} · ${meta.label}`}
                        </span>
                        <span className="hidden w-20 shrink-0 text-right text-xs text-text-secondary md:block">
                          {r.blocking > 0 ? `${r.blocking} gap${r.blocking === 1 ? '' : 's'}` : r.level === 'not_started' ? '' : 'no gaps'}
                        </span>
                        <span className="hidden w-24 shrink-0 text-right font-mono text-[10px] text-text-secondary lg:block" title={r.head_hash ?? undefined}>
                          {r.entries > 0 ? shortHash(r.head_hash, 10) : ''}
                        </span>
                      </button>
                      {open && <ExpandedJob jobId={r.job_id} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Enforcement (owner only) */}
          <section aria-labelledby="chain-enforcement">
            <h2 id="chain-enforcement" className="text-lg font-semibold text-text-primary">
              Close gate
            </h2>
            <p className="mb-3 mt-1 max-w-3xl text-sm text-text-secondary">
              Optionally block a job from being marked completed until its chain has no blocking gaps and reaches a minimum score. Off by default.
              A service type without its own rule falls back to the “All service types” rule.
            </p>
            {!isOwner ? (
              <p className="rounded-xl border border-dashed border-border bg-bg-secondary/50 px-4 py-6 text-center text-sm text-text-secondary">
                Only the account owner can change close-gate rules.
              </p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {serviceTypes.map((st) => {
                  const req = requirements[st] ?? { id: '', service_type: st, enforce_on_close: false, min_score: 70 };
                  return (
                    <Card key={st} className="p-4">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="truncate text-sm font-semibold text-text-primary">{st === DEFAULT_KEY ? 'All service types (default)' : st}</h3>
                        <label className="flex shrink-0 items-center gap-2 text-xs text-text-primary">
                          <input
                            type="checkbox"
                            checked={req.enforce_on_close}
                            onChange={(e) => void updateRequirement(st, { enforce_on_close: e.target.checked })}
                            className="h-4 w-4 rounded border-border"
                          />
                          Enforce on close
                        </label>
                      </div>
                      <div className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
                        <label htmlFor={`min-${st}`}>Minimum score</label>
                        <select
                          id={`min-${st}`}
                          value={req.min_score}
                          disabled={!req.enforce_on_close}
                          onChange={(e) => void updateRequirement(st, { min_score: Number(e.target.value) })}
                          className="rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary disabled:opacity-50"
                        >
                          {MIN_SCORES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </DashboardLayout>
  );
}
