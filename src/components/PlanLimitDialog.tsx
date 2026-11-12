import { useEffect, useId, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { PLAN_LABELS, planLimitMessage, type PlanLimitError } from '@/lib/planLimits';

/** Where the upgrade button goes: the existing billing route (same as UpgradeBanner). */
const UPGRADE_ROUTE = '/dashboard/billing';

interface Props {
  error: PlanLimitError;
  onClose: () => void;
}

/** Small accessible upgrade prompt shown when a plan limit refuses an addition. Escape / backdrop closes it. */
export function PlanLimitDialog({ error, onClose }: Props) {
  const navigate = useNavigate();
  const titleId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    primaryRef.current?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="relative w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark">
        <div className="mb-3 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"><Lock size={18} aria-hidden="true" /></span>
          <h2 id={titleId} className="text-lg font-bold text-text-primary">Plan limit reached</h2>
        </div>
        <p className="text-sm text-text-secondary">{planLimitMessage(error)}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="focus-ring rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary">Not now</button>
          <button
            ref={primaryRef}
            type="button"
            onClick={() => { onClose(); navigate(UPGRADE_ROUTE); }}
            className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            {error.upgradeTo ? `Upgrade to ${PLAN_LABELS[error.upgradeTo]}` : 'View plans'}
          </button>
        </div>
      </div>
    </div>
  );
}
