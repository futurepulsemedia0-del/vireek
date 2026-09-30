/**
 * Shared presentational pieces for Technician Passport 2.0.
 * Used by the dashboard page and the public verification page.
 */

import { BadgeCheck, ShieldCheck } from 'lucide-react';
import {
  confidenceLevel,
  formatCoverage,
  formatDate,
  INSURANCE_LABELS,
  skillLabel,
  TIER_META,
  type PassportCertification,
  type PassportInsurance,
  type PassportTier,
  type SkillConfidence,
} from '@/lib/technicianIdentity';

export function IndexRing({ score, tier, size = 132 }: { score: number | null; tier: PassportTier; size?: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const pct = score === null ? 0 : Math.min(100, Math.max(0, score));
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={score === null ? 'Passport Index not yet available' : `Passport Index ${Math.round(score)} out of 100`}
    >
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
          className={`stroke-current transition-all duration-700 ${TIER_META[tier].ringClass}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold text-text-primary">{score === null ? '—' : Math.round(score)}</span>
        <span className="text-[11px] text-text-secondary">Passport Index</span>
      </div>
    </div>
  );
}

export function TierBadge({ tier }: { tier: PassportTier }) {
  const meta = TIER_META[tier];
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${meta.badgeClass}`}>{meta.label}</span>;
}

export function MetricTile({
  label,
  value,
  hint,
  valueClass = 'text-text-primary',
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-bg-primary/40 p-3.5">
      <p className="text-[11px] uppercase tracking-wide text-text-secondary/70">{label}</p>
      <p className={`mt-1 text-xl font-bold ${valueClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

export function ConfidenceList({ items, emptyText }: { items: SkillConfidence[]; emptyText: string }) {
  if (items.length === 0) return <p className="text-sm text-text-secondary">{emptyText}</p>;
  return (
    <ul className="space-y-3.5">
      {items.map((s) => {
        const lvl = confidenceLevel(s.confidence, s.job_count);
        const label = skillLabel(s.skill_key);
        return (
          <li key={s.skill_key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-text-primary">{label}</span>
              <span className="text-sm font-bold text-text-primary">{s.confidence}%</span>
            </div>
            <div
              className="mt-1.5 h-2 overflow-hidden rounded-full bg-bg-tertiary"
              role="progressbar"
              aria-valuenow={s.confidence}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${label} skill confidence`}
            >
              <div className={`h-full rounded-full transition-all duration-700 ${lvl.barClass}`} style={{ width: `${s.confidence}%` }} />
            </div>
            <p className="mt-1 text-[11px] text-text-secondary">
              {lvl.label} · {s.job_count} completed {s.job_count === 1 ? 'job' : 'jobs'}
              {s.fix_rate !== null ? ` · ${s.fix_rate}% first-time fix` : ''}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function CertificationList({ items }: { items: PassportCertification[] }) {
  if (items.length === 0) return <p className="text-sm text-text-secondary">No active certifications on file.</p>;
  return (
    <ul className="space-y-2.5">
      {items.map((c, i) => (
        <li key={`${c.type}-${i}`} className="flex items-start gap-2.5">
          <BadgeCheck size={16} className={`mt-0.5 shrink-0 ${c.valid === false ? 'text-danger' : 'text-success-500'}`} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">{c.name || skillLabel(c.type)}</p>
            <p className="text-[11px] text-text-secondary">
              {c.issuer ? `${c.issuer} · ` : ''}
              {c.expires_at ? `${c.valid === false ? 'Expired' : 'Valid until'} ${formatDate(c.expires_at)}` : 'No expiry'}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function InsuranceList({ items }: { items: PassportInsurance[] }) {
  if (items.length === 0) return <p className="text-sm text-text-secondary">No verified insurance on file.</p>;
  return (
    <ul className="space-y-2.5">
      {items.map((p, i) => (
        <li key={p.id ?? `${p.type}-${i}`} className="flex items-start gap-2.5">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-success-500" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">
              {INSURANCE_LABELS[p.type] ?? skillLabel(p.type)} · {p.carrier}
            </p>
            <p className="text-[11px] text-text-secondary">
              {formatCoverage(p.coverage_amount_cents)} · valid until {formatDate(p.expires_at)}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
