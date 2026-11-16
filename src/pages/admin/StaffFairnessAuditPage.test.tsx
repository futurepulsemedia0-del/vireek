import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { StaffFairnessAuditPage } from '@/pages/admin/StaffFairnessAuditPage';

vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/lib/seo', () => ({ useSEO: () => undefined }));
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }));

const cell = (dimension: string, group: string, calls: number, mean: number) => ({
  dimension, group, calls, reviewed: calls, accounts: 6, score_sum: calls * mean, score_sumsq: calls * mean * mean + (calls - 1) * 64,
  low_score: 0, missed_booking: 0, critical: 0,
});

afterEach(() => { cleanup(); rpc.mockReset(); });

describe('StaffFairnessAuditPage', () => {
  it('shows the forbidden state for non-staff', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'forbidden' } });
    render(<StaffFairnessAuditPage />);
    expect(await screen.findByText('Staff access required.')).toBeTruthy();
  });

  it('shows an error with retry', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    render(<StaffFairnessAuditPage />);
    expect(await screen.findByText(/Could not load the fairness audit: boom/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows the empty state', async () => {
    rpc.mockResolvedValue({ data: { generated_at: '2029-03-05T00:00:00Z', days: 90, low_score_below: 60, cells: [] }, error: null });
    render(<StaffFairnessAuditPage />);
    expect(await screen.findByText('No calls in this window.')).toBeTruthy();
  });

  it('flags an adverse gap, hides counts of small groups, and calls the RPC with the window', async () => {
    rpc.mockResolvedValue({ data: { generated_at: '2029-03-05T00:00:00Z', days: 90, low_score_below: 60, cells: [
      cell('language', 'en', 800, 85), cell('language', 'es', 200, 70), cell('language', 'fr', 5, 80),
    ] }, error: null });
    render(<StaffFairnessAuditPage />);
    await waitFor(() => expect(screen.getAllByText('Review (adverse)').length).toBeGreaterThan(0));
    expect(screen.getByText(/Suppressed — fewer than 30 reviewed calls/)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('staff_fairness_overview', { p_days: 90, p_low_score: 60 });
  });
});
