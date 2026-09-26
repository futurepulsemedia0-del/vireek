import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Fingerprint, Loader2, RefreshCw, TrendingUp, TrendingDown,
  Check, X as XIcon, Sparkles,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, IdentityDriftAlert } from '@/lib/supabase';

type IdentityDimension = 'growth_vs_stability' | 'risk_tolerance' | 'price_position' | 'automation_trust' | 'speed_vs_quality';

const DIMENSIONS: IdentityDimension[] = ['growth_vs_stability', 'risk_tolerance', 'price_position', 'automation_trust', 'speed_vs_quality'];

const DIMENSION_META: Record<IdentityDimension, { title: string; low: string; high: string }> = {
  growth_vs_stability: { title: 'Growth vs. Stability', low: 'Stability-focused', high: 'Growth-focused' },
  risk_tolerance: { title: 'Risk Tolerance', low: 'Risk-averse', high: 'Risk-seeking' },
  price_position: { title: 'Price Position', low: 'Value / discount', high: 'Premium' },
  automation_trust: { title: 'Trust in Automation', low: 'Hands-on', high: 'Delegates to automation' },
  speed_vs_quality: { title: 'Speed vs. Quality', low: 'Quality-first', high: 'Speed-first' },
};

interface DimensionProfile {
  recent_value: number | null;
  baseline_value: number | null;
  recent_samples: number;
  baseline_samples: number;
}

function ProfileBar({ dimension, data }: { dimension: IdentityDimension; data: DimensionProfile | undefined }) {
  const meta = DIMENSION_META[dimension];
  const hasData = data && (data.recent_value !== null || data.baseline_value !== null);
  const toPct = (v: number | null) => v === null ? 50 : ((v + 100) / 200) * 100;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <h3 className="mb-1 font-semibold text-text-primary">{meta.title}</h3>
      <div className="mb-2 flex justify-between text-xs text-text-secondary">
        <span>{meta.low}</span><span>{meta.high}</span>
      </div>
      <div className="relative mb-2 h-2.5 w-full rounded-full bg-bg-primary">
        {hasData && data!.baseline_value !== null && (
          <span className="absolute top-1/2 h-3.5 w-1 -translate-y-1/2 rounded-full bg-text-secondary/50" style={{ left: `${toPct(data!.baseline_value)}%` }} title="Baseline" />
        )}
        {hasData && data!.recent_value !== null && (
          <span className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 -translate-x-1/2 rounded-full bg-accent shadow" style={{ left: `${toPct(data!.recent_value)}%` }} title="Recent" />
        )}
      </div>
      {hasData ? (
        <p className="text-xs text-text-secondary">
          Recent ({data!.recent_samples} signals){data!.baseline_value !== null ? ` · baseline ${data!.baseline_samples} signals` : ''}
        </p>
      ) : (
        <p className="text-xs text-text-secondary">Not enough recent activity yet to score this dimension.</p>
      )}
    </div>
  );
}

function AlertCard({ alert, onUpdate, index }: { alert: IdentityDriftAlert; onUpdate: (id: string, status: 'acknowledged' | 'dismissed') => void; index: number }) {
  const positive = alert.recent_value > alert.baseline_value;
  return (
    <motion.div
      layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 20, transition: { duration: 0.2 } }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      className="flex flex-col gap-3 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {positive ? <TrendingUp size={16} className="text-emerald-500" /> : <TrendingDown size={16} className="text-danger" />}
          <h3 className="font-semibold text-text-primary">{alert.title}</h3>
        </div>
        <span className="shrink-0 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">
          {Math.round(alert.shift_magnitude)}-pt shift
        </span>
      </div>
      <p className="text-sm text-text-secondary">{alert.summary}</p>
      {alert.status === 'open' && (
        <div className="flex gap-2 pt-1">
          <button onClick={() => onUpdate(alert.id, 'acknowledged')} className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90">
            <Check size={16} /> Got it
          </button>
          <button onClick={() => onUpdate(alert.id, 'dismissed')} className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-text-secondary hover:bg-bg-primary">
            <XIcon size={16} /> Dismiss
          </button>
        </div>
      )}
      {alert.status !== 'open' && (
        <span className="w-fit rounded-full border border-border px-2.5 py-1 text-xs font-medium capitalize text-text-secondary">{alert.status}</span>
      )}
    </motion.div>
  );
}

export function IdentityLearnerPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [alerts, setAlerts] = useState<IdentityDriftAlert[]>([]);
  const [profile, setProfile] = useState<Record<string, DimensionProfile> | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const loadAlerts = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase.from('identity_drift_alerts').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(30);
    setAlerts((data ?? []) as IdentityDriftAlert[]);
    setLoading(false);
  }, [user]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  const handleScan = async () => {
    setScanning(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const { data, error } = await supabase.functions.invoke('identity-signal-scan', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (error) throw error;
      setProfile(data?.profile ?? null);
      const created = data?.drift_alerts_created?.length ?? 0;
      toast(created ? `${created} new shift${created !== 1 ? 's' : ''} detected.` : 'Scan complete — no meaningful shift yet.', created ? 'success' : 'info');
      await loadAlerts();
    } catch {
      toast('Could not scan for identity signals. Please try again.', 'error');
    } finally {
      setScanning(false);
    }
  };

  const handleUpdate = async (id: string, status: 'acknowledged' | 'dismissed') => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
    const { error } = await supabase.from('identity_drift_alerts').update({ status }).eq('id', id);
    if (error) { toast('Could not update this alert.', 'error'); loadAlerts(); }
  };

  const open = alerts.filter((a) => a.status === 'open');
  const resolved = alerts.filter((a) => a.status !== 'open');

  return (
    <DashboardLayout activeLabel="Continual Identity Learner">
      <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft size={16} /> Back to dashboard
      </button>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Fingerprint size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Continual Identity Learner</h1>
            <p className="text-sm text-text-secondary">Learned from what you actually decide — not what you said once. Flags when who you are has changed.</p>
          </div>
        </div>
        <button onClick={handleScan} disabled={scanning} className="focus-ring flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
          {scanning ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Scan for shifts
        </button>
      </div>

      {profile && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-text-primary">Current profile</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {DIMENSIONS.map((dim) => <ProfileBar key={dim} dimension={dim} data={profile[dim]} />)}
          </div>
        </section>
      )}

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-lg font-semibold text-text-primary">Detected shifts ({open.length})</h2>
            {open.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-text-secondary">
                <RefreshCw size={14} className="mb-1 inline" /> No open shifts. Run a scan to check your latest activity.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <AnimatePresence>
                  {open.map((a, i) => <AlertCard key={a.id} alert={a} onUpdate={handleUpdate} index={i} />)}
                </AnimatePresence>
              </div>
            )}
          </section>

          {resolved.length > 0 && (
            <section>
              <h2 className="mb-3 text-lg font-semibold text-text-primary">History</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {resolved.map((a, i) => <AlertCard key={a.id} alert={a} onUpdate={handleUpdate} index={i} />)}
              </div>
            </section>
          )}
        </div>
      )}
    </DashboardLayout>
  );
}
