import { BadgeCheck, Clock, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { CERT_META, type CertLevel } from '@/lib/noSurprise';
import { shortHash } from '@/lib/jobEvidenceChain';

const TONE_BOX = {
  success: 'border-success-500/30 bg-success-500/5',
  warning: 'border-warning-500/30 bg-warning-500/5',
  danger: 'border-danger/30 bg-danger/5',
  neutral: 'border-border bg-bg-primary',
} as const;

const TONE_TEXT = {
  success: 'text-success-500',
  warning: 'text-warning-500',
  danger: 'text-danger',
  neutral: 'text-text-secondary',
} as const;

const ICONS: Record<CertLevel, typeof ShieldCheck> = {
  certified: BadgeCheck,
  protected: ShieldCheck,
  awaiting_customer: Clock,
  unverified: ShieldQuestion,
  violated: ShieldAlert,
  not_applicable: ShieldQuestion,
};

interface NoSurpriseBadgeProps {
  level: CertLevel;
  /** Evidence-chain head hash: shown on certified badges so the seal can be verified. */
  headHash?: string | null;
  /** compact = single line chip; full = card with the one-line promise. */
  variant?: 'compact' | 'full';
  className?: string;
}

export function NoSurpriseBadge({ level, headHash, variant = 'full', className = '' }: NoSurpriseBadgeProps) {
  const meta = CERT_META[level];
  const Icon = ICONS[level];

  if (variant === 'compact') {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${TONE_BOX[meta.tone]} ${TONE_TEXT[meta.tone]} ${className}`}
      >
        <Icon size={13} aria-hidden="true" />
        {meta.label}
      </span>
    );
  }

  return (
    <div className={`flex items-start gap-3 rounded-2xl border p-4 ${TONE_BOX[meta.tone]} ${className}`} role="status">
      <Icon size={22} className={`mt-0.5 shrink-0 ${TONE_TEXT[meta.tone]}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className={`text-sm font-semibold ${TONE_TEXT[meta.tone]}`}>{meta.label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">{meta.description}</p>
        {level === 'certified' && headHash && (
          <p className="mt-1.5 font-mono text-[10px] text-text-secondary" title={headHash}>
            Evidence seal {shortHash(headHash, 12)}
          </p>
        )}
      </div>
    </div>
  );
}
