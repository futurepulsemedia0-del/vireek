import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CommentRow } from '@/lib/comments';
import { mentionToken } from '@/lib/comments';

const ME = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';

const api = vi.hoisted(() => ({
  fetchComments: vi.fn(),
  postComment: vi.fn(),
  editComment: vi.fn(),
  setThreadResolved: vi.fn(),
  deleteComment: vi.fn(),
  fetchMentionCandidates: vi.fn(),
}));
vi.mock('@/lib/commentsApi', () => api);
vi.mock('@/lib/realtime', () => ({ useRealtimeSubscription: () => 'live' }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: ME }, isOwner: false, permissions: { can_view_all_jobs: false } }),
}));
const toast = vi.fn();
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));

import { CommentsPanel } from '@/components/comments/CommentsPanel';

function row(over: Partial<CommentRow>): CommentRow {
  return {
    id: 'c1',
    user_id: 'owner',
    entity_type: 'job',
    entity_id: JOB,
    parent_id: null,
    author_id: BOB,
    author_name: 'Bob Stone',
    body: 'First',
    mentions: [],
    resolved_at: null,
    resolved_by: null,
    resolved_by_name: null,
    edited_at: null,
    deleted_at: null,
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-01T10:00:00Z',
    ...over,
  };
}

const candidates = [
  { userId: BOB, name: 'Bob Stone', role: 'technician' },
  { userId: ME, name: 'Me Myself', role: 'member' },
];

function renderPanel(url = '/') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <CommentsPanel entityType="job" entityId={JOB} entityLabel="Smith HVAC" />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchMentionCandidates.mockResolvedValue(candidates);
  api.fetchComments.mockResolvedValue([]);
});

describe('CommentsPanel', () => {
  it('shows the empty state, then posts a comment with a mention token', async () => {
    api.postComment.mockImplementation(async ({ body }: { body: string }) =>
      row({ id: 'new', author_id: ME, author_name: 'Me Myself', body, mentions: [BOB] }),
    );
    renderPanel();
    expect(await screen.findByText('No comments yet')).toBeInTheDocument();
    await waitFor(() => expect(api.fetchMentionCandidates).toHaveBeenCalled());

    const box = screen.getByRole('combobox', { name: 'New comment' });
    fireEvent.change(box, { target: { value: 'hey @bo', selectionStart: 7 } });
    Object.defineProperty(box, 'selectionStart', { value: 7, configurable: true });
    fireEvent.keyUp(box);
    const option = await screen.findByRole('option', { name: /Bob Stone/ });
    fireEvent.click(option);
    fireEvent.click(screen.getByRole('button', { name: /^comment$/i }));

    await waitFor(() => expect(api.postComment).toHaveBeenCalledTimes(1));
    expect(api.postComment.mock.calls[0][0]).toMatchObject({
      type: 'job',
      entityId: JOB,
      parentId: null,
      body: `hey ${mentionToken({ userId: BOB, name: 'Bob Stone' })}`.trim(),
    });
    expect(await screen.findByText('@Bob Stone')).toBeInTheDocument();
  });

  it('disables posting for an empty draft', async () => {
    renderPanel();
    await screen.findByText('No comments yet');
    expect(screen.getByRole('button', { name: /^comment$/i })).toBeDisabled();
  });

  it('shows an error with retry when loading fails', async () => {
    api.fetchComments.mockRejectedValueOnce(new Error('x'));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load comments.');
    api.fetchComments.mockResolvedValueOnce([row({})]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('First')).toBeInTheDocument();
  });

  it('resolves a thread optimistically and collapses it', async () => {
    api.fetchComments.mockResolvedValue([row({})]);
    api.setThreadResolved.mockResolvedValue(row({ resolved_at: '2026-10-02T10:00:00Z', resolved_by_name: 'Me Myself' }));
    renderPanel();
    await screen.findByText('First');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(api.setThreadResolved).toHaveBeenCalledWith('c1', true));
    expect(await screen.findByText(/Resolved by Me Myself/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show thread/i })).toBeInTheDocument();
  });

  it('rolls back and toasts when resolving fails', async () => {
    api.fetchComments.mockResolvedValue([row({})]);
    api.setThreadResolved.mockRejectedValue(new Error('nope'));
    renderPanel();
    await screen.findByText('First');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/could not resolve/i), 'error'));
    expect(screen.queryByText(/Resolved by/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
  });

  it('replies inside a thread', async () => {
    api.fetchComments.mockResolvedValue([row({})]);
    api.postComment.mockResolvedValue(row({ id: 'r1', parent_id: 'c1', author_id: ME, author_name: 'Me Myself', body: 'On it', created_at: '2026-10-01T11:00:00Z' }));
    renderPanel();
    await screen.findByText('First');
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Reply' }), { target: { value: 'On it' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Reply' }).pop()!);
    await waitFor(() => expect(api.postComment).toHaveBeenCalledWith({ type: 'job', entityId: JOB, body: 'On it', parentId: 'c1' }));
    expect(await screen.findByText('On it')).toBeInTheDocument();
  });

  it('only offers edit/delete on my own comments when I am not a manager', async () => {
    api.fetchComments.mockResolvedValue([
      row({ id: 'a', author_id: BOB, body: 'theirs' }),
      row({ id: 'b', author_id: ME, author_name: 'Me Myself', body: 'mine', created_at: '2026-10-01T11:00:00Z' }),
    ]);
    renderPanel();
    await screen.findByText('mine');
    const mine = screen.getByText('mine').closest('article')!;
    const theirs = screen.getByText('theirs').closest('article')!;
    expect(within(mine).getByRole('button', { name: 'Delete comment' })).toBeInTheDocument();
    expect(within(mine).getByRole('button', { name: 'Edit comment' })).toBeInTheDocument();
    expect(within(theirs).queryByRole('button', { name: 'Delete comment' })).not.toBeInTheDocument();
  });

  it('confirms before deleting and shows a tombstone', async () => {
    api.fetchComments.mockResolvedValue([row({ id: 'b', author_id: ME, author_name: 'Me Myself', body: 'mine' }), row({ id: 'r', parent_id: 'b', body: 'reply', created_at: '2026-10-01T11:00:00Z' })]);
    api.deleteComment.mockResolvedValue(row({ id: 'b', author_id: ME, deleted_at: '2026-10-03T00:00:00Z', body: '', updated_at: '2026-10-03T00:00:00Z' }));
    renderPanel();
    await screen.findByText('mine');
    fireEvent.click(screen.getByRole('button', { name: 'Delete comment' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteComment).toHaveBeenCalledWith('b'));
    expect(await screen.findByText('This comment was deleted.')).toBeInTheDocument();
    expect(screen.getByText('reply')).toBeInTheDocument();
  });

  it('expands a resolved thread that a notification deep-links to', async () => {
    api.fetchComments.mockResolvedValue([row({ id: 'z', resolved_at: '2026-10-02T10:00:00Z', resolved_by_name: 'Bob Stone', body: 'deep' })]);
    renderPanel('/?comment=z');
    expect(await screen.findByRole('article', { name: /Bob Stone/ })).toBeInTheDocument();
    expect(screen.getByText('deep')).toBeInTheDocument();
  });
});
