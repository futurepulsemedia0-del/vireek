import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Star,
  MessageSquareText,
  Phone,
  Check,
  X,
  ThumbsDown,
  Link as LinkIcon,
  Settings,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, ReviewRequest, BusinessProfile } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';

// ============================================================
// HELPERS
// ============================================================

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(diff / 60000);
  return mins > 0 ? `${mins}m ago` : 'just now';
}

const STATUS_CONFIG: Record<ReviewRequest['status'], { label: string; badge: string }> = {
  sent: { label: 'Awaiting response', badge: 'bg-accent/10 text-accent' },
  completed: { label: 'Review left', badge: 'bg-success-500/10 text-success-500' },
  declined: { label: 'Declined', badge: 'bg-danger/10 text-danger' },
};

function StarRow({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          size={size}
          className={i < rating ? 'fill-warning-500 text-warning-500' : 'text-bg-tertiary'}
        />
      ))}
    </div>
  );
}

// ============================================================
// KPI CARD
// ============================================================

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  delay,
}: {
  icon: typeof Star;
  label: string;
  value: string;
  sub: string;
  delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <Icon size={18} />
      </span>
      <p className="mt-4 text-2xl font-bold tracking-tight text-text-primary">{value}</p>
      <p className="mt-0.5 text-sm font-medium text-text-secondary">{label}</p>
      <p className="mt-0.5 text-xs text-text-secondary/70">{sub}</p>
    </motion.div>
  );
}

// ============================================================
// LOG OUTCOME MODAL
// ============================================================

function LogOutcomeModal({
  request,
  onClose,
  onSave,
}: {
  request: ReviewRequest;
  onClose: () => void;
  onSave: (status: 'completed' | 'declined', rating: number | null) => void;
}) {
  const [rating, setRating] = useState(5);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-sm rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-text-primary">Log outcome for {request.customer_name}</h2>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>

        <p className="mb-2 text-sm text-text-secondary">What rating did they leave?</p>
        <div className="mb-5 flex items-center gap-1">
          {Array.from({ length: 5 }).map((_, i) => {
            const value = i + 1;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setRating(value)}
                aria-label={`${value} star${value > 1 ? 's' : ''}`}
                className="focus-ring rounded p-0.5"
              >
                <Star
                  size={26}
                  className={value <= rating ? 'fill-warning-500 text-warning-500' : 'text-bg-tertiary'}
                />
              </button>
            );
          })}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onSave('completed', rating)}
            className="focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
          >
            <Check size={16} /> Review left
          </button>
          <button
            type="button"
            onClick={() => onSave('declined', null)}
            className="focus-ring flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            <ThumbsDown size={16} /> Declined
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ============================================================
// MAIN REVIEWS PAGE
// ============================================================

