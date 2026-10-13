import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Briefcase,
  ChevronDown,
  ChevronUp,
  FileText,
  Link2,
  Lock,
  MessageSquare,
  Pause,
  Phone,
  PhoneCall,
  Play,
  RotateCcw,
  RotateCw,
  Search,
  Sparkles,
  TrendingUp,
  UserPlus,
  Volume2,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { supabase, type Call } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';
import {
  activeTurnIndex,
  buildSentimentTimeline,
  findMatches,
  formatClock,
  formatDateTime,
  formatDuration,
  isUuid,
  parseTranscript,
  splitHighlight,
  type SentimentLabel,
  type TranscriptTurn,
} from '@/lib/callDetail';

// ============================================================
// TYPES & CONSTANTS
// ============================================================

interface LinkedLead {
  id: string;
  name: string;
  stage: string;
  customer_id: string | null;
  created_at: string;
}

interface LinkedJob {
  id: string;
  service_type: string | null;
  job_status: string;
  scheduled_datetime: string | null;
  address: string | null;
  invoice_status: string;
}

type LoadStatus = 'loading' | 'ready' | 'not_found' | 'error';
type SpeakerFilter = 'all' | 'caller' | 'agent';

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  new_lead: { label: 'New Lead', color: 'bg-accent/10 text-accent' },
  booked: { label: 'Booked', color: 'bg-success-500/10 text-success-500' },
  missed: { label: 'Missed', color: 'bg-danger/10 text-danger' },
  callback_requested: { label: 'Callback', color: 'bg-warning-500/10 text-warning-500' },
  spam: { label: 'Spam', color: 'bg-bg-tertiary text-text-secondary' },
};

const SENTIMENT_STYLE: Record<SentimentLabel, { label: string; text: string }> = {
  positive: { label: 'Positive', text: 'text-success-500' },
  neutral: { label: 'Neutral', text: 'text-text-secondary' },
  negative: { label: 'Negative', text: 'text-danger' },
};

const PLAYBACK_RATES = [1, 1.25, 1.5, 2];
const panelClass = 'rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark';

async function run<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data as T | null;
}

// ============================================================
// SMALL UI PIECES
// ============================================================

