import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Briefcase,
  CheckCircle2,
  Circle,
  Clock,
  FileText,
  Lock,
  Mail,
  Megaphone,
  Phone,
  PhoneCall,
  RefreshCw,
  Sparkles,
  UserPlus,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { supabase, type Lead } from '@/lib/supabase';
import { fetchAggregateHistory } from '@/lib/activityLedger';
import {
  CHANNEL_OPTIONS,
  GRADE_META,
  buildCustomerPayload,
  buildDraftQuotePayload,
  buildScoreBreakdown,
  buildTimeline,
  formatCents,
  formatDateTime,
  formatTimeAgo,
  getConversionState,
  isScoreGrade,
  isUuid,
  quoteTotalCents,
  resolveSource,
  type ActivityEventLike,
  type CallLike,
  type JobLike,
  type LeadStage,
  type QuoteLike,
  type ScoreGrade,
  type TimelineKind,
  type TimelineTone,
  type TouchLike,
} from '@/lib/leadDetail';

// ============================================================
// TYPES & CONSTANTS
// ============================================================

interface CallRow extends CallLike {
  caller_phone: string | null;
  call_score: number | null;
  lead_score: number | null;
  intent: string | null;
  booking_outcome: string | null;
  missed_opportunity_reason: string | null;
  recommended_follow_up: string | null;
  objections_raised: string[] | null;
  objections_resolved: boolean | null;
  upsell_opportunities: string[] | null;
}

interface ScoreRow {
  score: number;
  grade: string;
  factors: unknown;
  updated_at: string;
}

interface CustomerRow {
  id: string;
  name: string;
  lifecycle_stage: string;
}

type LoadStatus = 'loading' | 'ready' | 'not_found' | 'error';

const STAGES: { key: LeadStage; label: string; dot: string }[] = [
  { key: 'new', label: 'New', dot: 'bg-accent' },
  { key: 'contacted', label: 'Contacted', dot: 'bg-blue-500' },
  { key: 'quoted', label: 'Quoted', dot: 'bg-warning-500' },
  { key: 'won', label: 'Won', dot: 'bg-success-500' },
  { key: 'lost', label: 'Lost', dot: 'bg-danger' },
];

const CALL_COLUMNS =
  'id, caller_name, caller_phone, call_datetime, duration_seconds, summary, status, is_voicemail, is_emergency, sentiment, lead_source, source_label, call_score, lead_score, intent, booking_outcome, missed_opportunity_reason, recommended_follow_up, objections_raised, objections_resolved, upsell_opportunities';
const QUOTE_COLUMNS = 'id, status, line_items, tax_percent, sent_at, responded_at, last_viewed_at, view_count, created_at';
const JOB_COLUMNS = 'id, service_type, job_status, created_at';
const TIMELINE_PREVIEW = 12;

const TIMELINE_ICONS: Record<TimelineKind, LucideIcon> = {
  lead: Users,
  call: PhoneCall,
  quote: FileText,
  job: Wrench,
  follow_up: RefreshCw,
  activity: Clock,
};

const TONE_DOT: Record<TimelineTone, string> = {
  neutral: 'bg-accent',
  positive: 'bg-success-500',
  negative: 'bg-danger',
  attention: 'bg-warning-500',
};

// ============================================================
// DATA HELPERS
// ============================================================

async function run<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data as T | null;
}

function settle<T>(result: PromiseSettledResult<T>, section: string, fallback: T, failed: string[]): T {
  if (result.status === 'fulfilled') return result.value;
  failed.push(section);
  return fallback;
}

// ============================================================
// SMALL UI PIECES
// ============================================================

const cardClass = 'rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark';

function Panel({ title, icon: Icon, children, action }: { title: string; icon: LucideIcon; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className={cardClass}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Icon size={16} className="text-accent" aria-hidden="true" />
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading lead">
      <Skeleton className="h-10 w-72" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  );
}

function ScoreRing({ score, grade }: { score: number; grade: ScoreGrade }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className={`relative h-24 w-24 shrink-0 ${GRADE_META[grade].tone}`} role="img" aria-label={`AI lead score ${pct} out of 100, ${GRADE_META[grade].label}`}>
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        <circle cx="40" cy="40" r={radius} fill="none" strokeWidth="7" className="stroke-bg-tertiary" />
        <circle cx="40" cy="40" r={radius} fill="none" strokeWidth="7" strokeLinecap="round" stroke="currentColor" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - pct / 100)} />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold leading-none text-text-primary">{pct}</span>
        <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wide">{GRADE_META[grade].label}</span>
      </span>
    </div>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

