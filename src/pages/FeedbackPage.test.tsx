import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { RoadmapItem } from '@/lib/roadmap';

const api = vi.hoisted(() => ({
  fetchRoadmapItems: vi.fn(),
  fetchMyVotedItemIds: vi.fn(),
  submitRoadmapItem: vi.fn(),
  voteRoadmapItem: vi.fn(),
  unvoteRoadmapItem: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@/lib/roadmap', () => ({
  ...api,
  ROADMAP_STATUS_META: {
    under_review: { label: 'Under Review' },
    planned: { label: 'Planned' },
    in_progress: { label: 'In Progress' },
    shipped: { label: 'Shipped' },
  },
  ROADMAP_CATEGORY_META: {
    feature: { label: 'New Feature' },
    integration: { label: 'Integration' },
    improvement: { label: 'Improvement' },
    general: { label: 'General' },
  },
}));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' }, profileLoading: false }) }));

import { FeedbackPage } from './FeedbackPage';

const item = (o: Partial<RoadmapItem> & { id: string; title: string }): RoadmapItem => ({
  description: '',
  category: 'feature',
  status: 'under_review',
  votes_count: 0,
  submitted_by: null,
  admin_note: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...o,
});

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchMyVotedItemIds.mockResolvedValue(new Set<string>());
});

describe('FeedbackPage', () => {
  it('shows the empty state when there are no ideas', async () => {
    api.fetchRoadmapItems.mockResolvedValue([]);
    render(<FeedbackPage />);
    expect(await screen.findByText('No ideas yet')).toBeInTheDocument();
  });

  it('shows an error with retry when loading fails', async () => {
    api.fetchRoadmapItems.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([item({ id: 'a', title: 'Dark mode' })]);
    render(<FeedbackPage />);
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Dark mode')).toBeInTheDocument();
  });

  it('votes optimistically and rolls back on failure', async () => {
    api.fetchRoadmapItems.mockResolvedValue([item({ id: 'a', title: 'Dark mode', votes_count: 2 })]);
    api.voteRoadmapItem.mockRejectedValueOnce(new Error('rls')).mockResolvedValueOnce(undefined);
    render(<FeedbackPage />);
    const btn = await screen.findByRole('button', { name: /vote for dark mode/i });
    fireEvent.click(btn);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/could not save/i), 'error'));
    expect(btn).toHaveTextContent('2');
    expect(btn).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute('aria-pressed', 'true'));
    expect(btn).toHaveTextContent('3');
    expect(api.voteRoadmapItem).toHaveBeenLastCalledWith('a', 'u1');
  });

  it('keeps the vote when the server reports it already exists', async () => {
    api.fetchRoadmapItems.mockResolvedValue([item({ id: 'a', title: 'Dark mode', votes_count: 5 })]);
    api.voteRoadmapItem.mockRejectedValueOnce({ code: '23505' });
    render(<FeedbackPage />);
    const btn = await screen.findByRole('button', { name: /vote for dark mode/i });
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute('aria-pressed', 'true'));
    expect(btn).toHaveTextContent('5');
    expect(toast).not.toHaveBeenCalled();
  });

  it('validates and submits a new idea', async () => {
    api.fetchRoadmapItems.mockResolvedValue([item({ id: 'a', title: 'Dark mode' })]);
    api.submitRoadmapItem.mockResolvedValue(item({ id: 'n', title: 'Sync calendars', submitted_by: 'u1' }));
    render(<FeedbackPage />);
    await screen.findByText('Dark mode');
    fireEvent.click(screen.getByRole('button', { name: /submit an idea/i }));
    fireEvent.click(screen.getByRole('button', { name: /^submit idea$/i }));
    expect(await screen.findByText(/short title/i)).toBeInTheDocument();
    expect(api.submitRoadmapItem).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Sync calendars' } });
    fireEvent.click(screen.getByRole('button', { name: /^submit idea$/i }));
    expect(await screen.findByText('Your idea')).toBeInTheDocument();
    expect(api.submitRoadmapItem).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sync calendars', userId: 'u1' }));
  });

  it('filters by search and offers to clear when nothing matches', async () => {
    api.fetchRoadmapItems.mockResolvedValue([item({ id: 'a', title: 'Dark mode' })]);
    render(<FeedbackPage />);
    await screen.findByText('Dark mode');
    fireEvent.change(screen.getByLabelText('Search ideas'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No ideas match your filters')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(await screen.findByText('Dark mode')).toBeInTheDocument();
  });
});
