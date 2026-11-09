import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PacksPage } from './PacksPage';

const flag = vi.hoisted(() => ({ on: true }));
const api = vi.hoisted(() => ({
  fetchEntitledPackIds: vi.fn(),
  fetchPackAccountView: vi.fn(),
  applyPlan: vi.fn(),
}));

vi.mock('@/hooks/useFeatureFlag', () => ({ useFeatureFlags: () => ({ ready: true, isEnabled: () => flag.on }) }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/packsApi', () => ({ ...api, friendlyPackError: (e: unknown, f?: string) => f ?? String(e) }));

const empty = { install: null, state: {}, events: [], revertible: null };

beforeEach(() => {
  flag.on = true;
  api.fetchEntitledPackIds.mockReset().mockResolvedValue(['hvac']);
  api.fetchPackAccountView.mockReset().mockResolvedValue(empty);
  api.applyPlan.mockReset().mockResolvedValue({ eventId: 'e1', replayed: false });
});

describe('PacksPage', () => {
  it('shows an unavailable message and loads nothing when the flag is off', () => {
    flag.on = false;
    render(<PacksPage />);
    expect(screen.getByText(/not available on your account yet/i)).toBeDefined();
    expect(api.fetchPackAccountView).not.toHaveBeenCalled();
  });

  it('previews an install, then applies it', async () => {
    render(<PacksPage />);
    fireEvent.click(await screen.findByRole('button', { name: /preview install/i }));
    expect(screen.getByRole('region', { name: /change preview/i })).toBeDefined();
    expect(screen.getByText(/Install 1\.0\.0/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    await waitFor(() => expect(api.applyPlan).toHaveBeenCalledTimes(1));
    expect(api.applyPlan.mock.calls[0][0].kind).toBe('install');
  });

  it('does not allow install when the account is not entitled', async () => {
    api.fetchEntitledPackIds.mockResolvedValue([]);
    render(<PacksPage />);
    const btn = await screen.findByRole('button', { name: /preview install/i });
    fireEvent.click(btn);
    expect(screen.queryByRole('region', { name: /change preview/i })).toBeNull();
  });

  it('shows a retry control when loading fails', async () => {
    api.fetchPackAccountView.mockRejectedValueOnce(new Error('boom'));
    render(<PacksPage />);
    expect(await screen.findByRole('alert')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(api.fetchPackAccountView).toHaveBeenCalledTimes(2));
  });
});