export function ReviewsPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading } = useAuth();
  const { toast } = useToast();

  const [requests, setRequests] = useState<ReviewRequest[]>([]);
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeRequest, setActiveRequest] = useState<ReviewRequest | null>(null);

  const loadData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [requestsRes, businessProfileRes] = await Promise.all([
        supabase.from('review_requests').select('*').order('sent_at', { ascending: false }),
        supabase.from('business_profile').select('*').maybeSingle(),
      ]);
      if (requestsRes.data) setRequests(requestsRes.data as ReviewRequest[]);
      if (businessProfileRes.data) setBusinessProfile(businessProfileRes.data as BusinessProfile);
    } catch {
      // empty states
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  useKeyboardShortcut({
    key: 'Escape',
    handler: () => setActiveRequest(null),
  });

  const stats = useMemo(() => {
    const total = requests.length;
    const completed = requests.filter((r) => r.status === 'completed');
    const completionRate = total > 0 ? Math.round((completed.length / total) * 100) : 0;
    const rated = completed.filter((r) => r.rating !== null);
    const avgRating =
      rated.length > 0
        ? (rated.reduce((sum, r) => sum + (r.rating ?? 0), 0) / rated.length).toFixed(1)
        : '—';
    return { total, completedCount: completed.length, completionRate, avgRating };
  }, [requests]);

  const handleSaveOutcome = async (status: 'completed' | 'declined', rating: number | null) => {
    if (!activeRequest) return;
    try {
      const { error } = await supabase
        .from('review_requests')
        .update({ status, rating, completed_at: new Date().toISOString() })
        .eq('id', activeRequest.id);
      if (error) throw error;
      setRequests((prev) =>
        prev.map((r) =>
          r.id === activeRequest.id
            ? { ...r, status, rating, completed_at: new Date().toISOString() }
            : r
        )
      );
      toast('Review outcome saved.', 'success');
    } catch {
      toast('Could not save the outcome. Please try again.', 'error');
    } finally {
      setActiveRequest(null);
    }
  };

  return (
    <DashboardLayout activeLabel="Reviews">
      {/* Back button */}
      <button
        type="button"
        onClick={() => navigate('/dashboard')}
        className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={16} /> Back to dashboard
      </button>

      {/* Page header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Star size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Reviews</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Track every review request sent after a completed job.
            </p>
          </div>
        </div>
      </div>

      {/* Missing Google review link banner */}
      {!loading && !businessProfile?.google_review_url && (
        <div className="mb-6 flex flex-col items-start gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/5 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning-500/10 text-warning-500">
              <LinkIcon size={18} />
            </span>
            <div>
              <p className="text-sm font-semibold text-text-primary">Add your Google review link</p>
              <p className="mt-0.5 text-sm text-text-secondary">
                Review requests can't be sent until a link is set on your Business Profile.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate('/dashboard/business-profile')}
            className="focus-ring flex shrink-0 items-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
          >
            <Settings size={16} /> Set it up
          </button>
        </div>
      )}

      {/* Stats */}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <div className="h-10 w-10 animate-pulse rounded-xl bg-bg-tertiary" />
              <div className="mt-4 h-7 w-16 animate-pulse rounded bg-bg-tertiary" />
              <div className="mt-2 h-4 w-24 animate-pulse rounded bg-bg-tertiary" />
            </div>
          ))
        ) : (
          <>
            <StatCard icon={MessageSquareText} label="Requests Sent" value={String(stats.total)} sub="All time" delay={0} />
            <StatCard icon={Check} label="Reviews Left" value={String(stats.completedCount)} sub="Confirmed by you" delay={0.05} />
            <StatCard icon={ThumbsDown} label="Completion Rate" value={`${stats.completionRate}%`} sub="Sent → left a review" delay={0.1} />
            <StatCard icon={Star} label="Average Rating" value={String(stats.avgRating)} sub="Across logged reviews" delay={0.15} />
          </>
        )}
      </div>

      {/* Request list */}
      <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <h3 className="text-base font-semibold text-text-primary">Request History</h3>

        {loading ? (
          <div className="mt-4 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl bg-bg-tertiary" />
            ))}
          </div>
        ) : requests.length === 0 ? (
          <div className="mt-4 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-tertiary/50 px-6 py-12 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
              <Star size={22} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">No review requests yet</h3>
            <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
              Open a completed job in{' '}
              <button
                type="button"
                onClick={() => navigate('/dashboard/jobs')}
                className="focus-ring font-medium text-accent hover:underline"
              >
                My Jobs
              </button>{' '}
              and use "Request a Review" to text the customer a link.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {requests.map((r, i) => {
              const config = STATUS_CONFIG[r.status];
              return (
                <motion.div
                  key={r.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, delay: Math.min(i * 0.03, 0.3) }}
                  className="flex flex-col gap-3 rounded-xl border border-border bg-bg-primary p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-text-primary">{r.customer_name}</p>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${config.badge}`}>
                        {config.label}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
                      {r.customer_phone && (
                        <span className="flex items-center gap-1">
                          <Phone size={11} /> {r.customer_phone}
                        </span>
                      )}
                      <span>Sent {formatTimeAgo(r.sent_at)}</span>
                      {r.status === 'completed' && r.rating && <StarRow rating={r.rating} />}
                    </div>
                  </div>
                  {r.status === 'sent' && (
                    <button
                      type="button"
                      onClick={() => setActiveRequest(r)}
                      className="focus-ring shrink-0 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                    >
                      Log outcome
                    </button>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      <AnimatePresence>
        {activeRequest && (
          <LogOutcomeModal
            request={activeRequest}
            onClose={() => setActiveRequest(null)}
            onSave={handleSaveOutcome}
          />
        )}
      </AnimatePresence>
    </DashboardLayout>
  );
}
