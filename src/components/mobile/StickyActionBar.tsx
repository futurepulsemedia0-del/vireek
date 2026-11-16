// src/components/mobile/StickyActionBar.tsx — bottom-pinned primary actions for mobile forms and sheets.
// - Clears the home indicator (safe-area) and, when requested, the dashboard bottom nav (--vk-bottom-nav-h).
// - Rides above the on-screen keyboard via visualViewport (useKeyboardInset), so the CTA never hides behind it.
// - Desktop (>= lg by default): renders in normal flow, right-aligned, so the same markup works everywhere.
import type { ReactNode } from 'react';
import { useKeyboardInset } from '@/hooks/useKeyboardInset';

interface Props {
  children: ReactNode;
  /** Lift the bar above the dashboard bottom nav (only where MobileBottomNav is mounted). */
  aboveBottomNav?: boolean;
  className?: string;
  /** Accessible name for the action group. */
  label?: string;
}

export function StickyActionBar({ children, aboveBottomNav = false, className = '', label }: Props) {
  const keyboard = useKeyboardInset(true);
  const bottom = keyboard > 0 ? `${keyboard}px` : aboveBottomNav ? 'var(--vk-bottom-nav-h, 0px)' : '0px';
  const safe = keyboard > 0 ? '0px' : aboveBottomNav ? '0px' : 'env(safe-area-inset-bottom, 0px)';
  return (
    <div
      role="group"
      aria-label={label}
      style={{ bottom, paddingBottom: `calc(0.75rem + ${safe})` }}
      className={`fixed inset-x-0 z-sticky flex touch-manipulation gap-3 border-t border-border bg-bg-secondary/95 px-4 pt-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] backdrop-blur-xl transition-[bottom] duration-fast motion-reduce:transition-none lg:static lg:justify-end lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none [&>*]:min-h-12 [&>*]:flex-1 lg:[&>*]:flex-none print:hidden ${className}`}
    >
      {children}
    </div>
  );
}
