import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCallQaPage } from '@/pages/AiCallQaPage';

const auth = { isOwner: true, permissions: { can_edit_business_profile: true } as Record<string, boolean> };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const api = vi.hoisted(() => ({ claimNext: vi.fn(), submitReview: vi.fn(), skipItem: vi.fn(), releaseItem: vi.fn(), fetchMonthlyReport: vi.fn(), fetchFeedback: vi.fn(), setFeedbackStatus: vi.fn(), fetchSettings: vi.fn(), saveSettings: vi.fn() }));
vi.mock('@/lib/aiCallQa', async (orig) => ({ ...(await orig<typeof import('@/lib/aiCallQa')>()), ...api }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

const item = {
  item_id: 'i1', call_id: 'c1', call_at: '2026-11-24T10:00:00Z', stratum: 'risk', risk_flags: ['emergency'], summary: 'Burst pipe', transcript: 'Hello', duration_seconds: 60, is_emergency: true,
  rubric: { id: 'r1', version: 1, criteria: ['accuracy', 'safety', 'disclosure', 'resolution', 'tone'].map((k, i) => ({ key: k, label: k.toUpperCase(), weight: [30, 25, 15, 20, 10][i], description: '' })) },
};
const renderPage = () => render(<MemoryRouter><AiCallQaPage /></MemoryRouter>);

describe('AiCallQaPage', () => {
  beforeEach(() => { vi.clearAllMocks(); auth.isOwner = true; auth.permissions = { can_edit_business_profile: true }; });

  it('blocks users without permission and never calls the API', () => {
    auth.isOwner = false; auth.permissions = {};
    renderPage();
    expect(screen.getByText(/do not have access/i)).toBeTruthy();
    expect(api.claimNext).not.toHaveBeenCalled();
  });

  it('shows the empty state when the queue is empty', async () => {
    api.claimNext.mockResolvedValue(null);
    renderPage();
    expect(await screen.findByText(/no calls waiting for review/i)).toBeTruthy();
  });

  it('shows a retryable error', async () => {
    api.claimNext.mockRejectedValue(new Error('x'));
    renderPage();
    expect(await screen.findByText(/could not load the review queue/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('requires 3 scored criteria, then submits and loads the next call', async () => {
    api.claimNext.mockResolvedValueOnce(item).mockResolvedValueOnce(null);
    api.submitReview.mockResolvedValue({ review_id: 'rv', overall: 100, verdict: 'pass' });
    renderPage();
    const submit = await screen.findByRole('button', { name: /submit review/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    const radios = screen.getAllByRole('radio', { name: '5' });
    fireEvent.click(radios[0]); fireEvent.click(radios[1]); fireEvent.click(radios[2]);
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole('status').textContent).toMatch(/100\/100/);
    fireEvent.click(submit);
    await waitFor(() => expect(api.submitReview).toHaveBeenCalledWith('i1', { accuracy: 5, safety: 5, disclosure: 5 }, false, '', []));
    expect(await screen.findByText(/no calls waiting for review/i)).toBeTruthy();
  });

  it('hides the Settings tab from non-owners', async () => {
    auth.isOwner = false;
    api.claimNext.mockResolvedValue(null);
    renderPage();
    await screen.findByText(/no calls waiting/i);
    expect(screen.queryByRole('tab', { name: /settings/i })).toBeNull();
  });
});
