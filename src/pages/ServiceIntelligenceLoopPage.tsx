// src/pages/ServiceIntelligenceLoopPage.tsx
//
// VIREEK Service Intelligence Loop console: the seven stages, how much the
// account (and the network) has learned, whether diagnoses are measurably getting
// better, the latest outcomes moving through verification, and the sharing switch.

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, CheckCircle2, Network, RefreshCcw, ShieldCheck, Sparkles } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  LOOP_STAGES,
  VERIFICATION_STATUS_META,
  causeLabel,
  formatMilestone,
  LOOP_MILESTONES,
  milestoneProgress,
  pct,
  priorLift,
  verifiedShare,
  type LoopMetrics,
} from '@/lib/serviceIntelligenceLoop';
import {
  emptyLoopMetrics,
  fetchLoopMetrics,
  fetchRecentLoopOutcomes,
  setLoopSharing,
  verifyMyDueOutcomes,
  type LoopOutcomeRow,
} from '@/lib/serviceIntelligenceLoopApi';

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-5';
const fmtPct = (v: number | null) => (v === null ? '—' : `${v}%`);
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function MilestoneLadder({ count, label }: { count: number; label: string }) {
  const m = milestoneProgress(count);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-sm font-semibold text-text-primary">{label}</p>
        <p className="text-xs tabular-nums text-text-secondary">
          {count.toLocaleString()} {m.next ? `/ ${formatMilestone(m.next)}` : '· top of the ladder'}
        </p>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-bg-primary" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.pct} aria-label={label}>
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${m.pct}%` }} />
      </div>
      <ol className="mt-2 flex justify-between text-[11px] text-text-secondary">
        {LOOP_MILESTONES.map((n) => (
          <li key={n} className={count >= n ? 'font-semibold text-accent' : ''}>
            {count >= n && <CheckCircle2 size={10} className="mr-0.5 inline" aria-hidden="true" />}
            {formatMilestone(n)}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ServiceIntelligenceLoopPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [metrics, setMetrics] = useState<LoopMetrics>(emptyLoopMetrics());
  const [outcomes, setOutcomes] = useState<LoopOutcomeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'verify' | 'share' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [m, o] = await Promise.allSettled([fetchLoopMetrics(), fetchRecentLoopOutcomes(15)]);
    if (m.status === 'fulfilled') setMetrics(m.value);
    else toast('Could not load loop metrics. Is the Service Intelligence Loop migration applied?', 'error');
    if (o.status === 'fulfilled') setOutcomes(o.value);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const verifyNow = async () => {
    setBusy('verify');
    try {
      const n = await verifyMyDueOutcomes();
      toast(n > 0 ? `${n} outcome${n === 1 ? '' : 's'} verified.` : 'Nothing is due for verification yet.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not verify outcomes.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggleSharing = async () => {
    if (!user) return;
    setBusy('share');
    try {
      await setLoopSharing(user.id, !metrics.sharing);
      toast(!metrics.sharing ? 'Sharing anonymous statistics with the network.' : 'Sharing turned off. Network priors are paused for your account.', 'success');
      await load();
    } catch {
      toast('Only the account owner can change this setting.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const { own, predictions: pr, network } = metrics;
  const top1 = pct(pr.top1, pr.scored);
  const top3 = pct(pr.top3, pr.scored);
  const lift = priorLift(pr);
  const ftf = pct(own.first_visit_fixed, own.outcomes);
  const callbackRate = pct(own.callbacks, own.outcomes);

  return (
    <DashboardLayout activeLabel="Service Intelligence Loop">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Network size={24} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold text-text-primary">Service Intelligence Loop</h1>
          <p className="text-sm text-text-secondary">
            Every verified repair makes the next diagnosis better — for you first, then for the whole network.
          </p>
        </div>
        <button
          type="button"
          onClick={verifyNow}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-primary hover:bg-bg-secondary disabled:opacity-50"
        >
          <RefreshCcw size={14} className={busy === 'verify' ? 'animate-spin' : ''} aria-hidden="true" />
          Verify due outcomes
        </button>
      </div>

      {/* The seven stages */}
      <motion.ol
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className={`${CARD} mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-7`}
        aria-label="The seven stages of the service intelligence loop"
      >
        {LOOP_STAGES.map((s, i) => (
          <li key={s.id} className="relative rounded-xl border border-border bg-bg-primary p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-accent">{i + 1}</p>
            <p className="mt-1 text-sm font-semibold text-text-primary">{s.label}</p>
            <p className="mt-1 text-xs text-text-secondary">{s.detail}</p>
            {i < LOOP_STAGES.length - 1 && (
              <ArrowRight size={14} className="absolute -right-2 top-1/2 hidden -translate-y-1/2 text-text-secondary lg:block" aria-hidden="true" />
            )}
          </li>
        ))}
      </motion.ol>

      {/* Is it actually getting better? */}
      <section className={`${CARD} mb-6`} aria-labelledby="loop-proof">
        <h2 id="loop-proof" className="mb-3 text-sm font-semibold text-text-primary">Is the loop making diagnoses better?</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Top-pick accuracy" value={fmtPct(top1)} hint={pr.scored ? `${pr.top1} of ${pr.scored} scored diagnoses` : 'Scored after a diagnosed job is closed'} />
          <Stat label="Right cause in top 3" value={fmtPct(top3)} hint={pr.scored ? `${pr.top3} of ${pr.scored}` : undefined} />
          <Stat
            label="Lift from history"
            value={lift === null ? '—' : `${lift > 0 ? '+' : ''}${lift} pts`}
            hint={lift === null ? 'Needs 10+ scored cases with and without history' : 'Top-pick accuracy with history vs. model alone'}
          />
          <Stat label="Fixed on first visit" value={fmtPct(ftf)} hint={callbackRate === null ? undefined : `${callbackRate}% callbacks`} />
        </div>
        <p className="mt-3 text-xs text-text-secondary">
          Accuracy compares the copilot's top causes with the root cause the technician recorded on the closed job. Numbers
          appear only when there is real data to score — never a placeholder.
        </p>
      </section>

      {/* Scale ladder */}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <section className={CARD} aria-label="Your learning">
          <MilestoneLadder count={own.with_cause} label="Your jobs with a recorded root cause" />
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Stat label="Verified" value={String(own.verified)} hint={verifiedShare(own) === null ? undefined : `${verifiedShare(own)}% of outcomes`} />
            <Stat label="Verifying" value={String(own.pending)} hint="30-day window" />
            <Stat label="Callbacks" value={String(own.refuted)} hint="Fix did not hold" />
          </div>
        </section>
        <section className={CARD} aria-label="Network learning">
          <MilestoneLadder count={network.cases} label="Network jobs learned from (anonymous)" />
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Stat label="Job types covered" value={String(network.job_types)} hint="with enough data" />
            <Stat label="Verified" value={network.verified.toLocaleString()} />
            <Stat label="Largest cohort" value={String(network.max_contributors)} hint="businesses" />
          </div>
        </section>
      </div>

      {/* Recent outcomes through verification */}
      <section className={`${CARD} mb-6`} aria-labelledby="loop-outcomes">
        <h2 id="loop-outcomes" className="mb-3 text-sm font-semibold text-text-primary">Latest outcomes</h2>
        {loading ? (
          <p className="text-sm text-text-secondary">Loading…</p>
        ) : outcomes.length === 0 ? (
          <p className="text-sm text-text-secondary">
            No outcomes yet. Close a job and record its outcome in Trade Playbooks — that is what teaches the loop.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-text-secondary">
                  <th scope="col" className="py-2 pr-3 font-medium">Recorded</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Confirmed cause</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Parts</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                  <th scope="col" className="py-2 font-medium">Verifies</th>
                </tr>
              </thead>
              <tbody>
                {outcomes.map((o) => {
                  const meta = VERIFICATION_STATUS_META[o.verification_status] ?? VERIFICATION_STATUS_META.pending;
                  return (
                    <tr key={o.id} className="border-t border-border">
                      <td className="py-2 pr-3 tabular-nums">{fmtDate(o.recorded_at)}</td>
                      <td className="py-2 pr-3 text-text-primary">
                        {o.root_cause_key ? causeLabel(o.playbook_slug, o.job_type_key, o.root_cause_key) : <span className="text-text-secondary">Not recorded</span>}
                      </td>
                      <td className="py-2 pr-3 text-text-secondary">{o.parts_used.length ? o.parts_used.slice(0, 3).join(', ') : '—'}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full px-2 py-0.5 font-medium ${meta.className}`}>{meta.label}</span>
                      </td>
                      <td className="py-2 tabular-nums text-text-secondary">{o.verification_status === 'pending' ? fmtDate(o.verify_after) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Privacy + sharing */}
      <section className={CARD} aria-labelledby="loop-privacy">
        <div className="flex flex-wrap items-start gap-4">
          <ShieldCheck size={20} className="mt-0.5 text-success-500" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id="loop-privacy" className="text-sm font-semibold text-text-primary">Network learning &amp; privacy</h2>
            <p className="mt-1 text-xs text-text-secondary">
              Only counts of confirmed causes per job type leave your account — never customers, addresses, notes or photos.
              A statistic is published only when at least 5 different businesses contribute to it. This is k-anonymity, not a
              formal differential-privacy guarantee. Businesses that opt out do not receive network priors.
            </p>
          </div>
          <button
            type="button"
            onClick={toggleSharing}
            disabled={busy !== null}
            role="switch"
            aria-checked={metrics.sharing}
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50 ${
              metrics.sharing ? 'bg-accent text-white' : 'border border-border text-text-primary'
            }`}
          >
            <Sparkles size={14} aria-hidden="true" />
            {metrics.sharing ? 'Sharing on' : 'Sharing off'}
          </button>
        </div>
      </section>
    </DashboardLayout>
  );
}