function Panel({ title, icon: Icon, children, action }: { title: string; icon: typeof Phone; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className={panelClass}>
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
    <div className="space-y-4" aria-busy="true" aria-label="Loading call">
      <Skeleton className="h-10 w-72" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-52 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// RECORDING PLAYER
// ============================================================

function RecordingPlayer({
  url,
  audioRef,
  fallbackDuration,
  onTime,
  onPlayingChange,
}: {
  url: string;
  audioRef: React.RefObject<HTMLAudioElement>;
  fallbackDuration: number | null;
  onTime: (sec: number) => void;
  onPlayingChange: (playing: boolean) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const sync = () => {
      setCurrent(audio.currentTime);
      onTime(audio.currentTime);
    };
    const meta = () => {
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      setState('ready');
    };
    const play = () => { setPlaying(true); onPlayingChange(true); };
    const pause = () => { setPlaying(false); onPlayingChange(false); };
    const fail = () => setState('error');
    audio.addEventListener('timeupdate', sync);
    audio.addEventListener('loadedmetadata', meta);
    audio.addEventListener('play', play);
    audio.addEventListener('pause', pause);
    audio.addEventListener('ended', pause);
    audio.addEventListener('error', fail);
    return () => {
      audio.removeEventListener('timeupdate', sync);
      audio.removeEventListener('loadedmetadata', meta);
      audio.removeEventListener('play', play);
      audio.removeEventListener('pause', pause);
      audio.removeEventListener('ended', pause);
      audio.removeEventListener('error', fail);
    };
  }, [audioRef, onTime, onPlayingChange]);

  const total = duration || fallbackDuration || 0;
  const jump = (delta: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = Math.max(0, Math.min(total || Infinity, audio.currentTime + delta));
  };
  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => setState('error'));
    else audio.pause();
  };
  const cycleRate = () => {
    const next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(rate) + 1) % PLAYBACK_RATES.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  if (state === 'error') {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-text-primary">
        <AlertTriangle size={16} className="shrink-0 text-danger" aria-hidden="true" />
        <span className="flex-1">The recording could not be loaded. It may have expired or been removed.</span>
        <a href={url} target="_blank" rel="noopener noreferrer" className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:border-accent/40">
          Open directly
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-3">
      <audio ref={audioRef} src={url} preload="metadata" />
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => jump(-10)} className="focus-ring flex h-9 w-9 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" aria-label="Back 10 seconds">
          <RotateCcw size={16} />
        </button>
        <button type="button" onClick={toggle} disabled={state === 'loading'} className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-transform hover:scale-105 disabled:opacity-50" aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
        </button>
        <button type="button" onClick={() => jump(10)} className="focus-ring flex h-9 w-9 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" aria-label="Forward 10 seconds">
          <RotateCw size={16} />
        </button>
        <Volume2 size={14} className="ml-1 hidden shrink-0 text-text-secondary sm:block" aria-hidden="true" />
        <input
          type="range"
          min={0}
          max={total || 0}
          step={0.1}
          value={Math.min(current, total || 0)}
          disabled={state === 'loading' || !total}
          onChange={(e) => {
            const audio = audioRef.current;
            if (audio) audio.currentTime = Number(e.target.value);
          }}
          aria-label="Seek recording"
          className="focus-ring h-1.5 min-w-0 flex-1 cursor-pointer accent-accent"
        />
        <button type="button" onClick={cycleRate} className="focus-ring w-12 shrink-0 rounded-lg border border-border py-1 text-xs font-medium text-text-primary hover:border-accent/40" aria-label={`Playback speed ${rate}x`}>
          {rate}x
        </button>
      </div>
      <p className="text-xs tabular-nums text-text-secondary">
        {state === 'loading' ? 'Loading recording…' : `${formatClock(current)} / ${formatClock(total)}`}
      </p>
    </div>
  );
}

// ============================================================
// SENTIMENT TIMELINE CHART
// ============================================================

function SentimentChart({
  points,
  duration,
  onSelect,
}: {
  points: ReturnType<typeof buildSentimentTimeline>['points'];
  duration: number;
  onSelect: (turnIndex: number) => void;
}) {
  const W = 320;
  const H = 110;
  const x = (i: number, atSec: number | null) => (atSec !== null && duration > 0 ? 12 + (atSec / duration) * (W - 24) : 12 + (points.length === 1 ? (W - 24) / 2 : (i / (points.length - 1)) * (W - 24)));
  const y = (score: number) => H / 2 - score * (H / 2 - 12);
  const coords = points.map((p, i) => ({ ...p, cx: x(i, p.atSec), cy: y(p.score) }));
  const colorFor = (label: SentimentLabel) => (label === 'positive' ? 'text-success-500' : label === 'negative' ? 'text-danger' : 'text-text-secondary');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="group" aria-label="Estimated caller sentiment across the call">
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="stroke-border" strokeDasharray="4 4" />
      <text x="2" y="10" className="fill-text-secondary" fontSize="8">Positive</text>
      <text x="2" y={H - 4} className="fill-text-secondary" fontSize="8">Negative</text>
      {coords.length > 1 && <polyline points={coords.map((c) => `${c.cx},${c.cy}`).join(' ')} fill="none" className="stroke-accent/60" strokeWidth="1.5" />}
      {coords.map((c) => (
        <g
          key={c.turnIndex}
          className={`${colorFor(c.label)} cursor-pointer focus:outline-none`}
          role="button"
          tabIndex={0}
          aria-label={`Caller turn ${c.turnIndex + 1}: ${c.label}`}
          onClick={() => onSelect(c.turnIndex)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(c.turnIndex); } }}
        >
          <circle cx={c.cx} cy={c.cy} r="9" fill="transparent" />
          <circle cx={c.cx} cy={c.cy} r="4.5" fill="currentColor" />
        </g>
      ))}
    </svg>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

