import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Lightbulb } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useProductTour } from '@/contexts/ProductTourContext';
import { TIPS, tipCopy, type TipId } from '@/lib/productTours';
import { useTourT } from './useTourT';

interface Props {
  id: TipId;
  children: ReactNode;
  placement?: 'bottom' | 'top';
  /** Extra classes for the wrapper (e.g. "flex w-full" around block elements). */
  className?: string;
  disabled?: boolean;
}

/**
 * Wrap any element to give first-time users a dismiss-once hint. Renders just
 * the children when the tip is hidden (wrong role, tour not met yet, dismissed).
 * Copy and per-role targeting live in TIPS (src/lib/productTours.ts).
 */
export function ContextualTip({ id, children, placement = 'bottom', className = '', disabled = false }: Props) {
  const tt = useTourT();
  const { role, tipsEnabled, isTipDismissed, dismissTip } = useProductTour();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();

  const def = TIPS[id];
  const visible =
    tipsEnabled && !disabled && !!def && !isTipDismissed(id) && (!def.roles || (!!role && def.roles.includes(role)));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!visible || !role) return <>{children}</>;

  const copy = tipCopy(id, role);
  const title = tt(`tour.tip.${id}.title`, copy.title);
  const body = tt(`tour.tip.${id}.body`, copy.body);

  return (
    <span ref={rootRef} className={`relative inline-flex ${className}`}>
      {children}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={tt('tour.ui.tipLabel', 'Tip: {{title}}', { title })}
        className="focus-ring absolute -end-1.5 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white before:absolute before:-inset-2 before:content-['']"
      >
        <span aria-hidden="true" className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 motion-safe:animate-ping" />
        <Lightbulb size={9} aria-hidden="true" className="relative" />
      </button>
      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label={title}
          className={`absolute start-0 z-[60] w-64 rounded-xl border border-border bg-bg-secondary p-4 text-start shadow-xl ${
            placement === 'top' ? 'bottom-full mb-3' : 'top-full mt-3'
          }`}
        >
          <p className="text-sm font-semibold text-text-primary">{title}</p>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">{body}</p>
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              onClick={() => {
                setOpen(false);
                dismissTip(id);
              }}
            >
              {tt('tour.ui.gotIt', 'Got it')}
            </Button>
          </div>
        </div>
      )}
    </span>
  );
}
