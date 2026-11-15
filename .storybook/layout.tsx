// Tiny layout helpers for stories. Inline styles on purpose: no Tailwind classes, so the catalogue adds
// nothing to the app's generated CSS, and no colours, so the dark-mode toggle only exercises the components.
import type { ReactNode } from 'react';

export function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>{children}</div>;
}

export function Stack({ children, maxWidth = 420 }: { children: ReactNode; maxWidth?: number }) {
  return <div style={{ display: 'grid', gap: 20, maxWidth, width: '100%' }}>{children}</div>;
}

export function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
      <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
      {children}
    </div>
  );
}
