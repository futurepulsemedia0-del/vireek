import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const toast = vi.fn();
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));

const { api } = vi.hoisted(() => ({
  api: {
    fetchQuoteSizing: vi.fn(),
    fetchMatchups: vi.fn(),
    saveQuoteSizing: vi.fn(),
    selectQuoteMatchup: vi.fn(),
    applyMatchupToQuote: vi.fn(),
    importMatchups: vi.fn(),
    setMatchupVerified: vi.fn(),
    setMatchupActive: vi.fn(),
    deleteMatchup: vi.fn(),
  },
}));
vi.mock('@/lib/hvacSizingApi', () => ({
  fetchQuoteSizing: (...a: unknown[]) => api.fetchQuoteSizing(...a),
  fetchMatchups: (...a: unknown[]) => api.fetchMatchups(...a),
  saveQuoteSizing: (...a: unknown[]) => api.saveQuoteSizing(...a),
  selectQuoteMatchup: (...a: unknown[]) => api.selectQuoteMatchup(...a),
  applyMatchupToQuote: (...a: unknown[]) => api.applyMatchupToQuote(...a),
  importMatchups: (...a: unknown[]) => api.importMatchups(...a),
  setMatchupVerified: (...a: unknown[]) => api.setMatchupVerified(...a),
  setMatchupActive: (...a: unknown[]) => api.setMatchupActive(...a),
  deleteMatchup: (...a: unknown[]) => api.deleteMatchup(...a),
}));

import { QuoteHvacPanel } from '@/components/quotes/QuoteHvacPanel';

const emptySizing = { ok: true, data: { quoteStatus: 'draft', tiered: false, sizing: null } };
const matchup = {
  id: 'm1', ahri_ref_number: '1001', manufacturer: 'Acme', brand: null, system_type: 'split_hp', staging: 'variable',
  outdoor_model: 'OUT-24', indoor_model: 'COIL-24', furnace_model: null, cooling_btuh: 24000, seer2: 16, eer2: 11.5, hspf2: 8.5,
  heating_47_btuh: 24000, heating_17_btuh: 15000, furnace_output_btuh: null, shr: 0.78, airflow_cfm: 800, refrigerant: null,
  sell_price_cents: 850000, ahri_status: 'verified', verified_at: '2026-10-01T00:00:00Z', active: true, notes: null, created_at: '', updated_at: '',
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  toast.mockReset();
  api.fetchQuoteSizing.mockResolvedValue(emptySizing);
  api.fetchMatchups.mockResolvedValue({ ok: true, data: [] });
});
afterEach(cleanup);

