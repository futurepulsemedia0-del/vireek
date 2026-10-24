import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args), from: vi.fn() },
}));

import { jobBoardApi } from './jobBoardApi';

beforeEach(() => rpcMock.mockReset());

describe('jobBoardApi RPC contract', () => {
  it('posts a job with the exact parameter names the migration defines', async () => {
    rpcMock.mockResolvedValue({ data: 'post-1', error: null });
    const id = await jobBoardApi.post({
      jobId: 'j1',
      source: 'overflow',
      audience: 'both',
      claimMode: 'bidding',
      priority: 'urgent',
      skill: '',
      areaId: null,
      title: 'No heat',
      summary: '',
      locationLabel: '',
      offerCents: 5000,
      maxBidCents: null,
      expiresMinutes: 60,
      autoAward: true,
    });
    expect(id).toBe('post-1');
    expect(rpcMock).toHaveBeenCalledWith('post_job_board_job', {
      p_job_id: 'j1',
      p_source: 'overflow',
      p_audience: 'both',
      p_claim_mode: 'bidding',
      p_priority: 'urgent',
      p_skill: null,
      p_area_id: null,
      p_title: 'No heat',
      p_summary: null,
      p_location_label: null,
      p_offer_cents: 5000,
      p_max_bid_cents: null,
      p_expires_minutes: 60,
      p_auto_award: true,
    });
  });

  it('sends an override as one target plus a reason, never both targets', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    await jobBoardApi.override('p1', { technicianId: 't1' }, 'Customer request');
    expect(rpcMock).toHaveBeenCalledWith('award_job_board_post', {
      p_post_id: 'p1',
      p_technician_id: 't1',
      p_vendor_id: null,
      p_price_cents: null,
      p_override: true,
      p_reason: 'Customer request',
    });
  });

  it('awards a bid without the override flag', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    await jobBoardApi.awardBid('p1', 'b1', 7000);
    expect(rpcMock).toHaveBeenCalledWith('award_job_board_post', { p_post_id: 'p1', p_bid_id: 'b1', p_price_cents: 7000 });
  });

  it('escalates to the network with trade, fee and smart-match', async () => {
    rpcMock.mockResolvedValue({ data: 'h1', error: null });
    await expect(jobBoardApi.escalate('p1', 'hvac', 12, '', true)).resolves.toBe('h1');
    expect(rpcMock).toHaveBeenCalledWith('escalate_job_board_post_to_network', {
      p_post_id: 'p1',
      p_trade: 'hvac',
      p_referral_fee_pct: 12,
      p_notes: null,
      p_smart_match: true,
    });
  });

  it('technician and subcontractor calls use their own RPCs', async () => {
    rpcMock.mockResolvedValue({ data: 'bid', error: null });
    await expect(jobBoardApi.claim('p1', 'on it')).resolves.toBe('bid');
    expect(rpcMock).toHaveBeenLastCalledWith('claim_job_board_post', { p_post_id: 'p1', p_note: 'on it' });
    await jobBoardApi.respondOffer('tok', 'bid', 75000, 'ok');
    expect(rpcMock).toHaveBeenLastCalledWith('respond_job_board_offer', {
      p_token: 'tok',
      p_action: 'bid',
      p_price_cents: 75000,
      p_note: 'ok',
    });
    await jobBoardApi.getOffer('tok');
    expect(rpcMock).toHaveBeenLastCalledWith('get_job_board_offer', { p_token: 'tok' });
  });

  it('throws an Error carrying the RPC machine code', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'NOT_OPEN_YET' } });
    await expect(jobBoardApi.claim('p1')).rejects.toThrow('NOT_OPEN_YET');
  });
});
