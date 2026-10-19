import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { HelpCircle, Lightbulb, Play, RotateCcw, Rocket } from 'lucide-react';
import { useProductTour } from '@/contexts/ProductTourContext';
import { useTourT } from './useTourT';

interface Props {
  /** Which edge of the button the menu aligns to (use "end" near the right edge of the screen). */
  align?: 'start' | 'end';
  className?: string;
}

const ITEM =
  'focus-ring flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm text-text-primary hover:bg-bg-tertiary disabled:pointer-events-none disabled:opacity-50';

export function ReplayTourMenu({ align = 'start', className = '' }: Props) {
  const tt = useTourT();
  const {
    role, tour, status, stepIndex, stepCount, completedAt, isActive,
    startTour, replayTour, dismissedTipCount, resetTips,
  } = useProductTour();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!tour) return null;

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
    else if (e.key === 'Home') items[0]?.focus();
    else if (e.key === 'End') items[items.length - 1]?.focus();
    else if (e.key === 'Tab') setOpen(false);
    else return;
    if (e.key !== 'Tab') e.preventDefault();
  };

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  const statusText =
    status === 'completed'
      ? tt('tour.ui.statusCompleted', 'Completed {{date}}', {
          date: completedAt ? new Date(completedAt).toLocaleDateString() : '',
        })
      : status === 'in_progress'
        ? tt('tour.ui.statusInProgress', 'In progress — step {{current}} of {{total}}', {
            current: Math.min(stepIndex + 1, stepCount),
            total: stepCount,
          })
        : status === 'skipped'
          ? tt('tour.ui.statusSkipped', 'Skipped')
          : tt('tour.ui.statusNotStarted', 'Not started');

  const primaryLabel =
    status === 'in_progress'
      ? tt('tour.ui.resumeTour', 'Resume tour')
      : status === 'not_started'
        ? tt('tour.ui.takeTour', 'Take the tour')
        : tt('tour.ui.replayTour', 'Replay tour');

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        data-tour="tour-menu"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={tt('tour.ui.helpMenu', 'Help and product tour')}
        className="focus-ring relative flex h-10 w-10 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
      >
        <HelpCircle size={18} aria-hidden="true" />
        {status === 'in_progress' && (
          <span aria-hidden="true" className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent" />
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={tt('tour.ui.helpMenu', 'Help and product tour')}
          onKeyDown={onMenuKeyDown}
          className={`absolute top-full z-[60] mt-2 w-72 rounded-2xl border border-border bg-bg-secondary p-2 shadow-xl ${
            align === 'end' ? 'end-0' : 'start-0'
          }`}
        >
          <div className="px-3 pb-2 pt-1">
            <p className="text-sm font-semibold text-text-primary">{tt(`tour.${tour.id}.name`, tour.title)}</p>
            <p className="mt-0.5 text-xs text-text-secondary">{statusText}</p>
          </div>
          <button type="button" role="menuitem" disabled={isActive} onClick={run(startTour)} className={ITEM}>
            <Play size={15} aria-hidden="true" /> {primaryLabel}
          </button>
          {status === 'in_progress' && (
            <button type="button" role="menuitem" disabled={isActive} onClick={run(replayTour)} className={ITEM}>
              <RotateCcw size={15} aria-hidden="true" /> {tt('tour.ui.restartTour', 'Restart from the beginning')}
            </button>
          )}
          <button type="button" role="menuitem" disabled={dismissedTipCount === 0} onClick={run(resetTips)} className={ITEM}>
            <Lightbulb size={15} aria-hidden="true" /> {tt('tour.ui.showTips', 'Show tips again')}
          </button>
          {role !== 'technician' && (
            <Link
              role="menuitem"
              to="/dashboard/getting-started"
              onClick={() => setOpen(false)}
              className={ITEM}
            >
              <Rocket size={15} aria-hidden="true" /> {tt('tour.ui.checklist', 'Open setup checklist')}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
