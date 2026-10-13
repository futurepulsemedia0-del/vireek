import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const auth = { user: { id: 'u1' } as { id: string } | null, isOwner: true, profileLoading: false };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(), fetchReports: vi.fn(), saveSettings: vi.fn(), runReportAction: vi.fn(), getPdfUrl: vi.fn(),
}));
vi.mock('@/lib/executiveReport', async () => {
  const actual = await vi.importActual<typeof import('@/lib/executiveReport')>('@/lib/executiveReport');
  return { ...actual, ...api };
});

import { ExecutiveReportsPage } from './ExecutiveReportsPage';

const report = {
  id: 'r1', period_label: 'September 2026', period_start: '2026-09-01', status: 'sent', commentary_source: 'ai',
  pdf_path: 'u1/2026-09.pdf', generated_at: '2026-10-01T08:00:00Z', sent_at: '2026-10-01T08:01:00Z', last_error: null,
  metrics: { current: { revenue: 48230, jobsCompleted: 61, closeRatePct: 54.2, marginPct: 38.1 } },
  commentary: { headline: 'September 2026: revenue up 12% to $48,230' },
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { id: 'u1' }; auth.isOwner = true; auth.profileLoading = false;
  api.fetchSettings.mockResolvedValue(null);
  api.fetchReports.mockResolvedValue([report]);
  api.saveSettings.mockResolvedValue(undefined);
});

describe('ExecutiveReportsPage', () => {
  it('shows an owner-only message to non-owners and loads nothing', () => {
    auth.isOwner = false;
    render(<ExecutiveReportsPage />);
    expect(screen.getByText('Owner access only')).toBeInTheDocument();
    expect(api.fetchReports).not.toHaveBeenCalled();
  });

  it('renders report history with status and key figures', async () => {
    render(<ExecutiveReportsPage />);
    expect(await screen.findByText('September 2026')).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText(/\$48,230 revenue/)).toBeInTheDocument();
  });

  it('shows an empty state when no report exists', async () => {
    api.fetchReports.mockResolvedValue([]);
    render(<ExecutiveReportsPage />);
    expect(await screen.findByText('No reports generated')).toBeInTheDocument();
  });

  it('offers a retry when loading fails', async () => {
    api.fetchReports.mockRejectedValueOnce(new Error('boom'));
    render(<ExecutiveReportsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.fetchReports).toHaveBeenCalledTimes(2));
  });

  it('blocks saving invalid settings and shows field errors', async () => {
    render(<ExecutiveReportsPage />);
    const day = await screen.findByLabelText('Day of month (1–28)');
    fireEvent.change(day, { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /Save settings/ }));
    expect(await screen.findByText('Choose a day between 1 and 28.')).toBeInTheDocument();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('saves valid settings and runs a preview', async () => {
    api.runReportAction.mockResolvedValue({ report: { ...report, pdf_url: null }, delivery: null });
    render(<ExecutiveReportsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Preview last month/ }));
    await waitFor(() => expect(api.runReportAction).toHaveBeenCalledWith('preview', {}));
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('asks for confirmation before sending to all recipients', async () => {
    api.runReportAction.mockResolvedValue({ report: { ...report, pdf_url: null }, delivery: { status: 'sent', sent: 2, total: 2 } });
    render(<ExecutiveReportsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Send to all recipients now/ }));
    expect(api.runReportAction).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(api.runReportAction).toHaveBeenCalledWith('send_now', { resend: false }));
  });
});
