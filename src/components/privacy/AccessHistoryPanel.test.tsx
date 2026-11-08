import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { reactI18nextMock } from '@/test/i18nMock';

vi.mock('react-i18next', () => reactI18nextMock);
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('@/lib/privacy/i18n', () => ({ ACCESS_LOG_NS: 'accessLog' }));
const fetchAccessHistory = vi.fn();
vi.mock('@/lib/privacy/accessLog', async (orig) => {
  const actual = await orig<typeof import('@/lib/privacy/accessLog')>();
  return { ...actual, fetchAccessHistory: (...a: unknown[]) => fetchAccessHistory(...a) };
});

import { AccessHistoryPanel } from './AccessHistoryPanel';
import { AccessLogError } from '@/lib/privacy/accessLog';

const ID = '11111111-1111-1111-1111-111111111111';
beforeEach(() => {
  fetchAccessHistory.mockReset();
});

describe('AccessHistoryPanel', () => {
  it('shows a labelled loading status, then rows', async () => {
    fetchAccessHistory.mockResolvedValue([
      { occurredAt: '2026-11-01T10:00:00Z', viewerKind: 'user', viewerEmail: 'mgr@a.test', assetClass: 'transcript', action: 'view', channel: 'rpc', recordCount: 1, isYou: false },
      { occurredAt: '2026-11-01T11:00:00Z', viewerKind: 'vireek_support', viewerEmail: null, assetClass: 'call_recording', action: 'view', channel: 'rpc', recordCount: 1, isYou: false },
    ]);
    render(<AccessHistoryPanel targetTable="calls" targetId={ID} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(screen.getByText('mgr@a.test')).toBeInTheDocument();
    expect(screen.getByText('history.support')).toBeInTheDocument(); // staff never named
    expect(screen.getAllByRole('time')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'history.title' })).toBeInTheDocument();
  });
  it('shows the empty state', async () => {
    fetchAccessHistory.mockResolvedValue([]);
    render(<AccessHistoryPanel targetTable="calls" targetId={ID} />);
    expect(await screen.findByText('history.empty')).toBeInTheDocument();
  });
  it('renders nothing when the viewer is not allowed to see history (no error shown)', async () => {
    fetchAccessHistory.mockRejectedValue(new AccessLogError('forbidden'));
    const { container } = render(<AccessHistoryPanel targetTable="calls" targetId={ID} />);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });
  it('shows an alert with a retry button on failure', async () => {
    fetchAccessHistory.mockRejectedValue(new AccessLogError('unknown'));
    render(<AccessHistoryPanel targetTable="calls" targetId={ID} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'history.retry' })).toBeInTheDocument();
  });
});
