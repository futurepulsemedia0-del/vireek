import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/propertyVision', () => ({ uploadPropertyPhoto: vi.fn() }));
vi.mock('@/lib/equipmentNameplate', async (orig) => ({
  ...(await orig<typeof import('@/lib/equipmentNameplate')>()),
  scanNameplate: vi.fn(),
  createFromNameplate: vi.fn(),
}));

import * as api from '@/lib/equipmentNameplate';
import { NameplateScanCard } from './NameplateScanCard';

const fields = (over: Partial<api.NameplateFields> = {}): api.NameplateFields => ({
  plate_found: true, kind: 'water_heater', make: 'Rheem', model: 'PROG50', serial: 'RH1219456789', serial_legibility: 'clear', specs: null,
  manufacture: { date: '2023-03-01', precision: 'month', raw_text: '03/2023', problem: null }, confidence: 0.93, photo_issues: [], ...over,
});
const warranty = (over: Partial<api.NameplateWarranty> = {}): api.NameplateWarranty => ({
  state: 'active', days_left: 900, expires_at: '2029-03-01', term_years: 6, basis: 'estimated', note: 'Estimated: typical 6-year warranty.', ...over,
});
const scan = (over: Partial<api.NameplateScan> = {}): api.NameplateScan => ({
  id: 's1', status: 'extracted', fields: fields(), review_reasons: [], auto_create_ready: true, warranty: warranty(), equipment_id: null, cached: false, ...over,
});
const created = (over: Partial<api.NameplateCreated> = {}): api.NameplateCreated => ({
  equipment_id: 'e1', reused: false, passport: { code: 'ABCDEFGHJKMN', verified: true, joined_existing: false }, warranty: warranty(), ...over,
});

const pick = (container: HTMLElement) => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], 'plate.jpg', { type: 'image/jpeg' })] } });
};
const renderCard = (onCreated = vi.fn()) =>
  ({ onCreated, ...render(<MemoryRouter><NameplateScanCard jobId="job-1" customerId="cust-1" onCreated={onCreated} /></MemoryRouter>) });

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('NameplateScanCard', () => {
  it('auto-creates a confident read and shows the passport and warranty', async () => {
    vi.mocked(api.scanNameplate).mockResolvedValue({ scan: scan({ status: 'created' }), created: created() });
    const { container, onCreated } = renderCard();
    pick(container);
    expect(await screen.findByText('Equipment added')).toBeInTheDocument();
    expect(api.scanNameplate).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', customerId: 'cust-1' }));
    expect(screen.getByText('Rheem PROG50')).toBeInTheDocument();
    expect(screen.getByText('Manufactured 03/2023')).toBeInTheDocument();
    expect(screen.getByText(/Likely under warranty until 2029-03-01/)).toBeInTheDocument();
    expect(screen.getByText(/Estimated: typical 6-year/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Passport VEQ-ABCD-EFGH-JKMN/ })).toHaveAttribute('href', '/e/ABCDEFGHJKMN');
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('sends a doubtful read to review, then creates it with the technician\'s corrections', async () => {
    vi.mocked(api.scanNameplate).mockResolvedValue({
      scan: scan({ auto_create_ready: false, review_reasons: ['serial_partial'], fields: fields({ serial: 'RH12194567', serial_legibility: 'partial' }) }), created: null,
    });
    vi.mocked(api.createFromNameplate).mockResolvedValue({ scan: scan({ status: 'created' }), created: created() });
    const { container, onCreated } = renderCard();
    pick(container);

    expect(await screen.findByText(/Check this read before the passport is created/)).toBeInTheDocument();
    expect(screen.getByText(/serial number may be misread/i)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Serial number'), { target: { value: 'RH1219456789' } });
    fireEvent.change(screen.getByLabelText(/Installed/), { target: { value: '2023-04-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create passport' }));

    expect(await screen.findByText('Equipment added')).toBeInTheDocument();
    expect(api.createFromNameplate).toHaveBeenCalledWith('s1', expect.objectContaining({ make: 'Rheem', serial: 'RH1219456789', installDate: '2023-04-10', manufactureDate: '2023-03' }));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('will not submit without a brand', async () => {
    vi.mocked(api.scanNameplate).mockResolvedValue({ scan: scan({ auto_create_ready: false, review_reasons: ['missing_make'], fields: fields({ make: null }) }), created: null });
    const { container } = renderCard();
    pick(container);
    const submit = await screen.findByRole('button', { name: 'Create passport' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Brand'), { target: { value: 'Bradford White' } });
    expect(submit).toBeEnabled();
  });

  it('keeps the review form (and the typed values) when creation fails', async () => {
    vi.mocked(api.scanNameplate).mockResolvedValue({ scan: scan({ auto_create_ready: false, review_reasons: ['low_confidence'] }), created: null });
    vi.mocked(api.createFromNameplate).mockRejectedValue(new Error('That serial number does not look valid.'));
    const { container } = renderCard();
    pick(container);
    fireEvent.change(await screen.findByLabelText('Serial number'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create passport' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That serial number does not look valid.');
    expect(screen.getByLabelText('Serial number')).toHaveValue('12');
  });

  it('shows the error and returns to the start when reading fails', async () => {
    vi.mocked(api.scanNameplate).mockRejectedValue(new Error("You've hit the hourly limit for photo analysis."));
    const { container } = renderCard();
    pick(container);
    expect(await screen.findByRole('alert')).toHaveTextContent(/hourly limit/);
    expect(screen.getByRole('button', { name: /Scan data plate/ })).toBeEnabled();
  });

  it('rejects a non-image without calling the server', async () => {
    const { container } = renderCard();
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/photo of the data plate/);
    expect(api.scanNameplate).not.toHaveBeenCalled();
  });

  it('withholds the passport code and explains the QR step when joining another company\'s passport', async () => {
    vi.mocked(api.scanNameplate).mockResolvedValue({
      scan: scan({ status: 'created' }), created: created({ passport: { code: null, verified: false, joined_existing: true } }),
    });
    const { container } = renderCard();
    pick(container);
    expect(await screen.findByText(/already has a passport from another company/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Passport VEQ/ })).not.toBeInTheDocument();
  });

  it('says so when the customer already had this unit, and shows an expired warranty', async () => {
    vi.mocked(api.scanNameplate).mockResolvedValue({
      scan: scan({ status: 'created' }), created: created({ reused: true, warranty: warranty({ state: 'expired', days_left: -400, expires_at: '2025-03-01' }) }),
    });
    const { container } = renderCard();
    pick(container);
    expect(await screen.findByText('Already on file for this customer')).toBeInTheDocument();
    expect(screen.getByText(/Warranty likely expired 2025-03-01/)).toBeInTheDocument();
  });

  it('can scan another plate after finishing', async () => {
    vi.mocked(api.scanNameplate).mockResolvedValue({ scan: scan({ status: 'created' }), created: created() });
    const { container } = renderCard();
    pick(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Scan another plate' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Scan data plate$/ })).toBeInTheDocument());
  });
});