describe('QuoteHvacPanel', () => {
  it('shows a loading state, then the load tab with results for the default house', async () => {
    render(<QuoteHvacPanel quoteId="q1" quoteStatus="draft" />);
    expect(screen.getByRole('status', { name: /loading hvac sizing/i })).toBeInTheDocument();
    expect(await screen.findByText(/total cooling load/i)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Load', selected: true })).toBeInTheDocument();
    expect(screen.getByText(/not an acca-approved manual j report/i)).toBeInTheDocument();
  });

  it('shows a retryable error when loading fails', async () => {
    api.fetchQuoteSizing.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    render(<QuoteHvacPanel quoteId="q1" quoteStatus="draft" />);
    expect(await screen.findByText(/couldn.t load hvac sizing/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/total cooling load/i)).toBeInTheDocument();
  });

  it('shows the forbidden state without a retry button', async () => {
    api.fetchQuoteSizing.mockResolvedValue({ ok: false, reason: 'forbidden' });
    render(<QuoteHvacPanel quoteId="q1" quoteStatus="draft" />);
    expect(await screen.findByText(/don.t have access to hvac sizing/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('flags an invalid field, hides the result, and keeps Save disabled', async () => {
    render(<QuoteHvacPanel quoteId="q1" quoteStatus="draft" />);
    const area = await screen.findByLabelText(/conditioned area/i);
    fireEvent.change(area, { target: { value: '' } });
    expect(await screen.findByText(/must be between 200 and 20000/i)).toBeInTheDocument();
    expect(screen.getByText(/fix the highlighted fields/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('saves the calculation once something changed', async () => {
    api.saveQuoteSizing.mockResolvedValue({ ok: true, data: '2026-10-27T10:00:00Z' });
    render(<QuoteHvacPanel quoteId="q1" quoteStatus="draft" />);
    const save = await screen.findByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/conditioned area/i), { target: { value: '2400' } });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(api.saveQuoteSizing).toHaveBeenCalled());
    const [quoteId, payload] = api.saveQuoteSizing.mock.calls[0];
    expect(quoteId).toBe('q1');
    expect(payload.loadInputs.conditionedAreaSqft).toBe(2400);
    expect(payload.loadResult.cooling.totalBtuh).toBeGreaterThan(0);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Calculation saved', 'success'));
    await waitFor(() => expect(save).toBeDisabled());
  });

  it('prompts to import equipment when the catalog is empty', async () => {
    render(<QuoteHvacPanel quoteId="q1" quoteStatus="draft" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Equipment' }));
    fireEvent.change(screen.getByLabelText(/efficiency region/i), { target: { value: 'south' } });
    expect(await screen.findByText(/add your ahri matchups/i)).toBeInTheDocument();
  });

  it('asks for a region before ranking, then ranks and selects a matchup', async () => {
    api.fetchMatchups.mockResolvedValue({ ok: true, data: [matchup] });
    api.selectQuoteMatchup.mockResolvedValue({ ok: true, data: true });
    render(<QuoteHvacPanel quoteId="q1" quoteStatus="draft" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Equipment' }));
    expect(screen.getByText(/choose the efficiency region/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/efficiency region/i), { target: { value: 'south' } });
    const card = (await screen.findByText(/Acme 2.0-ton split heat pump/i)).closest('li') as HTMLElement;
    expect(within(card).getByText(/AHRI verified/i)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: /use for this quote/i }));
    await waitFor(() => expect(api.selectQuoteMatchup).toHaveBeenCalledWith('q1', 'm1'));
  });

  it('only offers the line item on draft, non-tiered quotes', async () => {
    api.fetchMatchups.mockResolvedValue({ ok: true, data: [matchup] });
    api.fetchQuoteSizing.mockResolvedValue({
      ok: true,
      data: { quoteStatus: 'sent', tiered: false, sizing: { load_inputs: null, load_result: null, duct_inputs: null, duct_result: null, region: 'south', selected_matchup_id: 'm1', selection_snapshot: matchup, updated_at: null } },
    });
    render(<QuoteHvacPanel quoteId="q1" quoteStatus="sent" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Equipment' }));
    expect(await screen.findByText(/chosen for this quote/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add to quote as line item/i })).toBeDisabled();
    expect(screen.getByText(/only draft quotes can be changed/i)).toBeInTheDocument();
  });

  it('adds the chosen system to a draft quote at the entered price', async () => {
    api.fetchMatchups.mockResolvedValue({ ok: true, data: [matchup] });
    api.applyMatchupToQuote.mockResolvedValue({ ok: true, data: { added: true } });
    api.fetchQuoteSizing.mockResolvedValue({
      ok: true,
      data: { quoteStatus: 'draft', tiered: false, sizing: { load_inputs: null, load_result: null, duct_inputs: null, duct_result: null, region: 'south', selected_matchup_id: 'm1', selection_snapshot: matchup, updated_at: null } },
    });
    render(<QuoteHvacPanel quoteId="q1" quoteStatus="draft" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Equipment' }));
    fireEvent.click(await screen.findByRole('button', { name: /add to quote as line item/i }));
    await waitFor(() => expect(api.applyMatchupToQuote).toHaveBeenCalledWith('q1', 850000));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Added to the quote as a line item', 'success'));
  });

  it('sizes ducts for rooms the user adds', async () => {
    render(<QuoteHvacPanel quoteId="q1" quoteStatus="draft" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Ducts' }));
    expect((await screen.findAllByText(/add at least one room/i)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /add room/i }));
    fireEvent.change(screen.getByLabelText('Room'), { target: { value: 'Living' } });
    fireEvent.change(screen.getByLabelText(/or load/i), { target: { value: '9000' } });
    expect(await screen.findByRole('table', { name: /duct sizes/i })).toBeInTheDocument();
    expect(screen.getByText('Living')).toBeInTheDocument();
  });

  it('supports arrow-key navigation between tabs', async () => {
    render(<QuoteHvacPanel quoteId="q1" quoteStatus="draft" />);
    const load = await screen.findByRole('tab', { name: 'Load' });
    fireEvent.keyDown(load, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Equipment', selected: true })).toBeInTheDocument();
  });
});
