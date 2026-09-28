/**
 * Customer-facing Trust Score — /verified/:token
 *
 * Token-gated (jobs.reschedule_token) and opt-in per business. Shows the
 * job's Trust Score, the five verification badges and the signal
 * breakdown. Reads only display-safe fields through get_public_job_trust().
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, Check, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import {
  BADGE_DEFS,
  fetchPublicTrust,
  isTrustedService,
  scoreBarClass,
  SIGNAL_LABELS,
  TIER_LABELS,
  type PublicJobTrust,
  type TrustTier,
} from '@/lib/jobTrustLayer';

const POLL_MS = 30000;

const RING_COLORS: Record<TrustTier, string> = {
  excellent: 'text-success-500',
  good: 'text-accent',
  fair: 'text-warning-500',
  at_risk: 'text-danger',
  pending: 'text-text-secondary',
};

function ScoreRing({ score, tier }: { score: number | null; tier: TrustTier }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const pct = score === null ? 0 : Math.min(100, Math.max(0, score));
  return (
    <div className="relative mx-auto h-36 w-36" role="img" aria-label={score === null ? 'Trust Score pending' : `Trust Score ${Math.round(score)} out of 100`}>
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle cx="60" cy="60" r={radius} fill="none" strokeWidth="9" className="stroke-bg-tertiary" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          className={`stroke-current transition-all duration-700 ${RING_COLORS[tier]}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold text-text-primary">{score === null ? '—' : Math.round(score)}</span>
        <span className="text-[11px] text-text-secondary">out of 100</span>
      </div>
    </div>
  );
}

export function VerifiedServicePage() {
  const { token } = useParams<{ token: string }>();
  const [trust, setTrust] = useState<PublicJobTrust | null | undefined>(undefined);

  useEffect(() => {
    if (!token) {
      setTrust(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const data = await fetchPublicTrust(token);
      if (!cancelled) setTrust(data);
    };
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [token]);

  const trusted = trust ? isTrustedService(trust) : false;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-lg">
          {trust === undefined && <p className="py-20 text-center text-sm text-text-secondary">Loading…</p>}

          {trust === null && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">Verification not available</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                This link isn't valid, or this business hasn't turned on service verification. Please contact the business directly.
              </p>
            </div>
          )}

          {trust && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
                <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                  {trust.business_name ?? 'Your service provider'}
                  {trust.service_type ? ` · ${trust.service_type}` : ''}
                </p>
                <h1 className="mt-1 text-lg font-semibold text-text-primary">Your service Trust Score</h1>
                <div className="my-5">
                  <ScoreRing score={trust.trust_score} tier={trust.tier} />
                </div>
                <p className="text-sm font-medium text-text-primary">{TIER_LABELS[trust.tier]}</p>
                {trust.tier === 'pending' && (
                  <p className="mx-auto mt-1 max-w-xs text-xs text-text-secondary">
                    Your score becomes final as verification checks complete during and after your visit.
                  </p>
                )}
                {trusted && (
                  <p className="mx-auto mt-4 inline-flex items-center gap-1.5 rounded-full bg-success-500/10 px-3 py-1.5 text-xs font-semibold text-success-500">
                    <ShieldCheck size={14} /> Vireek Trusted Service™
                  </p>
                )}
                {trust.technician_name && <p className="mt-4 text-xs text-text-secondary">Technician: {trust.technician_name}</p>}
              </div>

              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <h2 className="mb-3 text-sm font-semibold text-text-primary">What we've verified</h2>
                <ul className="space-y-2">
                  {BADGE_DEFS.map((b) => {
                    const ok = trust.badges[b.key] === true;
                    return (
                      <li key={b.key} className="flex items-center gap-3 text-sm">
                        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${ok ? 'bg-success-500/15 text-success-500' : 'bg-bg-tertiary text-text-secondary/50'}`}>
                          <Check size={14} />
                        </span>
                        <span className={ok ? 'font-medium text-text-primary' : 'text-text-secondary'}>{ok ? b.label : b.pending}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {trust.dimensions.length > 0 && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                  <h2 className="mb-3 text-sm font-semibold text-text-primary">How your score is made</h2>
                  <div className="space-y-3">
                    {trust.dimensions.map((d) => (
                      <div key={d.signal}>
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="text-text-primary">{SIGNAL_LABELS[d.signal]}</span>
                          <span className="flex items-center gap-1.5 font-medium text-text-primary">
                            {d.verified && <Check size={12} className="text-success-500" aria-label="Verified" />}
                            {Math.round(d.score)}
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                          <div className={`h-full rounded-full ${scoreBarClass(d.score)}`} style={{ width: `${Math.min(100, Math.max(0, d.score))}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="px-2 text-center text-xs leading-relaxed text-text-secondary">
                Scores are calculated by fixed rules from recorded evidence — arrival times, credentials, photo checks, invoices and logged staff records. Every entry is permanent and cannot be edited afterwards.
              </p>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
