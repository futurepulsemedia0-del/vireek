import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PublicLienWaiverPage } from './PublicLienWaiverPage';
import type { PublicLienWaiver } from '@/lib/lienWaivers';

const api = vi.hoisted(() => ({
  fetchPublicWaiver: vi.fn(),
  recordPublicView: vi.fn(),
  respondPublic: vi.fn(),
}));

vi.mock('@/lib/lienWaiversApi', () => api);

const TOKEN = '00000000-0000-4000-8000-000000000002';

const PUBLIC: PublicLienWaiver = {
  number: 'LW-0001', title: 'Conditional Waiver and Release on Progress Payment', body: 'WAIVER BODY TEXT', direction: 'given',
  waiverType: 'conditional_progress', stateCode: 'TX', statuteRef: 'Tex. Prop. Code', requiresNotary: false, claimantName: 'Acme HVAC LLC',
  customerName: 'Dana Whitfield', propertyAddress: '12 Elm St', projectName: 'System replacement', throughDate: '2027-01-10', amountCents: 900000,
  status: 'sent', sentAt: '2027-01-11T00:00:00Z', expiresAt: '2027-01-25T00:00:00Z', signedAt: null, signerName: null, signerTitle: null,
  contentHash: null, businessName: 'Acme HVAC',
};

function setup() {
  return render(
    <MemoryRouter initialEntries={[`/lien-waiver/${TOKEN}`]}>
      <Routes><Route path="/lien-waiver/:token" element={<PublicLienWaiverPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('PublicLienWaiverPage', () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    api.fetchPublicWaiver.mockResolvedValue(PUBLIC);
    api.recordPublicView.mockResolvedValue(undefined);
    api.respondPublic.mockResolvedValue(undefined);
  });

  it('loads the frozen wording and records the view', async () => {
    setup();
    expect(screen.getByLabelText('Loading your waiver')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: PUBLIC.title })).toBeTruthy();
    expect(screen.getByTestId('waiver-body').textContent).toBe('WAIVER BODY TEXT');
    expect(api.recordPublicView).toHaveBeenCalledWith(TOKEN);
  });

  it('shows a friendly page for an unknown link', async () => {
    api.fetchPublicWaiver.mockResolvedValue(null);
    setup();
    expect(await screen.findByText(/couldn.t find this waiver/i)).toBeTruthy();
    expect(api.recordPublicView).not.toHaveBeenCalled();
  });

  it('requires a typed name and consent before signing', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign waiver' }));
    expect(await screen.findByText('Please type your full name to sign.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/type your full legal name/i), { target: { value: 'Pat Manager' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign waiver' }));
    expect(await screen.findByText(/confirm that you have read/i)).toBeTruthy();
    expect(api.respondPublic).not.toHaveBeenCalled();
  });

  it('submits a signature and reloads', async () => {
    setup();
    fireEvent.change(await screen.findByLabelText(/type your full legal name/i), { target: { value: 'Pat Manager' } });
    fireEvent.click(screen.getByRole('checkbox'));
    api.fetchPublicWaiver.mockResolvedValue({ ...PUBLIC, status: 'signed', signerName: 'Pat Manager', signedAt: '2027-01-12T00:00:00Z' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign waiver' }));
    await waitFor(() => expect(api.respondPublic).toHaveBeenCalledWith(TOKEN, 'signed', 'Pat Manager', '', ''));
    expect(await screen.findByText('Signed — thank you')).toBeTruthy();
  });

  it('shows the notary warning and no form for an expired link', async () => {
    api.fetchPublicWaiver.mockResolvedValue({ ...PUBLIC, status: 'expired', requiresNotary: true });
    setup();
    expect(await screen.findByText(/signing link has expired/i)).toBeTruthy();
    expect(screen.getByText(/may need to be notarized/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign waiver' })).toBeNull();
  });
});