export function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();

  // Leads are shared across the whole account (owner + team) — every query is scoped to the account owner.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canView = isOwner || permissions.can_view_billing || permissions.can_view_all_jobs;
  const canManage = isOwner || permissions.can_view_billing;
  // Quotes are owner-only at the database level (RLS: user_id = auth.uid()), so conversion is too.
  const canConvert = isOwner;
  const authReady = !authLoading && !profileLoading && !!profile;

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [lead, setLead] = useState<Lead | null>(null);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [quotes, setQuotes] = useState<QuoteLike[]>([]);
  const [jobs, setJobs] = useState<JobLike[]>([]);
  const [history, setHistory] = useState<ActivityEventLike[]>([]);
  const [touches, setTouches] = useState<TouchLike[]>([]);
  const [score, setScore] = useState<ScoreRow | null>(null);
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [failedSections, setFailedSections] = useState<string[]>([]);

  const [converting, setConverting] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [showAllTimeline, setShowAllTimeline] = useState(false);
  const loadToken = useRef(0);

  useEffect(() => {
    if (authReady && profile && !profile.onboarding_completed) navigate('/onboarding', { replace: true });
  }, [authReady, profile, navigate]);

  const load = useCallback(async () => {
    if (!authReady || !canView || !user) return;
    if (!accountOwnerId) {
      setStatus('error');
      return;
    }
    if (!isUuid(id)) {
      setStatus('not_found');
      return;
    }
    const token = ++loadToken.current;
    setStatus('loading');
    setShowAllTimeline(false);

    let leadRow: Lead | null;
    try {
      leadRow = await run<Lead>(supabase.from('leads').select('*').eq('id', id).eq('user_id', accountOwnerId).maybeSingle());
    } catch {
      if (token === loadToken.current) setStatus('error');
      return;
    }
    if (token !== loadToken.current) return;
    if (!leadRow) {
      setStatus('not_found');
      return;
    }

    const own = (table: string, columns: string) => supabase.from(table).select(columns).eq('user_id', accountOwnerId);
    const [originR, phoneR, scoreR, jobsR, quotesR, touchesR, customerR, historyR] = await Promise.allSettled([
      leadRow.call_id ? run<CallRow>(own('calls', CALL_COLUMNS).eq('id', leadRow.call_id).maybeSingle()) : Promise.resolve(null),
      leadRow.phone
        ? run<CallRow[]>(own('calls', CALL_COLUMNS).eq('caller_phone', leadRow.phone).order('call_datetime', { ascending: false }).limit(25))
        : Promise.resolve([] as CallRow[]),
      run<ScoreRow>(own('lead_scores', 'score, grade, factors, updated_at').eq('lead_id', id).maybeSingle()),
      run<JobLike[]>(own('jobs', JOB_COLUMNS).eq('lead_id', id).order('created_at', { ascending: false })),
      run<QuoteLike[]>(own('quotes', QUOTE_COLUMNS).eq('lead_id', id).order('created_at', { ascending: false })),
      run<TouchLike[]>(
        own('marketing_attribution_touches', 'id, source, medium, campaign, landing_page, referrer, is_first_touch, occurred_at').eq('lead_id', id).order('occurred_at', { ascending: true }),
      ),
      leadRow.customer_id ? run<CustomerRow>(own('customers', 'id, name, lifecycle_stage').eq('id', leadRow.customer_id).maybeSingle()) : Promise.resolve(null),
      fetchAggregateHistory('lead', id) as Promise<ActivityEventLike[]>,
    ]);
    if (token !== loadToken.current) return;

    const failed: string[] = [];
    const origin = settle(originR, 'originating call', null, failed);
    const byPhone = settle(phoneR, 'call history', [] as CallRow[], failed) ?? [];
    const merged = new Map<string, CallRow>();
    [origin, ...byPhone].forEach((c) => c && merged.set(c.id, c));

    setLead(leadRow);
    setCalls([...merged.values()]);
    setScore(settle(scoreR, 'AI score', null, failed));
    setJobs(settle(jobsR, 'jobs', [] as JobLike[], failed) ?? []);
    setQuotes(settle(quotesR, 'quotes', [] as QuoteLike[], failed) ?? []);
    setTouches(settle(touchesR, 'attribution', [] as TouchLike[], failed) ?? []);
    setCustomer(settle(customerR, 'customer', null, failed));
    setHistory(settle(historyR, 'activity log', [] as ActivityEventLike[], failed) ?? []);
    setFailedSections(failed);
    setStatus('ready');
  }, [authReady, canView, user, accountOwnerId, id]);

  useEffect(() => {
    load();
  }, [load]);

  // ---------- derived ----------
  const originatingCall = useMemo(() => calls.find((c) => c.id === lead?.call_id) ?? null, [calls, lead?.call_id]);
  const source = useMemo(() => resolveSource(originatingCall, touches), [originatingCall, touches]);
  const breakdown = useMemo(() => buildScoreBreakdown(score?.factors), [score]);
  const timeline = useMemo(() => (lead ? buildTimeline({ lead, calls, quotes, jobs, history }) : []), [lead, calls, quotes, jobs, history]);
  const conversion = useMemo(() => (lead ? getConversionState(lead, quotes, jobs) : null), [lead, quotes, jobs]);
  const grade: ScoreGrade | null = score && isScoreGrade(score.grade) ? score.grade : null;

  // ---------- actions ----------
  const handleStage = async (stage: LeadStage) => {
    if (!lead || !accountOwnerId || !canManage || lead.stage === stage) return;
    const previous = lead.stage;
    setLead({ ...lead, stage });
    const { error } = await supabase.from('leads').update({ stage }).eq('id', lead.id).eq('user_id', accountOwnerId);
    if (error) {
      setLead((l) => (l ? { ...l, stage: previous } : l));
      toast('Could not update the stage.', 'error');
      return;
    }
    toast(`Moved to ${STAGES.find((s) => s.key === stage)?.label}.`, 'success');
  };

  const handleSaveNotes = async () => {
    if (!lead || !accountOwnerId || savingNotes) return;
    const next = notesDraft.trim();
    if (next === (lead.notes ?? '')) {
      setEditingNotes(false);
      return;
    }
    setSavingNotes(true);
    const { error } = await supabase.from('leads').update({ notes: next || null }).eq('id', lead.id).eq('user_id', accountOwnerId);
    setSavingNotes(false);
    if (error) {
      toast('Could not save notes.', 'error');
      return;
    }
    setLead({ ...lead, notes: next || null });
    setEditingNotes(false);
    toast('Notes saved.', 'success');
  };

  const handleTagSource = async (channel: string) => {
    if (!originatingCall || !accountOwnerId || !channel) return;
    const { error } = await supabase.from('calls').update({ lead_source: channel }).eq('id', originatingCall.id).eq('user_id', accountOwnerId);
    if (error) {
      toast('Could not tag the source.', 'error');
      return;
    }
    setCalls((prev) => prev.map((c) => (c.id === originatingCall.id ? { ...c, lead_source: channel } : c)));
    toast('Source tagged.', 'success');
  };

  const findExistingCustomer = async (l: Lead, owner: string): Promise<CustomerRow | null> => {
    const cols = 'id, name, lifecycle_stage';
    if (l.phone) {
      const byPhone = await run<CustomerRow>(supabase.from('customers').select(cols).eq('user_id', owner).eq('phone', l.phone).maybeSingle());
      if (byPhone) return byPhone;
    }
    if (l.email) return run<CustomerRow>(supabase.from('customers').select(cols).eq('user_id', owner).eq('email', l.email).maybeSingle());
    return null;
  };

  const handleConvert = async () => {
    if (!lead || !accountOwnerId || !canConvert || converting || !conversion) return;
    setConverting(true);
    let customerLinked = conversion.customerLinked;
    try {
      if (!customerLinked) {
        const inserted = await supabase.from('customers').insert(buildCustomerPayload(lead, accountOwnerId)).select('id, name, lifecycle_stage').single();
        let row = inserted.data as CustomerRow | null;
        if (inserted.error) {
          // 23505 = this phone/email already belongs to a customer: link to it rather than duplicating the contact.
          if (inserted.error.code !== '23505') throw inserted.error;
          row = await findExistingCustomer(lead, accountOwnerId);
          if (!row) throw inserted.error;
        }
        if (!row) throw new Error('No customer returned');
        const link = await supabase.from('leads').update({ customer_id: row.id }).eq('id', lead.id).eq('user_id', accountOwnerId);
        if (link.error) throw link.error;
        const linkedId = row.id;
        setLead((l) => (l ? { ...l, customer_id: linkedId } : l));
        setCustomer(row);
        customerLinked = true;
      }
    } catch {
      toast('Could not create or link the customer.', 'error');
      setConverting(false);
      return;
    }

    if (!conversion.hasOpenQuote) {
      const quoteRes = await supabase.from('quotes').insert(buildDraftQuotePayload(lead, accountOwnerId)).select(QUOTE_COLUMNS).single();
      if (quoteRes.error || !quoteRes.data) {
        toast('Customer linked, but the draft quote could not be created. Try again.', 'error');
        setConverting(false);
        return;
      }
      setQuotes((prev) => [quoteRes.data as unknown as QuoteLike, ...prev]);
    }
    setConverting(false);
    toast('Converted — customer linked and draft quote ready.', 'success');
  };

  const handleConvertToJob = () => {
    if (!lead) return;
    navigate('/dashboard/jobs', {
      state: { prefill: { customer_name: lead.name, service_type: lead.service_interested ?? '', lead_id: lead.id, call_id: lead.call_id ?? undefined } },
    });
  };

  // ---------- gates & states ----------
  if (authReady && !canView) {
    return (
      <DashboardLayout activeLabel="Leads">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Lead details are restricted. Ask your account owner to grant you the "View Billing" or "View All Jobs" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const header = (
    <div className="mb-6 flex items-center gap-3">
      <button
        type="button"
        onClick={() => navigate('/dashboard/leads')}
        className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
        aria-label="Back to leads"
      >
        <ArrowLeft size={18} />
      </button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-2xl font-bold tracking-tight text-text-primary md:text-3xl">{lead?.name ?? 'Lead'}</h1>
        {lead && (
          <p className="mt-1 text-sm text-text-secondary">
            Created {formatTimeAgo(lead.created_at)}
            {lead.service_interested ? ` · ${lead.service_interested}` : ''}
          </p>
        )}
      </div>
    </div>
  );

  if (!authReady || status === 'loading') {
    return (
      <DashboardLayout activeLabel="Leads">
        {header}
        <PageSkeleton />
      </DashboardLayout>
    );
  }

  if (status === 'not_found' || status === 'error' || !lead || !conversion) {
    const notFound = status === 'not_found';
    return (
      <DashboardLayout activeLabel="Leads">
        {header}
        <EmptyState
          icon={notFound ? Users : AlertTriangle}
          title={notFound ? 'Lead not found' : 'Could not load this lead'}
          description={notFound ? 'It may have been deleted, or the link is incorrect.' : 'Something went wrong while loading. Check your connection and try again.'}
          action={notFound ? { label: 'Back to leads', onClick: () => navigate('/dashboard/leads') } : { label: 'Try again', onClick: load }}
        />
      </DashboardLayout>
    );
  }

  const openQuote = quotes.find((q) => q.status === 'draft' || q.status === 'sent');
  const steps = [
    { done: conversion.customerLinked, label: 'Customer record', detail: customer ? customer.name : 'Not created yet' },
    { done: quotes.length > 0, label: 'Quote', detail: openQuote ? `${openQuote.status === 'draft' ? 'Draft' : 'Sent'} · ${formatCents(quoteTotalCents(openQuote))}` : quotes.length ? `${quotes.length} on file` : 'Not created yet' },
    { done: conversion.hasJob, label: 'Job', detail: conversion.hasJob ? `${jobs.length} linked` : 'Not scheduled yet' },
  ];
  const visibleTimeline = showAllTimeline ? timeline : timeline.slice(0, TIMELINE_PREVIEW);

  return (
    <DashboardLayout activeLabel="Leads">
      {header}

      {failedSections.length > 0 && (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warning-500/40 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
          <AlertTriangle size={16} className="shrink-0 text-warning-500" aria-hidden="true" />
          <span className="flex-1">Some sections could not load: {failedSections.join(', ')}.</span>
          <button type="button" onClick={load} className="focus-ring rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-xs font-medium hover:border-accent/40">
            Retry
          </button>
        </div>
      )}

      {/* Quick actions */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {lead.phone && (
          <a href={`tel:${lead.phone}`} className="focus-ring flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary hover:border-accent/40">
            <Phone size={15} className="text-accent" aria-hidden="true" /> Call
          </a>
        )}
        {lead.email && (
          <a href={`mailto:${lead.email}`} className="focus-ring flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary hover:border-accent/40">
            <Mail size={15} className="text-accent" aria-hidden="true" /> Email
          </a>
        )}
        {canManage && (
          <button type="button" onClick={handleConvertToJob} className="focus-ring flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary hover:border-accent/40">
            <Briefcase size={15} className="text-accent" aria-hidden="true" /> Convert to job
          </button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---------- MAIN COLUMN ---------- */}
        <div className="space-y-4 lg:col-span-2">
          <Panel title="Pipeline stage" icon={Users}>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Lead stage">
              {STAGES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  disabled={!canManage}
                  aria-pressed={lead.stage === s.key}
                  onClick={() => handleStage(s.key)}
                  className={`focus-ring rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    lead.stage === s.key ? `${s.dot} text-white` : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </Panel>

          <Panel
            title="Contact history"
            icon={Clock}
            action={<span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">{timeline.length}</span>}
          >
            <ol className="relative space-y-5 border-l border-border pl-5">
              {visibleTimeline.map((item) => {
                const Icon = TIMELINE_ICONS[item.kind];
                return (
                  <li key={item.id} className="relative">
                    <span className={`absolute -left-[27px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-bg-secondary ${TONE_DOT[item.tone]}`}>
                      <Icon size={9} className="text-white" aria-hidden="true" />
                    </span>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <p className="text-sm font-medium text-text-primary">{item.title}</p>
                      <time dateTime={item.at} className="text-xs text-text-secondary">{formatDateTime(item.at)}</time>
                    </div>
                    {item.detail && <p className="mt-0.5 text-sm leading-relaxed text-text-secondary">{item.detail}</p>}
                  </li>
                );
              })}
            </ol>
            {timeline.length > TIMELINE_PREVIEW && (
              <button type="button" onClick={() => setShowAllTimeline((v) => !v)} className="focus-ring mt-4 text-xs font-medium text-accent hover:underline">
                {showAllTimeline ? 'Show fewer' : `Show all ${timeline.length} events`}
              </button>
            )}
          </Panel>

          <Panel
            title="Notes"
            icon={FileText}
            action={
              canManage && !editingNotes ? (
                <button type="button" onClick={() => { setNotesDraft(lead.notes ?? ''); setEditingNotes(true); }} className="focus-ring text-xs font-medium text-accent hover:underline">
                  Edit
                </button>
              ) : undefined
            }
          >
            {editingNotes ? (
              <div className="space-y-2">
                <Textarea
                  autoFocus
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  rows={5}
                  maxLength={5000}
                  aria-label="Lead notes"
                  placeholder="Add notes about this lead…"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveNotes} disabled={savingNotes}>
                    {savingNotes ? 'Saving…' : 'Save'}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditingNotes(false)} disabled={savingNotes}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : lead.notes ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">{lead.notes}</p>
            ) : (
              <p className="text-sm text-text-secondary/70">No notes yet.</p>
            )}
          </Panel>
        </div>

        {/* ---------- SIDE COLUMN ---------- */}
        <div className="space-y-4">
          <Panel title="AI lead score" icon={Sparkles}>
            {score && grade ? (
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <ScoreRing score={score.score} grade={grade} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">{GRADE_META[grade].hint}</p>
                    <p className="mt-1 text-xs text-text-secondary">Updated {formatTimeAgo(score.updated_at)}</p>
                  </div>
                </div>
                {breakdown.length > 0 && (
                  <ul className="space-y-3 border-t border-border pt-4">
                    {breakdown.map((row) => (
                      <li key={row.key}>
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-text-primary">{row.label}</span>
                          <span className={row.points < 0 ? 'text-danger' : 'text-text-secondary'}>
                            {row.points > 0 ? '+' : ''}
                            {row.points}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-tertiary" aria-hidden="true">
                          <div className={`h-full rounded-full ${row.points < 0 ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${Math.min(100, (Math.abs(row.points) / row.max) * 100)}%` }} />
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-text-secondary">{row.explanation}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <p className="text-sm leading-relaxed text-text-secondary">Not scored yet. Scores are calculated automatically and appear here after the next scoring run.</p>
            )}

            {originatingCall && (originatingCall.intent || originatingCall.recommended_follow_up || originatingCall.missed_opportunity_reason || originatingCall.lead_score !== null || (originatingCall.objections_raised?.length ?? 0) > 0) && (
              <div className="mt-4 space-y-3 border-t border-border pt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">From the originating call</p>
                <div className="flex flex-wrap gap-1.5">
                  {originatingCall.intent && <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs text-text-primary">Intent: {originatingCall.intent}</span>}
                  {originatingCall.lead_score !== null && <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs text-text-primary">Call lead score: {originatingCall.lead_score}</span>}
                  {originatingCall.sentiment && <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs capitalize text-text-primary">{originatingCall.sentiment}</span>}
                  {originatingCall.is_emergency && <span className="rounded-full bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger">Emergency</span>}
                </div>
                {(originatingCall.objections_raised?.length ?? 0) > 0 && (
                  <p className="text-xs leading-relaxed text-text-secondary">
                    <span className="font-medium text-text-primary">Objections ({originatingCall.objections_resolved ? 'resolved' : 'unresolved'}): </span>
                    {originatingCall.objections_raised?.join(', ')}
                  </p>
                )}
                {originatingCall.missed_opportunity_reason && (
                  <p className="text-xs leading-relaxed text-text-secondary">
                    <span className="font-medium text-text-primary">Missed opportunity: </span>
                    {originatingCall.missed_opportunity_reason}
                  </p>
                )}
                {originatingCall.recommended_follow_up && (
                  <p className="rounded-xl border border-accent/30 bg-accent/5 p-3 text-xs leading-relaxed text-text-primary">
                    <span className="font-semibold">Recommended next step: </span>
                    {originatingCall.recommended_follow_up}
                  </p>
                )}
              </div>
            )}
          </Panel>

          <Panel title="Source attribution" icon={Megaphone}>
            <p className="text-base font-semibold text-text-primary">{source.label}</p>
            {source.provenance === 'unknown' ? (
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">No tracked source for this lead yet.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {source.evidence.map((e, i) => (
                  <li key={`${e.kind}-${i}`} className="rounded-xl border border-border bg-bg-primary p-3">
                    <p className="text-xs font-medium text-text-primary">
                      {e.kind === 'first_touch' ? 'First touch' : e.kind === 'last_touch' ? 'Latest touch' : e.kind === 'owner_tagged' ? 'Tagged channel' : 'Call label'}: {e.label}
                    </p>
                    {e.detail && <p className="mt-0.5 break-words text-xs text-text-secondary">{e.detail}</p>}
                  </li>
                ))}
              </ul>
            )}
            {canManage && originatingCall && !originatingCall.lead_source && (
              <label className="mt-3 block text-xs text-text-secondary">
                Tag the channel
                <select
                  defaultValue=""
                  onChange={(e) => handleTagSource(e.target.value)}
                  className="focus-ring mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                >
                  <option value="">Select a channel…</option>
                  {CHANNEL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
            )}
          </Panel>

          <Panel title="Convert" icon={UserPlus}>
            <ul className="space-y-3" aria-live="polite">
              {steps.map((s) => (
                <li key={s.label} className="flex items-start gap-3">
                  {s.done ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success-500" aria-label="Done" /> : <Circle size={18} className="mt-0.5 shrink-0 text-text-secondary/50" aria-label="Not done" />}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">{s.label}</p>
                    <p className="truncate text-xs text-text-secondary">{s.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-4 space-y-2">
              {canConvert ? (
                <Button size="sm" className="w-full" onClick={handleConvert} disabled={converting || (conversion.customerLinked && conversion.hasOpenQuote)}>
                  <UserPlus size={16} aria-hidden="true" />
                  {converting ? 'Converting…' : conversion.customerLinked && conversion.hasOpenQuote ? 'Customer and quote ready' : conversion.customerLinked ? 'Create draft quote' : 'Convert to customer + quote'}
                </Button>
              ) : (
                <p className="text-xs text-text-secondary">You can view this lead, but only the account owner can convert it to a customer and quote.</p>
              )}
              <div className="grid grid-cols-2 gap-2">
                {customer && (
                  <Link to={`/dashboard/customers/${customer.id}`} className="focus-ring rounded-lg border border-border px-3 py-2 text-center text-xs font-medium text-text-primary hover:border-accent/40">
                    View customer
                  </Link>
                )}
                {quotes.length > 0 && (
                  <Link to="/dashboard/quotes" className="focus-ring rounded-lg border border-border px-3 py-2 text-center text-xs font-medium text-text-primary hover:border-accent/40">
                    Open quotes
                  </Link>
                )}
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </DashboardLayout>
  );
}