export function CallDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();

  // Calls belong to the account, not the signed-in user: every query is scoped to the account owner.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canView = isOwner || permissions.can_view_billing || permissions.can_view_all_jobs;
  const canManage = isOwner || permissions.can_view_billing;
  const authReady = !authLoading && !profileLoading && !!profile;

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [call, setCall] = useState<Call | null>(null);
  const [leads, setLeads] = useState<LinkedLead[]>([]);
  const [jobs, setJobs] = useState<LinkedJob[]>([]);
  const [failedSections, setFailedSections] = useState<string[]>([]);
  const [addingLead, setAddingLead] = useState(false);

  const [query, setQuery] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState<SpeakerFilter>('all');
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [matchPos, setMatchPos] = useState(0);
  const [currentSec, setCurrentSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const turnRefs = useRef<Record<number, HTMLLIElement | null>>({});
  const loadToken = useRef(0);

  useKeyboardShortcut({ key: '/', handler: () => searchRef.current?.focus() });

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
    setQuery('');
    setMatchPos(0);

    let row: Call | null;
    try {
      row = await run<Call>(supabase.from('calls').select('*').eq('id', id).eq('user_id', accountOwnerId).maybeSingle());
    } catch {
      if (token === loadToken.current) setStatus('error');
      return;
    }
    if (token !== loadToken.current) return;
    if (!row) {
      setStatus('not_found');
      return;
    }

    const [leadsR, jobsR] = await Promise.allSettled([
      run<LinkedLead[]>(supabase.from('leads').select('id, name, stage, customer_id, created_at').eq('call_id', id).eq('user_id', accountOwnerId).order('created_at', { ascending: false })),
      run<LinkedJob[]>(supabase.from('jobs').select('id, service_type, job_status, scheduled_datetime, address, invoice_status').eq('call_id', id).eq('user_id', accountOwnerId).order('created_at', { ascending: false })),
    ]);
    if (token !== loadToken.current) return;

    const failed: string[] = [];
    setCall(row);
    if (leadsR.status === 'fulfilled') setLeads(leadsR.value ?? []);
    else { failed.push('linked lead'); setLeads([]); }
    if (jobsR.status === 'fulfilled') setJobs(jobsR.value ?? []);
    else { failed.push('linked job'); setJobs([]); }
    setFailedSections(failed);
    setStatus('ready');
  }, [authReady, canView, user, accountOwnerId, id]);

  useEffect(() => {
    load();
  }, [load]);

  // ---------- derived ----------
  const turns = useMemo(() => (call ? parseTranscript(call.transcript, call.duration_seconds, call.caller_name) : []), [call]);
  const sentiment = useMemo(() => buildSentimentTimeline(turns), [turns]);
  const roleFiltered = useMemo(() => turns.filter((t) => speakerFilter === 'all' || t.role === speakerFilter || (speakerFilter === 'agent' && t.role === 'unknown')), [turns, speakerFilter]);
  const matches = useMemo(() => findMatches(roleFiltered, query), [roleFiltered, query]);
  const matchSet = useMemo(() => new Set(matches.map((m) => m.turnIndex)), [matches]);
  const activeMatchTurn = matches.length ? matches[Math.min(matchPos, matches.length - 1)].turnIndex : -1;
  const visibleTurns: TranscriptTurn[] = onlyMatches && query.trim() ? roleFiltered.filter((t) => matchSet.has(t.index)) : roleFiltered;
  const playingTurn = useMemo(() => (isPlaying ? activeTurnIndex(turns, currentSec) : -1), [isPlaying, turns, currentSec]);
  const hasRecording = !!call?.recording_url;

  useEffect(() => {
    const target = activeMatchTurn >= 0 ? activeMatchTurn : query.trim() ? -1 : playingTurn;
    if (target >= 0) turnRefs.current[target]?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [activeMatchTurn, playingTurn, query]);

  const seekToTurn = (turn: TranscriptTurn) => {
    const audio = audioRef.current;
    if (!audio || turn.approxStartSec === null) return;
    audio.currentTime = turn.approxStartSec;
    audio.play().catch(() => {});
  };

  const stepMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    setMatchPos((p) => (p + dir + matches.length) % matches.length);
  };

  const handleAddLead = async () => {
    if (!call || !accountOwnerId || !canManage || addingLead) return;
    setAddingLead(true);
    const { data, error } = await supabase
      .from('leads')
      .insert({ user_id: accountOwnerId, call_id: call.id, name: call.caller_name?.trim() || 'Unknown caller', phone: call.caller_phone, stage: 'new' })
      .select('id, name, stage, customer_id, created_at')
      .single();
    setAddingLead(false);
    if (error || !data) {
      toast('Could not add this caller to Leads.', 'error');
      return;
    }
    setLeads((prev) => [data as LinkedLead, ...prev]);
    toast('Added to Leads.', 'success');
  };

  const handleCreateJob = () => {
    if (!call) return;
    navigate('/dashboard/jobs', {
      state: { prefill: { customer_name: call.caller_name ?? 'Unknown caller', service_type: '', call_id: call.id, lead_id: leads[0]?.id } },
    });
  };

  // ---------- gates & states ----------
  if (authReady && !canView) {
    return (
      <DashboardLayout activeLabel="Call History">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Call recordings and transcripts are restricted. Ask your account owner to grant you the "View Billing" or "View All Jobs" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const statusCfg = call ? STATUS_LABELS[call.status] ?? STATUS_LABELS.new_lead : null;
  const header = (
    <div className="mb-6 flex items-center gap-3">
      <button type="button" onClick={() => navigate('/dashboard/calls')} className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary" aria-label="Back to call history">
        <ArrowLeft size={18} />
      </button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-2xl font-bold tracking-tight text-text-primary md:text-3xl">{call ? call.caller_name || 'Unknown caller' : 'Call'}</h1>
        {call && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
            <span>{formatDateTime(call.call_datetime)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDuration(call.duration_seconds) ?? 'No duration'}</span>
            {statusCfg && <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusCfg.color}`}>{statusCfg.label}</span>}
            {call.is_emergency && <span className="rounded-full bg-danger/10 px-2.5 py-0.5 text-xs font-medium text-danger">Emergency</span>}
            {call.is_voicemail && <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs font-medium text-text-secondary">Voicemail</span>}
          </p>
        )}
      </div>
    </div>
  );

  if (!authReady || status === 'loading') {
    return (
      <DashboardLayout activeLabel="Call History">
        {header}
        <PageSkeleton />
      </DashboardLayout>
    );
  }

  if (status === 'not_found' || status === 'error' || !call) {
    const notFound = status === 'not_found';
    return (
      <DashboardLayout activeLabel="Call History">
        {header}
        <EmptyState
          icon={notFound ? PhoneCall : AlertTriangle}
          title={notFound ? 'Call not found' : 'Could not load this call'}
          description={notFound ? 'It may have been deleted, or the link is incorrect.' : 'Something went wrong while loading. Check your connection and try again.'}
          action={notFound ? { label: 'Back to call history', onClick: () => navigate('/dashboard/calls') } : { label: 'Try again', onClick: load }}
        />
      </DashboardLayout>
    );
  }

  const storedSentiment = call.sentiment ? SENTIMENT_STYLE[call.sentiment] : null;
  const first = sentiment.points[0];
  const last = sentiment.points[sentiment.points.length - 1];
  const objections = call.objections_raised ?? [];
  const upsells = call.upsell_opportunities ?? [];
  const hasIntelligence = call.call_score !== null || call.lead_score !== null || !!call.intent || objections.length > 0 || upsells.length > 0 || !!call.missed_opportunity_reason || !!call.recommended_follow_up || !!call.coaching_tip;

  return (
    <DashboardLayout activeLabel="Call History">
      {header}

      {failedSections.length > 0 && (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warning-500/40 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
          <AlertTriangle size={16} className="shrink-0 text-warning-500" aria-hidden="true" />
          <span className="flex-1">Some sections could not load: {failedSections.join(', ')}.</span>
          <button type="button" onClick={load} className="focus-ring rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-xs font-medium hover:border-accent/40">Retry</button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---------- MAIN COLUMN ---------- */}
        <div className="space-y-4 lg:col-span-2">
          <Panel title="Recording" icon={Volume2}>
            {call.recording_url ? (
              <RecordingPlayer url={call.recording_url} audioRef={audioRef} fallbackDuration={call.duration_seconds} onTime={setCurrentSec} onPlayingChange={setIsPlaying} />
            ) : (
              <p className="text-sm text-text-secondary">{call.is_voicemail ? 'No audio was stored for this voicemail.' : 'This call has no recording.'}</p>
            )}
          </Panel>

          <Panel title="AI summary" icon={Sparkles}>
            {call.summary ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">{call.summary}</p>
            ) : (
              <p className="text-sm text-text-secondary">{call.transcript ? 'No summary was generated for this call.' : 'There is no summary because the call has no transcript yet.'}</p>
            )}
            {call.recommended_follow_up && (
              <p className="mt-3 rounded-xl border border-accent/30 bg-accent/5 p-3 text-sm leading-relaxed text-text-primary">
                <span className="font-semibold">Recommended next step: </span>
                {call.recommended_follow_up}
              </p>
            )}
          </Panel>

          <Panel title="Sentiment timeline" icon={TrendingUp}>
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
              <span>
                Recorded sentiment: <span className={`font-medium ${storedSentiment?.text ?? ''}`}>{storedSentiment?.label ?? 'Not recorded'}</span>
              </span>
              {sentiment.trend && first && last && (
                <span>
                  Caller mood: <span className="font-medium capitalize text-text-primary">{first.label}</span> → <span className="font-medium capitalize text-text-primary">{last.label}</span> ({sentiment.trend})
                </span>
              )}
            </div>
            {sentiment.points.length >= 2 ? (
              <>
                <SentimentChart points={sentiment.points} duration={call.duration_seconds ?? 0} onSelect={(i) => { setQuery(''); turnRefs.current[i]?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); }} />
                <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                  Estimated from the caller's wording — the recording itself isn't analysed for tone. Select a point to jump to that moment in the transcript.
                </p>
              </>
            ) : (
              <p className="text-sm text-text-secondary">Not enough caller speech in the transcript to draw a timeline.</p>
            )}
          </Panel>

          <Panel
            title="Transcript"
            icon={MessageSquare}
            action={turns.length > 0 ? <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">{turns.length} turns</span> : undefined}
          >
            {turns.length === 0 ? (
              <p className="text-sm text-text-secondary">{call.is_voicemail ? 'This voicemail has not been transcribed.' : 'This call has no transcript.'}</p>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[12rem] flex-1">
                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
                    <input
                      ref={searchRef}
                      type="search"
                      value={query}
                      onChange={(e) => { setQuery(e.target.value); setMatchPos(0); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') setQuery(''); }}
                      placeholder="Search transcript…  (press /)"
                      aria-label="Search transcript"
                      className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-2 pl-9 pr-8 text-sm text-text-primary placeholder:text-text-secondary/60"
                    />
                    {query && (
                      <button type="button" onClick={() => setQuery('')} className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-secondary hover:text-text-primary" aria-label="Clear search">
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  <select value={speakerFilter} onChange={(e) => setSpeakerFilter(e.target.value as SpeakerFilter)} aria-label="Filter by speaker" className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
                    <option value="all">All speakers</option>
                    <option value="caller">Caller</option>
                    <option value="agent">Assistant</option>
                  </select>
                </div>

                {query.trim() && (
                  <div className="flex flex-wrap items-center gap-3 text-xs text-text-secondary" aria-live="polite">
                    <span>{matches.length ? `${Math.min(matchPos, matches.length - 1) + 1} of ${matches.length} ${matches.length === 1 ? 'turn' : 'turns'}` : 'No matches'}</span>
                    <button type="button" onClick={() => stepMatch(-1)} disabled={!matches.length} className="focus-ring rounded p-1 hover:bg-bg-tertiary disabled:opacity-40" aria-label="Previous match"><ChevronUp size={14} /></button>
                    <button type="button" onClick={() => stepMatch(1)} disabled={!matches.length} className="focus-ring rounded p-1 hover:bg-bg-tertiary disabled:opacity-40" aria-label="Next match"><ChevronDown size={14} /></button>
                    <label className="ml-auto flex items-center gap-1.5">
                      <input type="checkbox" checked={onlyMatches} onChange={(e) => setOnlyMatches(e.target.checked)} className="accent-accent" />
                      Only matching turns
                    </label>
                  </div>
                )}

                {visibleTurns.length === 0 ? (
                  <p className="py-6 text-center text-sm text-text-secondary">Nothing to show for these filters.</p>
                ) : (
                  <ol className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
                    {visibleTurns.map((t) => {
                      const isCaller = t.role === 'caller';
                      const isMatch = t.index === activeMatchTurn;
                      const canSeek = hasRecording && t.approxStartSec !== null;
                      return (
                        <li
                          key={t.index}
                          data-testid="transcript-turn"
                          ref={(el) => { turnRefs.current[t.index] = el; }}
                          className={`rounded-xl border p-3 transition-colors ${isMatch ? 'border-accent ring-2 ring-accent/30' : t.index === playingTurn ? 'border-accent/50 bg-accent/5' : 'border-border bg-bg-primary'}`}
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <span className={`text-xs font-semibold ${isCaller ? 'text-accent' : 'text-text-secondary'}`}>{t.speaker}</span>
                            {canSeek && (
                              <button type="button" onClick={() => seekToTurn(t)} className="focus-ring rounded px-1.5 py-0.5 text-xs tabular-nums text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" aria-label={`Play from about ${formatClock(t.approxStartSec)}`} title="Approximate position">
                                ≈ {formatClock(t.approxStartSec)}
                              </button>
                            )}
                          </div>
                          <p className="text-sm leading-relaxed text-text-primary">
                            {splitHighlight(t.text, query).map((seg, i) => (seg.match ? <mark key={i} className="rounded bg-warning-500/30 px-0.5 text-text-primary">{seg.text}</mark> : <span key={i}>{seg.text}</span>))}
                          </p>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {hasRecording && <p className="text-xs text-text-secondary">Times marked ≈ are estimated from the transcript length — the transcript has no exact timestamps.</p>}
              </div>
            )}
          </Panel>
        </div>

        {/* ---------- SIDE COLUMN ---------- */}
        <div className="space-y-4">
          <Panel title="Details" icon={Phone}>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-text-secondary">Caller</dt>
                <dd className="mt-0.5 font-medium text-text-primary">
                  {call.caller_phone ? <a href={`tel:${call.caller_phone}`} className="focus-ring hover:text-accent">{call.caller_phone}</a> : 'No phone on file'}
                </dd>
              </div>
              {(call.lead_source || call.source_label) && (
                <div>
                  <dt className="text-xs text-text-secondary">Source</dt>
                  <dd className="mt-0.5 font-medium text-text-primary">{call.source_label ?? call.lead_source?.replace(/_/g, ' ')}</dd>
                </div>
              )}
              {(call.escalated_to || call.escalated_at) && (
                <div>
                  <dt className="text-xs text-text-secondary">Escalation</dt>
                  <dd className="mt-0.5 font-medium text-text-primary">
                    {call.escalated_to ? `${call.escalated_to} notified` : 'Technician notified'}
                    {call.escalated_at ? ` · ${formatDateTime(call.escalated_at)}` : ''}
                  </dd>
                </div>
              )}
              {(call.tags ?? []).length > 0 && (
                <div>
                  <dt className="text-xs text-text-secondary">Tags</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {call.tags.map((tag) => <span key={tag} className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs text-text-primary">{tag}</span>)}
                  </dd>
                </div>
              )}
            </dl>
          </Panel>

          <Panel title="Linked records" icon={Link2}>
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Lead</p>
                {leads.length > 0 ? (
                  <ul className="space-y-2">
                    {leads.map((l) => (
                      <li key={l.id}>
                        <Link to={`/dashboard/leads/${l.id}`} className="focus-ring flex items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary p-3 text-sm hover:border-accent/40">
                          <span className="truncate font-medium text-text-primary">{l.name}</span>
                          <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs capitalize text-text-secondary">{l.stage}</span>
                        </Link>
                        {l.customer_id && <Link to={`/dashboard/customers/${l.customer_id}`} className="focus-ring mt-1 inline-block text-xs text-accent hover:underline">View customer</Link>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-text-secondary">No lead linked yet.</p>
                    {canManage && (
                      <Button size="sm" variant="secondary" onClick={handleAddLead} disabled={addingLead}>
                        <UserPlus size={14} aria-hidden="true" />
                        {addingLead ? 'Adding…' : 'Add lead'}
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Job</p>
                {jobs.length > 0 ? (
                  <ul className="space-y-2">
                    {jobs.map((j) => (
                      <li key={j.id}>
                        <Link to="/dashboard/jobs" className="focus-ring block rounded-xl border border-border bg-bg-primary p-3 text-sm hover:border-accent/40">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium text-text-primary">{j.service_type || 'Job'}</span>
                            <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs capitalize text-text-secondary">{j.job_status.replace(/_/g, ' ')}</span>
                          </span>
                          <span className="mt-1 block truncate text-xs text-text-secondary">
                            {[j.scheduled_datetime && formatDateTime(j.scheduled_datetime), j.address].filter(Boolean).join(' · ') || 'Not scheduled'}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-text-secondary">No job linked yet.</p>
                    {canManage && (
                      <Button size="sm" variant="secondary" onClick={handleCreateJob}>
                        <Briefcase size={14} aria-hidden="true" />
                        Create job
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Panel>

          {hasIntelligence && (
            <Panel title="Call intelligence" icon={FileText}>
              <div className="space-y-3 text-sm">
                {(call.call_score !== null || call.lead_score !== null) && (
                  <div className="grid grid-cols-2 gap-3">
                    {call.call_score !== null && (
                      <div className="rounded-xl border border-border bg-bg-primary p-3">
                        <p className="text-xl font-bold text-text-primary">{call.call_score}<span className="text-xs font-normal text-text-secondary">/100</span></p>
                        <p className="text-xs text-text-secondary">Call score</p>
                      </div>
                    )}
                    {call.lead_score !== null && (
                      <div className="rounded-xl border border-border bg-bg-primary p-3">
                        <p className="text-xl font-bold text-text-primary">{call.lead_score}<span className="text-xs font-normal text-text-secondary">/100</span></p>
                        <p className="text-xs text-text-secondary">Lead score</p>
                      </div>
                    )}
                  </div>
                )}
                {call.intent && <p className="text-text-secondary"><span className="font-medium text-text-primary">Intent: </span>{call.intent}</p>}
                {objections.length > 0 && (
                  <p className="text-text-secondary"><span className="font-medium text-text-primary">Objections ({call.objections_resolved ? 'resolved' : 'unresolved'}): </span>{objections.join(', ')}</p>
                )}
                {upsells.length > 0 && <p className="text-text-secondary"><span className="font-medium text-text-primary">Upsell opportunities: </span>{upsells.join(', ')}</p>}
                {call.missed_opportunity_reason && <p className="text-text-secondary"><span className="font-medium text-text-primary">Missed opportunity: </span>{call.missed_opportunity_reason}</p>}
                {call.coaching_tip && <p className="rounded-xl border border-border bg-bg-primary p-3 text-text-secondary"><span className="font-medium text-text-primary">Coaching tip: </span>{call.coaching_tip}</p>}
              </div>
            </Panel>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
