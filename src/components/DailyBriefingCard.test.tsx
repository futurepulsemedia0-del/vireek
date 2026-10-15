import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Briefing } from '@/lib/dailyBriefing';

const api = vi.hoisted(() => ({ fetchLatestBriefing: vi.fn(), refreshBriefing: vi.fn() }));
vi.mock('@/lib/dailyBriefingApi', () => api);

import { DailyBriefingCard } from './DailyBriefingCard';

const briefing: Briefing = {
  version: 1,
  date: '2026-10-12',
  role: 'owner',
  recipientName: 'Sam',
  severity: 'urgent',
  headline: '1 unhandled emergency · $1,000 overdue',
  sections: [
    {
      key: 'emergencies',
      title: 'Emergencies',
      items: [{ text: 'Emergency call from Zoe', tone: 'bad', href: '/dashboard/calls' }],
    },
    {
      key: 'actions',
      title: 'Recommended actions',
      items: [{ text: 'Add Friday coverage', tone: 'neutral', tag: 'AI' }],
    },
    { key: 'expiring', title: 'Expiring soon', items: [] },
  ],
};
const renderCard = () =>
  render(
    <MemoryRouter>
      <DailyBriefingCard />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DailyBriefingCard', () => {
  it('renders headline, populated sections, AI tag, links and collapses clear sections', async () => {
    api.fetchLatestBriefing.mockResolvedValue(briefing);
    renderCard();
    expect(await screen.findByText(briefing.headline)).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Emergency call from Zoe' })).toHaveAttribute(
      'href',
      '/dashboard/calls',
    );
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getByText(/All clear: Expiring soon/)).toBeInTheDocument();
  });

  it('offers to build the first briefing and reloads after a successful build', async () => {
    api.fetchLatestBriefing.mockResolvedValueOnce(null).mockResolvedValueOnce(briefing);
    api.refreshBriefing.mockResolvedValue(true);
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /Build today/ }));
    expect(await screen.findByText(briefing.headline)).toBeInTheDocument();
    expect(api.refreshBriefing).toHaveBeenCalledTimes(1);
  });

  it('keeps the empty state if the build fails', async () => {
    api.fetchLatestBriefing.mockResolvedValue(null);
    api.refreshBriefing.mockResolvedValue(false);
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /Build today/ }));
    await waitFor(() => expect(api.refreshBriefing).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /Build today/ })).toBeEnabled();
    expect(api.fetchLatestBriefing).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when loading fails', async () => {
    api.fetchLatestBriefing.mockRejectedValue(new Error('boom'));
    const { container } = renderCard();
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });
});
