/**
 * Technician Trust Passport — /dashboard/trust-passport
 *
 * A per-technician scorecard where every number is derived live from
 * real job outcomes (see src/lib/trustPassport.ts). Nothing here is
 * self-reported or editable by a technician or admin.
 */

import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Lock,
  Fingerprint,
  BadgeCheck,
  ShieldCheck,
  Star,
  DollarSign,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import {
  fetchTrustPassports,
  formatRate,
  rateColor,
  type TechnicianTrustPassport,
} from '@/lib/trustPassport';

function StatBlock({ label, value, valueClass = 'text-text-primary' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-text-secondary/70">{label}</p>
      <p className={`mt-0.5 text-lg font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}

function PassportCard({ p }: { p: TechnicianTrustPassport }) {
  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-text-primary">{p.technician_name}</h3>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {p.certifications.length === 0 && (
              <span className="text-xs text-text-secondary">No active certifications on file</span>
            )}
            {p.certifications.map((c) => (
              <span
                key={c}
                className="inline-flex items-center gap-1 rounded-full bg-success-500/10 px-2.5 py-1 text-xs font-medium text-success-500"
              >
                <BadgeCheck size={12} /> {c}
              </span>
            ))}
          </div>
        </div>
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Fingerprint size={18} />
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-border/60 pt-5 sm:grid-cols-3">
        <StatBlock label="First-time fix" value={formatRate(p.first_time_fix_rate)} valueClass={rateColor(p.first_time_fix_rate, 90)} />
        <StatBlock label="Callback rate" value={formatRate(p.callback_rate)} valueClass={p.callback_rate === null ? 'text-text-secondary' : p.callback_rate <= 5 ? 'text-success-500' : p.callback_rate <= 15 ? 'text-warning-500' : 'text-danger'} />
        <StatBlock
          label="Customer rating"
          value={p.customer_rating_avg === null ? '—' : `${p.customer_rating_avg.toFixed(1)}/5`}
          valueClass={rateColor(p.customer_rating_avg === null ? null : p.customer_rating_avg * 20, 90)}
        />
        <StatBlock label="Safety compliance" value={formatRate(p.safety_compliance_rate)} valueClass={rateColor(p.safety_compliance_rate, 95)} />
        <StatBlock
          label="Avg job margin"
          value={p.avg_margin_pct === null ? '—' : `${p.avg_margin_pct}%`}
        />
        <StatBlock label="Verified skills" value={String(p.verified_skill_count)} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 pt-3 text-xs text-text-secondary">
        <span className="inline-flex items-center gap-1">
          <ShieldCheck size={12} /> {p.jobs_completed} jobs completed
        </span>
        <span className="inline-flex items-center gap-1">
          <Star size={12} /> {p.customer_rating_count} customer reviews
        </span>
        <span
          className={`inline-flex items-center gap-1 ${
            p.unresolved_complaint_count > 0 ? 'text-danger' : 'text-success-500'
          }`}
        >
          <AlertTriangle size={12} /> {p.unresolved_complaint_count} unresolved complaint
          {p.unresolved_complaint_count === 1 ? '' : 's'}
        </span>
      </div>
    </Card>
  );
}

export function TechnicianTrustPassportPage() {
  const { isOwner, permissions } = useAuth();
  const navigate = useNavigate();
  const canAccess = isOwner || permissions.can_view_billing;

  const [passports, setPassports] = useState<TechnicianTrustPassport[]>([]);
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState(90);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchTrustPassports(windowDays);
      setPassports(rows);
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => {
    if (canAccess) void load();
  }, [canAccess, load]);

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Trust Passport">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Trust Passport access is restricted. Ask your account owner to grant you the "View Billing" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Trust Passport">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Fingerprint size={16} />
              </span>
              <h1 className="text-2xl font-bold text-text-primary">Technician Trust Passport</h1>
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              Every number here is computed live from real job outcomes — certifications, first-time-fix,
              callbacks, safety evidence, margin and reviews. Nothing is self-reported.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
          >
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 12 months</option>
          </select>
          <button
            type="button"
            onClick={() => void load()}
            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <SkeletonCardList count={4} />
      ) : passports.length === 0 ? (
        <EmptyState
          icon={Fingerprint}
          title="No technicians yet"
          description="Add a team member with the Technician role to start building trust passports from real job outcomes."
        />
      ) : (
        <FadeIn className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {passports.map((p) => (
            <PassportCard key={p.technician_id} p={p} />
          ))}
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
