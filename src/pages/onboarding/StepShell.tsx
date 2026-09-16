import { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Loader as Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface StepShellProps {
  stepKey: string;
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  onSkip?: () => void;
  nextLabel?: ReactNode;
  nextDisabled?: boolean;
  saving?: boolean;
  hideNext?: boolean;
}

/**
 * Every step in the unified onboarding wizard renders inside this shell so
 * spacing, motion, and the back/skip/continue row stay pixel-identical
 * across all ten steps. Steps only ever provide their own form fields.
 */
export function StepShell({
  stepKey,
  icon: Icon,
  title,
  description,
  children,
  onBack,
  onNext,
  onSkip,
  nextLabel,
  nextDisabled,
  saving,
  hideNext,
}: StepShellProps) {
  return (
    <motion.div
      key={stepKey}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="text-center">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Icon size={24} />
        </span>
        <h1 className="mt-4 text-xl font-bold tracking-tight text-text-primary sm:text-2xl">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">{description}</p>
      </div>

      <div className="mt-6">{children}</div>

      <div className="mt-6 flex items-center justify-between gap-3">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="focus-ring flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
          >
            <ArrowLeft size={16} /> Back
          </button>
        ) : (
          <span />
        )}

        <div className="flex items-center gap-2">
          {onSkip && (
            <button
              type="button"
              onClick={onSkip}
              className="focus-ring rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              Skip
            </button>
          )}
          {!hideNext && onNext && (
            <button
              type="button"
              onClick={onNext}
              disabled={nextDisabled || saving}
              className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
            >
              {saving ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Saving…
                </>
              ) : (
                <>
                  {nextLabel ?? 'Continue'} <ArrowRight size={16} />
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
