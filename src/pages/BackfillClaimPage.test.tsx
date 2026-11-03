import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const previewClaim = vi.fn();
const submitClaim = vi.fn();
vi.mock('@/lib/capacityGuard/api', () => ({ previewClaim: (t: string) => previewClaim(t), submitClaim: (t: string) => submitClaim(t) }));
vi.mock('@/lib/capacityGuard/i18n', () => ({ CAPACITY_GUARD_NS: 'capacityGuard' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { slot?: string }) => (o?.slot ? `${k}:${o.slot}` : k) }) }));

import { BackfillClaimPage } from './BackfillClaimPage';
const renderPage = () => render(<MemoryRouter initialEntries={['/claim/tok']}><Routes><Route path="/claim/:token" element={<BackfillClaimPage />} /></Routes></MemoryRouter>);

describe('BackfillClaimPage', () => {
  beforeEach(() => { previewClaim.mockReset(); submitClaim.mockReset(); });

  it('viewing the link NEVER claims (scanner / link-preview safe)', async () => {
    previewClaim.mockResolvedValue({ status: 'available', slot_label: 'Tue 10:00' });
    renderPage();
    await screen.findByText('Tue 10:00');
    expect(submitClaim).not.toHaveBeenCalled();
  });

  it('claims only on button click and shows the booked state', async () => {
    previewClaim.mockResolvedValue({ status: 'available', slot_label: 'Tue 10:00' });
    submitClaim.mockResolvedValue({ status: 'claimed', slot_label: 'Tue 10:00' });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'claim.button' }));
    await screen.findByText('claim.claimed');
    expect(submitClaim).toHaveBeenCalledTimes(1);
  });

  it.each([['already_filled', 'claim.filled'], ['expired', 'claim.expired'], ['invalid', 'claim.invalid']])('%s preview renders no claim button', async (status, text) => {
    previewClaim.mockResolvedValue({ status });
    renderPage();
    await screen.findByText(text);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a lost race shows the friendly "someone else took it" state', async () => {
    previewClaim.mockResolvedValue({ status: 'available', slot_label: 'x' });
    submitClaim.mockResolvedValue({ status: 'already_filled' });
    renderPage();
    await userEvent.click(await screen.findByRole('button'));
    await screen.findByText('claim.filled');
  });

  it('network failure on preview degrades to the invalid state', async () => {
    previewClaim.mockRejectedValue(new Error('offline'));
    renderPage();
    await screen.findByText('claim.invalid');
  });

  it('has no axe-core violations in the available state', async () => {
    previewClaim.mockResolvedValue({ status: 'available', slot_label: 'Tue 10:00' });
    const { container } = renderPage();
    await screen.findByText('Tue 10:00');
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } }); // jsdom cannot compute contrast
    await waitFor(() => expect(res.violations).toEqual([]));
  });
});
