import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useRealtimeSubscription } from '@/lib/realtime';
import { LiveIndicator } from '@/components/LiveIndicator';
import {
  Phone,
  ArrowLeft,
  Search,
  TriangleAlert as AlertTriangle,
  X,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Ban,
  UserPlus,
  Wrench,
  Volume2,
  Play,
  Pause,
  MessageSquare,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Call } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';
import { TagEditor } from '@/components/TagEditor';
import { SavedViewsBar } from '@/components/SavedViewsBar';
import { exportToCsv } from '@/lib/csvExport';

// ============================================================
// TYPES
// ============================================================

type SortKey = 'call_datetime' | 'duration_seconds' | 'caller_name' | 'status' | 'sentiment';
type SortDir = 'asc' | 'desc';
type StatusFilter = 'all' | Call['status'];
type SentimentFilter = 'all' | 'positive' | 'neutral' | 'negative';

// ============================================================
// HELPERS
// ============================================================

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function escalationLabel(call: Call): string | null {
  if (!call.escalated_to && !call.escalated_at) return null;
  const who = call.escalated_to ? `${call.escalated_to} notified` : 'Technician notified';
  return call.escalated_at ? `${who} · ${formatDateTime(call.escalated_at)}` : who;
}

const statusConfig: Record<string, { label: string; color: string }> = {
  new_lead: { label: 'New Lead', color: 'bg-accent/10 text-accent' },
  booked: { label: 'Booked', color: 'bg-success-500/10 text-success-500' },
  missed: { label: 'Missed', color: 'bg-danger/10 text-danger' },
  callback_requested: { label: 'Callback', color: 'bg-warning-500/10 text-warning-500' },
  spam: { label: 'Spam', color: 'bg-bg-tertiary text-text-secondary' },
};

const sentimentConfig: Record<string, { label: string; color: string }> = {
  positive: { label: 'Positive', color: 'text-success-500' },
  neutral: { label: 'Neutral', color: 'text-text-secondary' },
  negative: { label: 'Negative', color: 'text-danger' },
};

// ============================================================
// SHARED UI
// ============================================================

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? statusConfig.new_lead;
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

// ============================================================
// AUDIO PLAYER
// ============================================================

