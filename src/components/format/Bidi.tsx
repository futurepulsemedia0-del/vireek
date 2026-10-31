import type { ReactNode } from 'react';

interface BidiProps {
  children: ReactNode;
  /** `ltr` for phones, emails, IDs, times, URLs (default). `auto` for user-written names/notes. */
  dir?: 'ltr' | 'auto';
  className?: string;
}

/** Bidi isolation: keeps an LTR token intact inside RTL text (and vice versa). */
export function Bidi({ children, dir = 'ltr', className }: BidiProps) {
  return (
    <bdi dir={dir} className={className}>
      {children}
    </bdi>
  );
}
