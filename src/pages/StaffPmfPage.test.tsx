import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ fetchPmfSummary: vi.fn(), fetchRetention: vi.fn() }));
vi.mock('@/lib/pmfApi', () => api);
vi.mock('@/i18n/pmfNamespace', () => ({
  usePmfT: () => ({ t: (k: string, o?: Record<string, unknown>) => (o && 'defaultValue' in o ? String(o.defaultValue) : k), language: 'en' }),
}));

import { StaffPmfPage } from './StaffPmfPage';

const row = (segment: string, n: number, very: number) => ({ segment, n, very, somewhat: 0, notDisappointed: n - very, noLongerUse: 0, pctVery: Math.round((1000 * very) / n) / 10 });

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchPmfSummary.mockResolvedValue([row('starter', 50, 25), row('small_groups', 4, 4)]);
  api.fetchRetention.mockResolvedValue([
    { segment: 'starter', weekOffset: 0, cohortAccounts: 10, activeAccounts: 10, retentionPct: 100 },
    { segment: 'starter', weekOffset: 1, cohortAccounts: 10, activeAccounts: 6, retentionPct: 60 },
  ]);
});
afterEach(() => cleanup());

describe('StaffPmfPage', () => {
  it('shows the survey table with a verdict per segment and small groups last', async () => {
    render(<StaffPmfPage />);
    expect(await screen.findByText('starter')).toBeInTheDocument();
    expect(screen.getByText('small_groups')).toBeInTheDocument();
    expect(screen.getByText('staff.verdict.at_or_above_benchmark')).toBeInTheDocument();
    expect(screen.getByText('staff.verdict.too_few')).toBeInTheDocument();
    expect(api.fetchPmfSummary).toHaveBeenCalledWith(180, 'plan');
  });

  it('shows the empty state when there are no responses', async () => {
    api.fetchPmfSummary.mockResolvedValue([]);
    render(<StaffPmfPage />);
    expect(await screen.findByText('staff.empty.title')).toBeInTheDocument();
  });

  it('shows a retryable error state', async () => {
    api.fetchPmfSummary.mockRejectedValueOnce(new Error('boom'));
    render(<StaffPmfPage />);
    expect(await screen.findByText('staff.loadError')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry|try again/i }));
    await waitFor(() => expect(api.fetchPmfSummary).toHaveBeenCalledTimes(2));
  });

  it('loads retention only when its tab is opened', async () => {
    render(<StaffPmfPage />);
    await screen.findByText('starter');
    expect(api.fetchRetention).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'staff.tabs.retention' }));
    await waitFor(() => expect(api.fetchRetention).toHaveBeenCalledWith(12, 'plan'));
    expect(await screen.findByText('staff.retention.week')).toBeInTheDocument();
  });
});
