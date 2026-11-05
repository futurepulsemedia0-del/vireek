import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const en = (await import('@/locales/incrementality/en.json')).default as Record<string, string>;
  return {
    useTranslation: () => ({
      t: (k: string, o?: Record<string, unknown>) =>
        (en[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_m, n: string) => String(o?.[n] ?? '')),
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('@/i18n', () => ({ default: { hasResourceBundle: () => true, addResourceBundle: () => undefined } }));
vi.mock('@/components/ui/Card', () => ({ Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { IncrementalValuePanel } from './IncrementalValuePanel';
import type { IncrementalRow } from '../../supabase/functions/_shared/value-scoreboard/engine';

const row = (p: Partial<IncrementalRow> = {}): IncrementalRow => ({
  id: 'r1', evidenceRef: 'experiment:x:itt', currency: 'USD', pointCents: 120000, ciLowCents: 30000, ciHighCents: 210000,
  spansZero: false, methodNote: 'Randomized holdout, intention-to-treat.', occurredAt: '2026-10-10T15:00:00Z', ...p,
});

afterEach(cleanup);

describe('IncrementalValuePanel', () => {
  it('shows an honest empty state and never invents a number', () => {
    render(<IncrementalValuePanel rows={[]} />);
    expect(screen.getByText(/No experiment results yet/)).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it('always renders the interval with the point estimate', () => {
    render(<IncrementalValuePanel rows={[row()]} />);
    expect(screen.getByText(/\$300 to \$2,100/)).toBeTruthy();
    expect(screen.getByText('$1,200')).toBeTruthy();
    expect(screen.getByText(/not proof/)).toBeTruthy();
  });

  it('says so when the interval includes zero', () => {
    render(<IncrementalValuePanel rows={[row({ pointCents: 5000, ciLowCents: -40000, ciHighCents: 50000, spansZero: true })]} />);
    expect(screen.getByText(/consistent with no extra revenue/)).toBeTruthy();
  });

  it('labels the section and states it is not used for billing', () => {
    render(<IncrementalValuePanel rows={[row()]} />);
    expect(screen.getByRole('heading', { name: /Incremental value/ })).toBeTruthy();
    expect(screen.getByText(/not used to calculate any charge/)).toBeTruthy();
  });
});
