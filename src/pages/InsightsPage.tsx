import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Phone,
  LogOut,
  ArrowLeft,
  RefreshCw,
  X,
  Info,
  Lightbulb,
  TriangleAlert as AlertTriangle,
  Sparkles,
  Brain,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import { supabase, AiInsight } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';

// ============================================================
// INSIGHT CONFIG
// ============================================================

type InsightType = AiInsight['insight_type'];

const INSIGHT_CONFIG: Record<
  InsightType,
  { icon: typeof Info; color: string; bgColor: string; borderColor: string; label: string }
> = {
  pattern: {
    icon: Info,
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-l-blue-500',
    label: 'Pattern',
  },
  suggestion: {
    icon: Lightbulb,
    color: 'text-orange-500',
    bgColor: 'bg-orange-500/10',
    borderColor: 'border-l-orange-500',
    label: 'Suggestion',
  },
  alert: {
    icon: AlertTriangle,
    color: 'text-danger',
    bgColor: 'bg-danger/10',
    borderColor: 'border-l-danger',
    label: 'Alert',
  },
};

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(diff / 60000);
  return mins > 0 ? `${mins}m ago` : 'just now';
}

// ============================================================
// INSIGHT CARD
// ============================================================

function InsightCard({
  insight,
  onDismiss,
  index,
}: {
  insight: AiInsight;
  onDismiss: (id: string) => void;
  index: number;
}) {
  const config = INSIGHT_CONFIG[insight.insight_type];
  const Icon = config.icon;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 20, transition: { duration: 0.2 } }}
      transition={{ duration: 0.3, delay: index * 0.05, ease: [0.16, 1, 0.3, 1] }}
      className={`flex items-start gap-4 rounded-2xl border border-border border-l-4 ${config.borderColor} bg-bg-secondary p-5 shadow-card dark:shadow-card-dark`}
    >
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${config.bgColor} ${config.color}`}>
        <Icon size={20} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-text-primary">{insight.title}</h3>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${config.bgColor} ${config.color}`}>
            {config.label}
          </span>
        </div>
        <p className="mt-1 text-sm leading-relaxed text-text-secondary">{insight.description}</p>
        <p className="mt-2 text-xs text-text-secondary/60">{formatTimeAgo(insight.created_at)}</p>
      </div>
      <button
        type="button"
        onClick={() => onDismiss(insight.id)}
        className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
        aria-label="Dismiss insight"
      >
        <X size={16} />
      </button>
    </motion.div>
  );
}

// ============================================================
// MAIN INSIGHTS PAGE
// ============================================================

export function InsightsPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, signOut } = useAuth();
  const { toast } = useToast();

  const [insights, setInsights] = useState<AiInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadInsights = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('ai_insights')
        .select('*')
        .eq('is_dismissed', false)
        .order('created_at', { ascending: false })
        .limit(10);

      if (error) throw error;
      if (data) setInsights(data as AiInsight[]);
    } catch {
      // empty state
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadInsights();
  }, [loadInsights]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  useKeyboardShortcut({
    key: 'Escape',
    handler: () => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    },
  });

  const handleSignOut = async () => {
    await signOut();
    toast('Signed out successfully.', 'info');
    navigate('/login', { replace: true });
  };

  const handleDismiss = async (id: string) => {
    setInsights((prev) => prev.filter((i) => i.id !== id));
    try {
      const { error } = await supabase.from('ai_insights').update({ is_dismissed: true }).eq('id', id);
      if (error) throw error;
    } catch {
      toast('Could not dismiss insight.', 'error');
      loadInsights();
    }
  };

  const handleRefresh = async () => {
    if (!user) return;
    setRefreshing(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const response = await fetch(`${supabaseUrl}/functions/v1/generate-insights`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ user_id: user.id }),
      });

      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }

      const result = await response.json();
      if (result.error) throw new Error(result.error);

      const generated = result.generated ?? 0;
      if (generated > 0) {
        toast(`Generated ${generated} new insight${generated !== 1 ? 's' : ''}.`, 'success');
      } else {
        toast('No new insights — your data looks healthy.', 'info');
      }
      await loadInsights();
    } catch {
      toast('Could not generate insights. Please try again.', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const hasInsights = insights.length > 0;

  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-bg-primary/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
              <Phone size={16} strokeWidth={2.5} />
            </span>
            <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
            <span className="ml-2 rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-secondary">
              Insights
            </span>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <button
              type="button"
              onClick={handleSignOut}
              className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:border-danger/40 hover:text-danger"
              aria-label="Sign out"
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
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
              <Brain size={24} />
            </span>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
                Smart Insights
              </h1>
              <p className="mt-1 text-sm text-text-secondary">
                Patterns and suggestions from your call, lead, and job data.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Analyzing…' : 'Refresh Insights'}
          </button>
        </div>

        {/* Content */}
        {loading ? (
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
              >
                <div className="flex items-start gap-4">
                  <div className="h-11 w-11 animate-pulse rounded-xl bg-bg-tertiary" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-48 animate-pulse rounded bg-bg-tertiary" />
                    <div className="h-3 w-full animate-pulse rounded bg-bg-tertiary" />
                    <div className="h-3 w-2/3 animate-pulse rounded bg-bg-tertiary" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : hasInsights ? (
          <AnimatePresence mode="popLayout">
            <div className="space-y-4">
              {insights.map((insight, i) => (
                <InsightCard
                  key={insight.id}
                  insight={insight}
                  onDismiss={handleDismiss}
                  index={i}
                />
              ))}
            </div>
          </AnimatePresence>
        ) : (
          /* Empty state */
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
              <Sparkles size={26} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">No insights yet</h3>
            <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
              Click "Refresh Insights" to analyze your recent calls, leads, and jobs for patterns
              and suggestions worth acting on.
            </p>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="focus-ring mt-4 flex items-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
            >
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
              {refreshing ? 'Analyzing…' : 'Generate Insights'}
            </button>
          </motion.div>
        )}

        {/* Footer note */}
        {!loading && hasInsights && (
          <p className="mt-6 text-center text-xs text-text-secondary/50">
            Insights are generated from your last 30 days of data. Dismissed insights won't reappear.
          </p>
        )}
      </main>
    </div>
  );
}
