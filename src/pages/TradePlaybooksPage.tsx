import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, BookOpen, Check, ChevronDown, ChevronUp, ClipboardCheck, Clock, ListChecks, Lock,
  RefreshCw, ShieldAlert, Sparkles, TrendingUp, Workflow, Wrench, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { JobOutcomeDialog } from '@/components/playbooks/JobOutcomeDialog';
import { formatCents } from '@/lib/priceBook';
import { findPlaybook } from '@/lib/workflowPlaybooks';
import { matchJobType, type TradeJobType, type TradePlaybook } from '@/lib/tradePlaybookCatalog';
import { summarize, type JobOutcome, type JobTypeStats, type SuggestionKind, type TuningRow } from '@/lib/outcomeLearning';
import {
  TRADE_PLAYBOOKS, applySuggestion, dismissSuggestion, fetchAwaitingJobs, fetchOutcomes, fetchTradeState,
  installTradePlaybook, refreshSuggestions, type AwaitingJob, type LearningSuggestion, type TradeState,
} from '@/lib/tradePlaybooks';

const KIND_META: Record<SuggestionKind, { icon: LucideIcon; label: string }> = {
  price_adjust: { icon: TrendingUp, label: 'Pricing' },
  duration_adjust: { icon: Clock, label: 'Scheduling' },
  root_cause_article: { icon: BookOpen, label: 'AI knowledge' },
  checklist_critical: { icon: ListChecks, label: 'Quality' },
};

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark';
const BTN_SECONDARY = 'focus-ring flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-50';
const BTN_PRIMARY = 'focus-ring flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50';

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`);

function Metric({ label, target, actual, good }: { label: string; target: string; actual: string; good: boolean | null }) {
  const tone = good === null ? 'text-text-primary' : good ? 'text-success' : 'text-danger';
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`mt-0.5 text-base font-semibold ${tone}`}>{actual}</p>
      <p className="text-[11px] text-text-secondary">Target {target}</p>
    </div>
  );
}

function JobTypeCard({ jt, stats, tuning }: { jt: TradeJobType; stats: JobTypeStats; tuning: TuningRow | undefined }) {
  const [open, setOpen] = useState(false);
  const b = jt.benchmark;
  const targetDuration = tuning?.target_duration_minutes ?? b.durationMinutes;
  const learnedCritical = new Set(tuning?.critical_item_ids ?? []);
  const hasData = stats.n > 0;

  return (
    <div className={CARD}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">{jt.label}</h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            Typical ticket {formatCents(b.ticketMinCents)}–{formatCents(b.ticketMaxCents)} · {jt.checklist.length} checklist steps
            {jt.troubleshooting ? ` · ${jt.troubleshooting.causes.length} root causes` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">
            {hasData ? `${stats.n} jobs · ${stats.confidence} confidence` : 'No data yet'}
          </span>
          <button type="button" onClick={() => setOpen((v) => !v)} className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" aria-label={open ? `Collapse ${jt.label}` : `Expand ${jt.label}`} aria-expanded={open}>
            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Metric label="First-time fix" target={`${b.firstTimeFixPct}%`} actual={pct(stats.firstTimeFixPct)} good={stats.firstTimeFixPct === null ? null : stats.firstTimeFixPct >= b.firstTimeFixPct} />
        <Metric label="Callback rate" target={`≤ ${b.maxCallbackPct}%`} actual={pct(stats.callbackPct)} good={stats.callbackPct === null ? null : stats.callbackPct <= b.maxCallbackPct} />
        <Metric label="Median duration" target={`${targetDuration} min${tuning?.target_duration_minutes ? ' (tuned)' : ''}`} actual={stats.medianDurationMinutes === null ? '—' : `${Math.round(stats.medianDurationMinutes)} min`} good={stats.medianDurationMinutes === null ? null : stats.medianDurationMinutes <= targetDuration * 1.2} />
        <Metric label="Gross margin" target={`${b.targetMarginPct}%`} actual={pct(stats.marginPct)} good={stats.marginPct === null ? null : stats.marginPct >= b.targetMarginPct - 5} />
      </div>

      {open && (
        <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-text-primary"><ListChecks size={13} /> Checklist</p>
            <ul className="space-y-1 text-xs text-text-secondary">
              {jt.checklist.map((item) => (
                <li key={item.id} className="flex items-start gap-1.5">
                  <Check size={12} className="mt-0.5 shrink-0 text-text-secondary" />
                  <span>
                    {item.label}
                    {item.critical && <span className="ml-1.5 rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">Critical</span>}
                    {!item.critical && learnedCritical.has(item.id) && <span className="ml-1.5 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">Learned critical</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {jt.troubleshooting && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-text-primary"><Wrench size={13} /> Troubleshooting: {jt.troubleshooting.symptom}</p>
              <p className="mb-2 flex items-start gap-1.5 text-xs text-danger"><ShieldAlert size={13} className="mt-0.5 shrink-0" />{jt.troubleshooting.safety}</p>
              <ul className="space-y-2">
                {jt.troubleshooting.causes.map((c) => (
                  <li key={c.key} className="rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-secondary">
                    <p className="font-medium text-text-primary">{c.label} <span className="font-normal text-text-secondary">· {c.likelihood}</span></p>
                    <p className="mt-1"><span className="font-medium">Test:</span> {c.test}</p>
                    <p><span className="font-medium">Fix:</span> {c.fix}</p>
                    {c.parts.length > 0 && <p><span className="font-medium">Parts:</span> {c.parts.join(', ')}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[11px] text-text-secondary">
            Price Book seed: {jt.price.serviceName} · {formatCents(jt.price.priceCents)}{jt.price.priceMaxCents ? `–${formatCents(jt.price.priceMaxCents)}` : '+'} (baseline before your price multiplier).
          </p>
        </div>
      )}
    </div>
  );
}

function SuggestionCard({ s, busy, onApply, onDismiss }: { s: LearningSuggestion; busy: boolean; onApply: () => void; onDismiss: () => void }) {
  const meta = KIND_META[s.kind];
  const Icon = meta.icon;
  return (
    <div className="rounded-2xl border border-accent/30 bg-accent/5 p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-white"><Icon size={16} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-accent">{meta.label}</p>
          <h4 className="text-sm font-semibold text-text-primary">{s.title}</h4>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">{s.rationale}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(s.evidence).map(([k, v]) => (
              <span key={k} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">{k.replace(/_/g, ' ')}: {String(v)}</span>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={onApply} disabled={busy} className={BTN_PRIMARY}>{busy ? 'Working…' : 'Apply'}</button>
            <button type="button" onClick={onDismiss} disabled={busy} className={BTN_SECONDARY}>Dismiss</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TradePlaybooksPage() {
  const navigate = useNavigate();
  const { user, profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_edit_business_profile;
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [state, setState] = useState<TradeState | null>(null);
  const [outcomes, setOutcomes] = useState<JobOutcome[]>([]);
  const [awaiting, setAwaiting] = useState<AwaitingJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [multiplier, setMultiplier] = useState('1');
  const [installing, setInstalling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ job: AwaitingJob; playbook: TradePlaybook } | null>(null);

  const loadAll = useCallback(async () => {
    if (!ownerId || !canAccess) return;
    try {
      const [s, o, a] = await Promise.all([fetchTradeState(ownerId), fetchOutcomes(ownerId), fetchAwaitingJobs(ownerId)]);
      setState(s);
      setOutcomes(o);
      setAwaiting(a);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [ownerId, canAccess]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const defaultSlug = state?.installs[0]?.playbook_slug ?? TRADE_PLAYBOOKS.find((p) => p.slug === state?.primaryIndustry)?.slug ?? TRADE_PLAYBOOKS[0].slug;
  const playbook = TRADE_PLAYBOOKS.find((p) => p.slug === (selectedSlug ?? defaultSlug)) ?? TRADE_PLAYBOOKS[0];
  const install = state?.installs.find((i) => i.playbook_slug === playbook.slug);

  const statsByType = useMemo(() => {
    const map = new Map<string, JobTypeStats>();
    for (const jt of playbook.jobTypes) {
      map.set(jt.key, summarize(outcomes.filter((o) => o.playbook_slug === playbook.slug && o.job_type_key === jt.key), jt.benchmark));
    }
    return map;
  }, [playbook, outcomes]);

  const pending = useMemo(() => (state?.suggestions ?? []).filter((s) => s.status === 'pending' && s.playbook_slug === playbook.slug), [state, playbook]);
  const decidedCount = (state?.suggestions ?? []).filter((s) => s.status !== 'pending' && s.playbook_slug === playbook.slug).length;
  const outcomeCount = outcomes.filter((o) => o.playbook_slug === playbook.slug && !o.is_rework).length;

  const playbookForJob = (job: AwaitingJob): TradePlaybook =>
    matchJobType(playbook, job.service_type) ? playbook : TRADE_PLAYBOOKS.find((p) => matchJobType(p, job.service_type)) ?? playbook;

  const handleInstall = async () => {
    if (!ownerId || !user) return;
    const m = Number(multiplier);
    if (!Number.isFinite(m) || m <= 0) {
      toast('Enter a price multiplier greater than 0 (for example 1.0 or 1.25).', 'error');
      return;
    }
    setInstalling(true);
    try {
      const r = await installTradePlaybook(playbook, ownerId, user.id, m);
      toast(`${playbook.name} playbook installed — ${r.priceItemsAdded} price items and ${r.articlesAdded} knowledge articles added.`, 'success');
      await loadAll();
    } catch {
      toast('Could not install this playbook. Please try again.', 'error');
    } finally {
      setInstalling(false);
    }
  };

  const handleRefresh = async () => {
    if (!ownerId) return;
    setRefreshing(true);
    try {
      const added = await refreshSuggestions(ownerId);
      toast(added > 0 ? `${added} new suggestion${added === 1 ? '' : 's'} found.` : 'No new suggestions yet — keep recording outcomes.', 'success');
      await loadAll();
    } catch {
      toast('Could not refresh insights. Please try again.', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleApply = async (s: LearningSuggestion) => {
    if (!ownerId || !user) return;
    setBusyId(s.id);
    try {
      await applySuggestion(s, ownerId, user.id);
      toast('Suggestion applied.', 'success');
      await loadAll();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not apply this suggestion.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDismiss = async (s: LearningSuggestion) => {
    setBusyId(s.id);
    try {
      await dismissSuggestion(s.id);
      await loadAll();
    } catch {
      toast('Could not dismiss this suggestion.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleOutcomeSaved = async () => {
    setDialog(null);
    if (ownerId) {
      try {
        await refreshSuggestions(ownerId);
      } catch {
        // Insights can be refreshed manually; the outcome itself is already saved.
      }
    }
    await loadAll();
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Trade Playbooks">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">Trade Playbooks access is restricted. Ask your account owner to grant you the "Edit Business Profile" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Trade Playbooks">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary" aria-label="Back to dashboard">
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent"><ClipboardCheck size={16} /></span>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Trade Playbooks</h1>
            </div>
            <p className="mt-1 text-sm text-text-secondary">Checklists, troubleshooting, pricing and benchmarks per trade — improved by your real job outcomes</p>
          </div>
        </div>
        <button type="button" onClick={handleRefresh} disabled={refreshing || loading} className={BTN_SECONDARY}>
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Analyzing…' : 'Refresh insights'}
        </button>
      </div>

      {loading ? (
        <SkeletonCardList count={4} rows={3} />
      ) : loadFailed ? (
        <div className={`${CARD} text-center`}>
          <p className="text-sm text-text-primary">Could not load Trade Playbooks.</p>
          <button type="button" onClick={() => { setLoading(true); loadAll(); }} className={`${BTN_SECONDARY} mx-auto mt-3`}>Try again</button>
        </div>
      ) : (
        <FadeIn>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {TRADE_PLAYBOOKS.map((p) => {
              const installed = state?.installs.some((i) => i.playbook_slug === p.slug) ?? false;
              const active = p.slug === playbook.slug;
              return (
                <button key={p.slug} type="button" onClick={() => setSelectedSlug(p.slug)} aria-pressed={active}
                  className={`focus-ring rounded-2xl border p-5 text-left shadow-card transition-colors dark:shadow-card-dark ${active ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:bg-bg-tertiary'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-text-primary">{p.name}</h3>
                    <div className="flex gap-1.5">
                      {state?.primaryIndustry === p.slug && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">Your industry</span>}
                      {installed && <span className="flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent"><Check size={11} /> Installed</span>}
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">{p.tagline}</p>
                  <p className="mt-3 text-[11px] text-text-secondary">{p.jobTypes.length} job types · {p.jobTypes.reduce((n, j) => n + j.checklist.length, 0)} checklist steps</p>
                </button>
              );
            })}
          </div>

          <div className={`${CARD} mt-6`}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl">
                <h2 className="text-sm font-semibold text-text-primary">{playbook.name} playbook</h2>
                <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                  Installing adds only what you do not already have: Price Book entries (with cost estimates for margin guardrails) and AI triage articles. Nothing you own is overwritten.
                  {install ? ` Installed ${new Date(install.installed_at).toLocaleDateString()} — ${install.price_items_added} price items, ${install.articles_added} articles.` : ''}
                </p>
              </div>
              <div className="flex items-end gap-3">
                <div>
                  <label htmlFor="price-multiplier" className="mb-1 block text-[11px] font-medium text-text-secondary">Price multiplier</label>
                  <input id="price-multiplier" type="number" inputMode="decimal" min={0.25} max={5} step={0.05} value={multiplier} onChange={(e) => setMultiplier(e.target.value)}
                    className="focus-ring w-28 rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary" />
                </div>
                <button type="button" onClick={handleInstall} disabled={installing} className={BTN_PRIMARY}>
                  <Sparkles size={15} />
                  {installing ? 'Installing…' : install ? 'Re-install missing items' : 'Install playbook'}
                </button>
              </div>
            </div>
            <p className="mt-3 text-[11px] text-text-secondary">Seed prices are baselines in USD-style units — set the multiplier for your market and review them in the Price Book. Guidance is general good practice; technician judgment, local code and licensing always take precedence.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
              <Workflow size={13} /> Recommended automations:
              {playbook.workflowSlugs.map((slug) => (
                <Link key={slug} to="/dashboard/workflows" className="focus-ring rounded-full bg-bg-tertiary px-2 py-0.5 hover:text-text-primary">{findPlaybook(slug)?.name ?? slug}</Link>
              ))}
            </div>
          </div>

          <h2 className="mb-3 mt-8 text-lg font-semibold text-text-primary">Outcome learning</h2>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <p className="text-xs text-text-secondary">{outcomeCount} outcomes recorded · {pending.length} pending suggestions · {decidedCount} decided. Suggestions appear after enough data (see confidence) and never apply automatically.</p>
              {pending.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 p-6 text-center text-xs text-text-secondary">
                  No suggestions yet. Record outcomes for completed jobs — pricing, scheduling, checklist and AI-knowledge suggestions unlock as evidence builds.
                </div>
              ) : (
                pending.map((s) => <SuggestionCard key={s.id} s={s} busy={busyId === s.id} onApply={() => handleApply(s)} onDismiss={() => handleDismiss(s)} />)
              )}
            </div>

            <div className={CARD}>
              <h3 className="text-sm font-semibold text-text-primary">Completed jobs awaiting an outcome</h3>
              {awaiting.length === 0 ? (
                <p className="mt-2 text-xs text-text-secondary">All recent completed jobs have an outcome. Nice.</p>
              ) : (
                <ul className="mt-3 divide-y divide-border/60">
                  {awaiting.map((job) => (
                    <li key={job.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-text-primary">{job.customer_name}</p>
                        <p className="truncate text-[11px] text-text-secondary">{job.service_type ?? 'No service type'}{job.completed_at ? ` · ${new Date(job.completed_at).toLocaleDateString()}` : ''}</p>
                      </div>
                      <button type="button" onClick={() => setDialog({ job, playbook: playbookForJob(job) })} className={`${BTN_SECONDARY} shrink-0 px-3 py-1.5 text-xs`}>Record outcome</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <h2 className="mb-3 mt-8 text-lg font-semibold text-text-primary">{playbook.name} job types</h2>
          <div className="space-y-4">
            {playbook.jobTypes.map((jt) => (
              <JobTypeCard key={jt.key} jt={jt} stats={statsByType.get(jt.key) as JobTypeStats} tuning={state?.tuning.find((t) => t.playbook_slug === playbook.slug && t.job_type_key === jt.key)} />
            ))}
          </div>
        </FadeIn>
      )}

      {dialog && ownerId && (
        <JobOutcomeDialog job={dialog.job} playbook={dialog.playbook} ownerId={ownerId} onClose={() => setDialog(null)} onSaved={handleOutcomeSaved} />
      )}
    </DashboardLayout>
  );
}
