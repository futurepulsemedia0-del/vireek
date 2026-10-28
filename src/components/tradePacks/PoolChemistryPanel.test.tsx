import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  fetchLogEntries: vi.fn(),
  fetchProducts: vi.fn(),
  fetchTeam: vi.fn(),
  addLogEntry: vi.fn(),
}));
vi.mock('@/lib/tradePacksApi', () => ({
  ...api,
  friendlyTradePackError: (_e: unknown, fb = 'Something went wrong.') => fb,
}));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { PoolChemistryPanel } from './PoolChemistryPanel';
import { POOL_SERVICE_PACK } from '@/lib/tradePacks';

const bleach = {
  id: 'p1',
  pack_key: 'pool_service',
  name: 'Liquid Chlorine 12.5',
  kind: 'sanitizer',
  unit: 'fl_oz',
  chem_key: 'liquid_chlorine',
  strength_pct: 12.5,
  archived_at: null,
};
const job = { id: 'job1', customer_id: 'cust1', assigned_technician_id: 'tech1' };

const renderPanel = () =>
  render(
    <MemoryRouter>
      <PoolChemistryPanel pack={POOL_SERVICE_PACK} ownerId="owner1" job={job} />
    </MemoryRouter>,
  );

const type = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchLogEntries.mockResolvedValue([]);
  api.fetchProducts.mockResolvedValue([bleach]);
  api.fetchTeam.mockResolvedValue([{ id: 'tech1', member_name: 'Tom Tech' }]);
  api.addLogEntry.mockResolvedValue(undefined);
});

describe('PoolChemistryPanel', () => {
  it('shows a loading state, then the empty state with no readings yet', async () => {
    const { container } = renderPanel();
    expect(
      container.querySelector(
        '[class*="animate-pulse"], [aria-busy="true"], [class*="skeleton" i]',
      ) ?? container.firstChild,
    ).toBeTruthy();
    expect(await screen.findByText(/Enter at least one reading/i)).toBeInTheDocument();
    expect(screen.getByText(/No readings yet/i)).toBeInTheDocument();
  });

  it('shows an error with a retry button when loading fails, and recovers', async () => {
    api.fetchProducts.mockRejectedValueOnce(new Error('boom'));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Could not load water chemistry records/i,
    );
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/Water chemistry & dosing/i)).toBeInTheDocument();
  });

  it('flags readings and recommends doses live as the technician types', async () => {
    renderPanel();
    await screen.findByText(/Water chemistry & dosing/i);
    type(/Water volume/i, '10000');
    type(/Free chlorine/i, '0.7');
    expect(await screen.findByText(/Raise free chlorine to 3 ppm/i)).toBeInTheDocument();
    expect(screen.getByText(/Free chlorine: low/i)).toBeInTheDocument();
    expect(screen.getByText(/Log 23\.\d fl oz of Liquid Chlorine 12\.5/i)).toBeInTheDocument();
  });

  it('logs a recommended dose against the registered product', async () => {
    renderPanel();
    await screen.findByText(/Water chemistry & dosing/i);
    type(/Water volume/i, '10000');
    type(/Free chlorine/i, '0.7');
    fireEvent.click(await screen.findByRole('button', { name: /Log 23\.\d fl oz/i }));
    await waitFor(() => expect(api.addLogEntry).toHaveBeenCalledTimes(1));
    expect(api.addLogEntry.mock.calls[0][1]).toMatchObject({
      packKey: 'pool_service',
      entryType: 'dosing',
      jobId: 'job1',
      productId: 'p1',
      technicianId: 'tech1',
      data: { amount_unit: 'fl_oz', target: 'Raise chlorine', from_recommendation: true },
    });
    expect(api.addLogEntry.mock.calls[0][1].data.amount).toBeCloseTo(23.6, 1);
    expect(await screen.findByText('Logged')).toBeInTheDocument();
  });

  it('saves a reading with the pool profile and refuses to save an empty one', async () => {
    renderPanel();
    await screen.findByText(/Water chemistry & dosing/i);
    expect(screen.getByRole('button', { name: /save reading/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^Spa/i }));
    type(/Water volume/i, '400');
    type(/^pH$/i, '7.5');
    fireEvent.click(screen.getByRole('button', { name: /save reading/i }));
    await waitFor(() => expect(api.addLogEntry).toHaveBeenCalledTimes(1));
    expect(api.addLogEntry.mock.calls[0][1]).toMatchObject({
      entryType: 'chemistry_reading',
      technicianId: 'tech1',
      data: { water_body: 'Spa / hot tub', sanitizer: 'Liquid chlorine', volume_gal: 400, ph: 7.5 },
    });
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled();
  });

  it('tells the technician to register a product when none matches the chemical', async () => {
    api.fetchProducts.mockResolvedValue([]);
    renderPanel();
    await screen.findByText(/Water chemistry & dosing/i);
    type(/Water volume/i, '10000');
    type(/Free chlorine/i, '0.7');
    expect(await screen.findByText(/add a matching product/i)).toBeInTheDocument();
    expect(screen.getByText(/Assumes standard strength/i)).toBeInTheDocument();
  });

  it('pre-fills the pool profile from the previous reading and shows history', async () => {
    api.fetchLogEntries.mockImplementation(async (_o: string, q: { entryType?: string }) =>
      q.entryType === 'chemistry_reading'
        ? [
            {
              id: 'r1',
              entry_type: 'chemistry_reading',
              performed_at: '2027-03-01T10:00:00Z',
              voided_at: null,
              data: {
                ph: 7.4,
                fc: 3,
                water_body: 'Pool',
                volume_gal: 18000,
                sanitizer: 'Salt (SWG)',
              },
            },
          ]
        : [],
    );
    renderPanel();
    await screen.findByText(/Water chemistry & dosing/i);
    await waitFor(() =>
      expect((screen.getByLabelText(/Water volume/i) as HTMLInputElement).value).toBe('18000'),
    );
    expect((screen.getByLabelText(/Sanitizer system/i) as HTMLSelectElement).value).toBe(
      'Salt (SWG)',
    );
    expect(screen.getByText(/Reading history for this customer/i)).toBeInTheDocument();
    expect(screen.getAllByText('7.4').length).toBeGreaterThan(0);
  });
});
