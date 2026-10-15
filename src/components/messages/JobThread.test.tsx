import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const fetchMessages = vi.fn();
const sendText = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn().mockResolvedValue({ data: 'owner-1', error: null }),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
  },
}));
vi.mock('@/lib/realtime', () => ({ useRealtimeSubscription: () => 'live' }));
vi.mock('@/lib/jobMessages', async (orig) => ({
  ...(await orig<typeof import('@/lib/jobMessages')>()),
  fetchMessages: (...a: unknown[]) => fetchMessages(...a),
  markThreadRead: vi.fn().mockResolvedValue(undefined),
  getSignedUrls: vi.fn().mockResolvedValue({}),
  sendTextMessage: (...a: unknown[]) => sendText(...a),
}));

import { JobThread } from './JobThread';

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollTo = vi.fn();
});

describe('JobThread', () => {
  it('shows the empty state for a new thread', async () => {
    fetchMessages.mockResolvedValue({ messages: [], hasMore: false });
    render(<JobThread jobId="job-1" viewer="technician" />);
    expect(await screen.findByText('Start the conversation')).toBeInTheDocument();
  });

  it('shows an error state with retry when loading fails', async () => {
    fetchMessages.mockRejectedValueOnce(new Error('boom'));
    render(<JobThread jobId="job-1" viewer="technician" />);
    expect(await screen.findByText("Couldn't load messages")).toBeInTheDocument();
    fetchMessages.mockResolvedValue({ messages: [], hasMore: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Start the conversation')).toBeInTheDocument();
  });

  it('renders messages and sends a text optimistically, then confirms', async () => {
    fetchMessages.mockResolvedValue({
      messages: [{ id: 'm1', job_id: 'job-1', sender_user_id: 'x', sender_role: 'office', kind: 'text', body: 'Parts are on the way',
        media_path: null, media_mime: null, media_duration_ms: null, client_id: null, created_at: new Date().toISOString() }],
      hasMore: false,
    });
    sendText.mockImplementation(async (_job: string, body: string, clientId: string) => ({
      id: 'm2', job_id: 'job-1', sender_user_id: 'user-1', sender_role: 'technician', kind: 'text', body,
      media_path: null, media_mime: null, media_duration_ms: null, client_id: clientId, created_at: new Date().toISOString(),
    }));
    render(<JobThread jobId="job-1" viewer="technician" />);
    expect(await screen.findByText('Parts are on the way')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Arrived on site' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Arrived on site')).toBeInTheDocument();
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText('Arrived on site')).toHaveLength(1);
  });

  it('marks a failed send and retries it', async () => {
    fetchMessages.mockResolvedValue({ messages: [], hasMore: false });
    sendText.mockRejectedValueOnce(new Error('offline'));
    render(<JobThread jobId="job-1" viewer="technician" />);
    await screen.findByText('Start the conversation');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Need a part' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    const retry = await screen.findByRole('button', { name: /Not sent/ });
    sendText.mockImplementation(async (_j: string, body: string, clientId: string) => ({
      id: 'm9', job_id: 'job-1', sender_user_id: 'user-1', sender_role: 'technician', kind: 'text', body,
      media_path: null, media_mime: null, media_duration_ms: null, client_id: clientId, created_at: new Date().toISOString(),
    }));
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Not sent/ })).not.toBeInTheDocument());
    expect(sendText).toHaveBeenCalledTimes(2);
  });
});