function AudioPlayer({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      setProgress(audio.currentTime);
      setDuration(audio.duration || 0);
    };
    const onEnd = () => setPlaying(false);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('loadedmetadata', onTime);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnd);
      audio.removeEventListener('loadedmetadata', onTime);
    };
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().catch(() => {});
      setPlaying(true);
    }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * duration;
  };

  const pct = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-3">
      <audio ref={audioRef} src={url} preload="metadata" />
      <button
        type="button"
        onClick={toggle}
        className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-transform hover:scale-105"
      >
        {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
      </button>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <Volume2 size={14} className="text-text-secondary" />
          <div
            className="flex-1 cursor-pointer rounded-full bg-bg-tertiary"
            style={{ height: 6 }}
            onClick={seek}
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs text-text-secondary tabular-nums">
            {Math.floor(progress / 60)}:{String(Math.floor(progress % 60)).padStart(2, '0')} / {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, '0')}
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// CALL DETAIL PANEL
// ============================================================
import { CallSatisfactionWidget } from '@/components/CallSatisfactionWidget';
import { CustomerMemoryPanel } from '@/components/CustomerMemoryPanel';
function CallDetailPanel({
  call,
  onClose,
  onAction,
  onUpdate,
  tagSuggestions,
}: {
  call: Call;
  onClose: () => void;
  onAction: (action: string, call: Call) => void;
  onUpdate: (patch: Partial<Call>) => void;
  tagSuggestions: string[];
}) {
  const sentimentCfg = call.sentiment ? sentimentConfig[call.sentiment] : null;

  return (
    <motion.div
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="fixed right-0 top-0 z-50 h-full w-full max-w-md overflow-y-auto border-l border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg-secondary/95 px-6 py-4 backdrop-blur-md">
        <h2 className="text-base font-semibold text-text-primary">Call Details</h2>
        <button
          type="button"
          onClick={onClose}
          className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          aria-label="Close panel"
        >
          <X size={18} />
        </button>
      </div>

      <div className="px-6 py-5 space-y-5">
        {/* Caller info */}
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Phone size={22} />
            </span>
            <div>
              <h3 className="text-lg font-bold text-text-primary">{call.caller_name || 'Unknown caller'}</h3>
              <p className="text-sm text-text-secondary">{call.caller_phone || 'No phone on file'}</p>
            </div>
          </div>
        </div>

        {/* Meta row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border bg-bg-primary p-3">
            <p className="text-xs text-text-secondary">Date & Time</p>
            <p className="mt-1 text-sm font-medium text-text-primary">{formatDateTime(call.call_datetime)}</p>
          </div>
          <div className="rounded-xl border border-border bg-bg-primary p-3">
            <p className="text-xs text-text-secondary">Duration</p>
            <p className="mt-1 text-sm font-medium text-text-primary">{formatDuration(call.duration_seconds)}</p>
          </div>
          <div className="rounded-xl border border-border bg-bg-primary p-3">
            <p className="text-xs text-text-secondary">Status</p>
            <div className="mt-1"><StatusBadge status={call.status} /></div>
          </div>
          <div className="rounded-xl border border-border bg-bg-primary p-3">
            <p className="text-xs text-text-secondary">Sentiment</p>
            <p className={`mt-1 text-sm font-medium ${sentimentCfg ? sentimentCfg.color : 'text-text-secondary'}`}>
              {sentimentCfg ? sentimentCfg.label : '—'}
            </p>
          </div>
        </div>
                {/* Tags */}
        <div>
          <p className="mb-2 text-xs font-medium text-text-secondary">Tags</p>
          <TagEditor tags={call.tags ?? []} suggestions={tagSuggestions} onChange={(tags) => onUpdate({ tags })} />
        </div>

        {/* Lead source */}
        <div>
          <p className="mb-2 text-xs font-medium text-text-secondary">Source</p>
          <select
            value={call.lead_source ?? ''}
            onChange={(e) => onUpdate({ lead_source: e.target.value || null })}
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
          >
            <option value="">Unknown</option>
            <option value="google_ads">Google Ads</option>
            <option value="facebook_ads">Facebook/Instagram Ads</option>
            <option value="referral">Referral</option>
            <option value="organic">Organic / Website</option>
            <option value="direct">Direct Call</option>
            <option value="other">Other</option>
          </select>
        </div>
        {/* Emergency badge */}
        {call.is_emergency && (
          <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-danger" />
              <span className="text-sm font-medium text-danger">🚨 Emergency call</span>
            </div>
            {escalationLabel(call) && (
              <p className="mt-1.5 pl-[26px] text-xs text-text-secondary">{escalationLabel(call)}</p>
            )}
          </div>
        )}

        {/* Audio player */}
        {call.recording_url && (
          <div>
            <p className="mb-2 text-xs font-medium text-text-secondary">Recording</p>
            <AudioPlayer url={call.recording_url} />
          </div>
        )}

        {/* Summary */}
        {call.summary && (
          <div>
            <p className="mb-2 text-xs font-medium text-text-secondary">AI Summary</p>
            <p className="rounded-xl border border-border bg-bg-primary p-4 text-sm leading-relaxed text-text-primary">
              {call.summary}
            </p>
          </div>
        )}

        {/* Transcript */}
        {call.transcript && (
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
              <MessageSquare size={12} />
              Transcript
            </p>
            <div className="max-h-64 overflow-y-auto rounded-xl border border-border bg-bg-primary p-4">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">{call.transcript}</p>
            </div>
          </div>
        )}
        
        <CustomerMemoryPanel phone={call.caller_phone} />
                 {/* Call Intelligence */}
        {call.call_score !== null && (
          <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-4">
            <p className="text-xs font-medium text-text-secondary">Call Intelligence</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-2xl font-bold text-text-primary">{call.call_score}<span className="text-sm text-text-secondary">/100</span></p>
                <p className="text-xs text-text-secondary">Call Score</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-text-primary">{call.lead_score}<span className="text-sm text-text-secondary">/100</span></p>
                <p className="text-xs text-text-secondary">Lead Score</p>
              </div>
            </div>
            {call.intent && (
              <p className="text-sm text-text-primary"><span className="text-text-secondary">Intent:</span> {call.intent.replace(/_/g, ' ')}</p>
            )}
            {call.booking_outcome && call.booking_outcome !== 'not_applicable' && (
              <p className="text-sm text-text-primary"><span className="text-text-secondary">Outcome:</span> {call.booking_outcome.replace(/_/g, ' ')}</p>
            )}
            {call.objections_raised?.length > 0 && (
              <p className="text-sm text-text-primary">
                <span className="text-text-secondary">Objections:</span> {call.objections_raised.join(', ')}
                {call.objections_resolved === true && <span className="ml-1 text-success-500">(resolved)</span>}
                {call.objections_resolved === false && <span className="ml-1 text-danger">(not resolved)</span>}
              </p>
            )}
            {call.upsell_opportunities?.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs text-text-secondary">Upsell opportunities missed:</p>
                <div className="flex flex-wrap gap-1.5">
                  {call.upsell_opportunities.map((item) => (
                    <span key={item} className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {call.missed_opportunity_reason && (
              <div className="rounded-lg bg-warning-500/10 p-3 text-sm text-warning-500">
                <strong>Missed opportunity:</strong> {call.missed_opportunity_reason}
              </div>
            )}
            {call.recommended_follow_up && (
              <div className="rounded-lg bg-accent/10 p-3 text-sm text-accent">
                <strong>Recommended follow-up:</strong> {call.recommended_follow_up}
              </div>
            )}
            {call.coaching_tip && (
              <div className="rounded-lg bg-ai/10 p-3 text-sm text-ai">
                <strong>Coaching tip:</strong> {call.coaching_tip}
              </div>
            )}
          </div>
        )}
        {/* AI interaction satisfaction (NPS/CSAT) */}
        <CallSatisfactionWidget callId={call.id} userId={call.user_id} />

        {/* Quick actions */}
        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-xs font-medium text-text-secondary">Quick Actions</p>
          <div className="grid gap-2">
            <button
              type="button"
              onClick={() => onAction('create_job', call)}
              className="focus-ring flex items-center gap-3 rounded-xl border border-border bg-bg-primary px-4 py-3 text-left text-sm font-medium text-text-primary transition-colors hover:border-accent/40 hover:bg-bg-tertiary"
            >
              <Wrench size={16} className="text-accent" />
              Create Job
            </button>
            <button
              type="button"
              onClick={() => onAction('add_lead', call)}
              className="focus-ring flex items-center gap-3 rounded-xl border border-border bg-bg-primary px-4 py-3 text-left text-sm font-medium text-text-primary transition-colors hover:border-accent/40 hover:bg-bg-tertiary"
            >
              <UserPlus size={16} className="text-accent" />
              Add to Leads
            </button>
            <button
              type="button"
              onClick={() => onAction('mark_spam', call)}
              className="focus-ring flex items-center gap-3 rounded-xl border border-border bg-bg-primary px-4 py-3 text-left text-sm font-medium text-text-primary transition-colors hover:border-danger/40 hover:bg-danger/5 hover:text-danger"
            >
              <Ban size={16} className="text-danger" />
              Mark as Spam
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================
// MAIN CALLS PAGE
// ============================================================

export function CallsPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, isOwner, teamMember } = useAuth();
  const { toast } = useToast();

  const [allCalls, setAllCalls] = useState<Call[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [selectedCall, setSelectedCall] = useState<Call | null>(null);
  const [newlyArrivedId, setNewlyArrivedId] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>('all');
  const [emergencyOnly, setEmergencyOnly] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('call_datetime');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 15;

  const searchRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(async () => {
    if (!user) return;
    setDataLoading(true);
    try {
      const { data, error } = await supabase
        .from('calls')
        .select('*')
        .order('call_datetime', { ascending: false });
      if (error) throw error;
      setAllCalls((data ?? []) as Call[]);
    } catch {
      setAllCalls([]);
    } finally {
      setDataLoading(false);
    }
  }, [user]);
  const tagSuggestions = useMemo(
  () => Array.from(new Set(allCalls.flatMap((c) => c.tags ?? []))).sort(),
  [allCalls]
);

const updateCall = useCallback(
  async (id: string, patch: Partial<Call>) => {
    const { error } = await supabase.from('calls').update(patch).eq('id', id);
    if (error) {
      toast('Could not save changes.', 'error');
      return;
    }
    setAllCalls((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    setSelectedCall((prev) => (prev && prev.id === id ? { ...prev, ...patch } : prev));
  },
  [toast]
);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  // Realtime: new calls land in the list instantly instead of waiting for
  // the next page load. Filtered by account owner id — for a team member
  // `calls` rows are always keyed by the owner's id, not the member's own.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const callsLiveStatus = useRealtimeSubscription<Call>({
    channelName: `calls-page-${accountOwnerId ?? 'anon'}`,
    table: 'calls',
    event: 'INSERT',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: !!accountOwnerId,
    onChange: (payload) => {
      const row = payload.new as Call;
      setAllCalls((prev) => (prev.some((c) => c.id === row.id) ? prev : [row, ...prev]));
      setNewlyArrivedId(row.id);
      setTimeout(() => setNewlyArrivedId((cur) => (cur === row.id ? null : cur)), 2500);
    },
  });

  useKeyboardShortcut({
    key: '/',
    handler: () => searchRef.current?.focus(),
  });

  useKeyboardShortcut({
    key: 'Escape',
    handler: () => {
      if (selectedCall) {
        setSelectedCall(null);
      } else if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    },
  });

  // Filtered + sorted data
  const filteredCalls = useMemo(() => {
    let result = [...allCalls];

    // Search
    if (search.trim()) {
      const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
      result = result.filter((c) => {
        const haystack = [c.caller_name, c.caller_phone, c.summary, c.transcript]
          .filter(Boolean)
          .join(' \n ')
          .toLowerCase();
        return tokens.every((t) => haystack.includes(t));
      });
    }

    // Tag filter
    if (tagFilter !== 'all') {
      result = result.filter((c) => (c.tags ?? []).includes(tagFilter));
    }

    // Source filter
    if (sourceFilter !== 'all') {
      result = result.filter((c) => (c.lead_source ?? '') === sourceFilter);
    }

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter((c) => c.status === statusFilter);
    }

    // Sentiment filter
    if (sentimentFilter !== 'all') {
      result = result.filter((c) => c.sentiment === sentimentFilter);
    }

    // Emergency only
    if (emergencyOnly) {
      result = result.filter((c) => c.is_emergency);
    }

    // Date range
    if (dateFrom) {
      const from = new Date(dateFrom);
      from.setHours(0, 0, 0, 0);
      result = result.filter((c) => new Date(c.call_datetime) >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      result = result.filter((c) => new Date(c.call_datetime) <= to);
    }

    // Sort
    result.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'call_datetime') {
        cmp = new Date(a.call_datetime).getTime() - new Date(b.call_datetime).getTime();
      } else if (sortKey === 'duration_seconds') {
        cmp = (a.duration_seconds ?? 0) - (b.duration_seconds ?? 0);
      } else if (sortKey === 'caller_name') {
        cmp = (a.caller_name ?? '').localeCompare(b.caller_name ?? '');
      } else if (sortKey === 'status') {
        cmp = a.status.localeCompare(b.status);
      } else if (sortKey === 'sentiment') {
        cmp = (a.sentiment ?? '').localeCompare(b.sentiment ?? '');
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return result;
    }, [allCalls, search, statusFilter, sentimentFilter, emergencyOnly, dateFrom, dateTo, tagFilter, sourceFilter, sortKey, sortDir]);

  const totalPages = Math.ceil(filteredCalls.length / pageSize);
  const paginatedCalls = filteredCalls.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [search, statusFilter, sentimentFilter, emergencyOnly, dateFrom, dateTo]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ChevronDown size={14} className="text-text-secondary/40" />;
    return sortDir === 'asc' ? <ChevronUp size={14} className="text-accent" /> : <ChevronDown size={14} className="text-accent" />;
  };

  const handleAction = async (action: string, call: Call) => {
    if (action === 'mark_spam') {
      try {
        const { error } = await supabase.from('calls').update({ status: 'spam' }).eq('id', call.id);
        if (error) throw error;
        setAllCalls((prev) => prev.map((c) => (c.id === call.id ? { ...c, status: 'spam' } : c)));
        setSelectedCall(null);
        toast('Call marked as spam.', 'success');
      } catch {
        toast('Could not update call status.', 'error');
      }
    } else if (action === 'add_lead') {
      try {
        const { error } = await supabase.from('leads').insert({
          name: call.caller_name || 'Unknown',
          phone: call.caller_phone,
          call_id: call.id,
          stage: 'new',
        });
        if (error) throw error;
        toast('Lead created from call.', 'success');
        setSelectedCall(null);
      } catch {
        toast('Could not create lead.', 'error');
      }
    } else if (action === 'create_job') {
      try {
        const { data: leadData, error: leadError } = await supabase
          .from('leads')
          .insert({
            name: call.caller_name || 'Unknown',
            phone: call.caller_phone,
            call_id: call.id,
            stage: 'won',
          })
          .select()
          .single();
        if (leadError) throw leadError;

        const { error: jobError } = await supabase.from('jobs').insert({
          customer_name: call.caller_name || 'Unknown',
          call_id: call.id,
          lead_id: leadData.id,
          job_status: 'scheduled',
        });
        if (jobError) throw jobError;

        toast('Job created from call.', 'success');
        setSelectedCall(null);
      } catch {
        toast('Could not create job from call.', 'error');
      }
    }
  };

  const clearFilters = () => {
    setSearch('');
    setStatusFilter('all');
    setSentimentFilter('all');
    setEmergencyOnly(false);
    setDateFrom('');
    setDateTo('');
  };

    const hasActiveFilters = search || statusFilter !== 'all' || sentimentFilter !== 'all' || emergencyOnly || dateFrom || dateTo || tagFilter !== 'all' || sourceFilter !== 'all';
      const currentFilters = { search, statusFilter, sentimentFilter, emergencyOnly, dateFrom, dateTo, tagFilter, sourceFilter };
  const applyFilters = (f: Record<string, unknown>) => {
    setSearch((f.search as string) ?? '');
    setStatusFilter((f.statusFilter as StatusFilter) ?? 'all');
    setSentimentFilter((f.sentimentFilter as SentimentFilter) ?? 'all');
    setEmergencyOnly(!!f.emergencyOnly);
    setDateFrom((f.dateFrom as string) ?? '');
    setDateTo((f.dateTo as string) ?? '');
    setTagFilter((f.tagFilter as string) ?? 'all');
    setSourceFilter((f.sourceFilter as string) ?? 'all');
  };
  const handleExportCsv = () => {
    exportToCsv(
      filteredCalls,
      [
        { header: 'Date', accessor: (c) => formatDateTime(c.call_datetime) },
        { header: 'Caller Name', accessor: (c) => c.caller_name ?? '' },
        { header: 'Phone', accessor: (c) => c.caller_phone ?? '' },
        { header: 'Status', accessor: (c) => c.status },
        { header: 'Sentiment', accessor: (c) => c.sentiment ?? '' },
        { header: 'Duration (s)', accessor: (c) => c.duration_seconds ?? '' },
        { header: 'Emergency', accessor: (c) => (c.is_emergency ? 'Yes' : 'No') },
        { header: 'Source', accessor: (c) => c.lead_source ?? '' },
        { header: 'Tags', accessor: (c) => (c.tags ?? []).join('; ') },
        { header: 'Summary', accessor: (c) => c.summary ?? '' },
      ],
      `calls-${new Date().toISOString().slice(0, 10)}.csv`
    );
  };

  return (
    <DashboardLayout activeLabel="Call History">
        {/* Page header */}
        <div className="mb-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Call History</h1>
              <LiveIndicator status={callsLiveStatus} />
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              {filteredCalls.length} {filteredCalls.length === 1 ? 'call' : 'calls'}
              {hasActiveFilters && ' (filtered)'}
            </p>
          </div>
        </div>

        {/* Search + Filters */}
        <div className="mb-6 space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary" />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by caller, phone, summary, or transcript…  (press /)"
                className="focus-ring w-full rounded-xl border border-border bg-bg-secondary py-2.5 pl-10 pr-4 text-sm text-text-primary placeholder:text-text-secondary/60"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary"
              >
                <option value="all">All statuses</option>
                <option value="new_lead">New Lead</option>
                <option value="booked">Booked</option>
                <option value="missed">Missed</option>
                <option value="callback_requested">Callback</option>
                <option value="spam">Spam</option>
              </select>
              <select
                value={sentimentFilter}
                onChange={(e) => setSentimentFilter(e.target.value as SentimentFilter)}
                className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary"
              >
                <option value="all">All sentiment</option>
                <option value="positive">Positive</option>
                <option value="neutral">Neutral</option>
                <option value="negative">Negative</option>
              </select>
                            <select
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary"
              >
                <option value="all">All tags</option>
                {tagSuggestions.map((tag) => (
                  <option key={tag} value={tag}>{tag}</option>
                ))}
              </select>
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary"
              >
                <option value="all">All sources</option>
                <option value="google_ads">Google Ads</option>
                <option value="facebook_ads">Facebook/Instagram Ads</option>
                <option value="referral">Referral</option>
                <option value="organic">Organic / Website</option>
                <option value="direct">Direct Call</option>
                <option value="other">Other</option>
              </select>
              <SavedViewsBar page="calls" currentFilters={currentFilters} onApply={applyFilters} />
              <button
                type="button"
                onClick={handleExportCsv}
                className="focus-ring flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary"
              >
                <Download size={15} /> Export CSV
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-xl border border-border bg-bg-secondary p-1 text-sm">
              <button
                type="button"
                onClick={() => setEmergencyOnly(false)}
                aria-pressed={!emergencyOnly}
                className={`focus-ring rounded-lg px-3 py-1.5 font-medium transition-colors ${
                  !emergencyOnly ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                All Calls
              </button>
              <button
                type="button"
                onClick={() => setEmergencyOnly(true)}
                aria-pressed={emergencyOnly}
                className={`focus-ring flex items-center gap-1 rounded-lg px-3 py-1.5 font-medium transition-colors ${
                  emergencyOnly ? 'bg-danger text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                🚨 Emergency Only
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="focus-ring rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
              />
              <span className="text-xs text-text-secondary">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="focus-ring rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
              />
            </div>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="focus-ring flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
              >
                <X size={14} />
                Clear filters
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        {dataLoading ? (
          <div className="rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
            <div className="space-y-px">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 p-4">
                  <SkeletonBlock className="h-5 w-32" />
                  <SkeletonBlock className="h-5 w-24" />
                  <SkeletonBlock className="h-5 w-16" />
                  <SkeletonBlock className="h-5 flex-1" />
                  <SkeletonBlock className="h-5 w-20" />
                </div>
              ))}
            </div>
          </div>
        ) : paginatedCalls.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
              <Phone size={26} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">
              {hasActiveFilters ? 'No calls match your filters' : 'No calls yet'}
            </h3>
            <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
              {hasActiveFilters
                ? 'Try adjusting or clearing your filters to see more calls.'
                : 'Incoming calls handled by Sarah will appear here automatically.'}
            </p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card md:block dark:shadow-card-dark">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-bg-tertiary/50">
                    <th className="px-4 py-3 text-left">
                      <button
                        type="button"
                        onClick={() => handleSort('call_datetime')}
                        className="focus-ring flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-text-primary"
                      >
                        Date <SortIcon col="call_datetime" />
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left">
                      <button
                        type="button"
                        onClick={() => handleSort('caller_name')}
                        className="focus-ring flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-text-primary"
                      >
                        Caller <SortIcon col="caller_name" />
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left">
                      <button
                        type="button"
                        onClick={() => handleSort('duration_seconds')}
                        className="focus-ring flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-text-primary"
                      >
                        Duration <SortIcon col="duration_seconds" />
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-text-secondary">Summary</th>
                    <th className="px-4 py-3 text-left">
                      <button
                        type="button"
                        onClick={() => handleSort('sentiment')}
                        className="focus-ring flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-text-primary"
                      >
                        Sentiment <SortIcon col="sentiment" />
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left">
                      <button
                        type="button"
                        onClick={() => handleSort('status')}
                        className="focus-ring flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-text-primary"
                      >
                        Status <SortIcon col="status" />
                      </button>
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-text-secondary">Emergency</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedCalls.map((call) => {
                    const sentimentCfg = call.sentiment ? sentimentConfig[call.sentiment] : null;
                    return (
                      <tr
                        key={call.id}
                        onClick={() => setSelectedCall(call)}
                        className={`cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-bg-tertiary/50 ${
                          newlyArrivedId === call.id ? 'bg-accent/5' : ''
                        }`}
                      >
                        <td className="px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                          {formatDateTime(call.call_datetime)}
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-text-primary whitespace-nowrap">
                          {call.caller_name || 'Unknown'}
                        </td>
                        <td className="px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                          {formatDuration(call.duration_seconds)}
                        </td>
                        <td className="px-4 py-3 text-sm text-text-secondary max-w-xs truncate">
                          {call.summary || '—'}
                        </td>
                        <td className="px-4 py-3 text-sm whitespace-nowrap">
                          {sentimentCfg ? (
                            <span className={sentimentCfg.color}>{sentimentCfg.label}</span>
                          ) : (
                            <span className="text-text-secondary">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={call.status} /></td>
                        <td className="px-4 py-3 text-center">
                          {call.is_emergency ? (
                            <div className="flex flex-col items-center gap-1">
                              <span className="inline-flex w-fit items-center gap-1 whitespace-nowrap rounded-full bg-danger/10 px-2.5 py-1 text-xs font-semibold text-danger">
                                🚨 Emergency
                              </span>
                              {escalationLabel(call) && (
                                <span className="whitespace-nowrap text-[11px] text-text-secondary">
                                  {escalationLabel(call)}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-text-secondary/30">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {paginatedCalls.map((call) => {
                const sentimentCfg = call.sentiment ? sentimentConfig[call.sentiment] : null;
                return (
                  <button
                    key={call.id}
                    type="button"
                    onClick={() => setSelectedCall(call)}
                    className={`focus-ring w-full rounded-2xl border border-border bg-bg-secondary p-4 text-left shadow-card transition-colors hover:border-accent/40 dark:shadow-card-dark ${
                      newlyArrivedId === call.id ? 'border-accent/40 bg-accent/5' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-text-primary">{call.caller_name || 'Unknown'}</span>
                      <StatusBadge status={call.status} />
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">{formatDateTime(call.call_datetime)}</p>
                    {call.summary && (
                      <p className="mt-2 text-sm text-text-secondary line-clamp-2">{call.summary}</p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                      <span className="text-text-secondary">{formatDuration(call.duration_seconds)}</span>
                      {sentimentCfg && <span className={sentimentCfg.color}>{sentimentCfg.label}</span>}
                      {call.is_emergency && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 font-semibold text-danger">
                          🚨 Emergency
                        </span>
                      )}
                    </div>
                    {call.is_emergency && escalationLabel(call) && (
                      <p className="mt-1 text-[11px] text-text-secondary">{escalationLabel(call)}</p>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-6 flex items-center justify-between">
                <p className="text-sm text-text-secondary">
                  Page {currentPage} of {totalPages}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      {/* Detail panel */}
      <AnimatePresence>
        {selectedCall && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm"
              onClick={() => setSelectedCall(null)}
            />
            <CallDetailPanel
  call={selectedCall}
  onClose={() => setSelectedCall(null)}
  onAction={handleAction}
  tagSuggestions={tagSuggestions}
  onUpdate={(patch) => updateCall(selectedCall.id, patch)}
/>
          </>
        )}
      </AnimatePresence>
    </DashboardLayout>
  );
}
