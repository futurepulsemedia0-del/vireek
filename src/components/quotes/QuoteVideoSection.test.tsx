import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchPublicQuoteVideos: vi.fn(),
  fetchLiveStatus: vi.fn(),
  acknowledgeVideo: vi.fn(),
  joinLiveEstimate: vi.fn(),
  trackVideoEvent: vi.fn(),
}));
vi.mock('@/lib/quoteVideoApi', () => api);

import { QuoteVideoSection } from '@/components/quotes/QuoteVideoSection';

const video = {
  id: '5b4d0c20-3e6f-4081-8cbd-2e3f4a5b6c7d',
  title: 'What I found in your furnace',
  note: 'Short summary',
  mime_type: 'video/mp4',
  duration_seconds: 75,
  max_progress: 0,
  completed: false,
  acknowledged: false,
  url: 'https://example.test/signed.mp4',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchLiveStatus.mockResolvedValue(false);
});

describe('QuoteVideoSection', () => {
  it('renders nothing when there is no video and no live session', async () => {
    api.fetchPublicQuoteVideos.mockResolvedValue({ videos: [], live: false, quoteStatus: 'sent' });
    const { container } = render(<QuoteVideoSection token="t" quoteOpen />);
    await waitFor(() => expect(api.fetchPublicQuoteVideos).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing (and never throws) when loading fails', async () => {
    api.fetchPublicQuoteVideos.mockResolvedValue(null);
    const { container } = render(<QuoteVideoSection token="t" quoteOpen />);
    await waitFor(() => expect(api.fetchPublicQuoteVideos).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the video and hides the confirmation until it has been watched', async () => {
    api.fetchPublicQuoteVideos.mockResolvedValue({ videos: [video], live: false, quoteStatus: 'sent' });
    render(<QuoteVideoSection token="t" quoteOpen />);
    expect(await screen.findByText(video.title)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /i watched this/i })).not.toBeInTheDocument();
  });

  it('lets a customer who watched it confirm with their name', async () => {
    api.fetchPublicQuoteVideos.mockResolvedValue({ videos: [{ ...video, completed: true, max_progress: 100 }], live: false, quoteStatus: 'sent' });
    api.acknowledgeVideo.mockResolvedValue({ max_progress: 100, completed: true, acknowledged: true });
    render(<QuoteVideoSection token="tok" customerName="Jane Doe" quoteOpen />);

    fireEvent.click(await screen.findByRole('button', { name: /i watched this explanation/i }));
    expect(api.acknowledgeVideo).toHaveBeenCalledWith('tok', video.id, 'Jane Doe');
    expect(await screen.findByText(/your confirmation was sent/i)).toBeInTheDocument();
  });

  it('does not offer the confirmation once the quote is answered', async () => {
    api.fetchPublicQuoteVideos.mockResolvedValue({ videos: [{ ...video, completed: true, max_progress: 100 }], live: false, quoteStatus: 'accepted' });
    render(<QuoteVideoSection token="t" customerName="Jane" quoteOpen={false} />);
    await screen.findByText(video.title);
    expect(screen.queryByRole('button', { name: /i watched this/i })).not.toBeInTheDocument();
  });

  it('offers Join while a live estimate is open and shows the call after joining', async () => {
    api.fetchPublicQuoteVideos.mockResolvedValue({ videos: [], live: true, quoteStatus: 'sent' });
    api.joinLiveEstimate.mockResolvedValue('https://acme.daily.co/vq-abc?t=tok');
    render(<QuoteVideoSection token="tok" customerName="Jane" quoteOpen />);

    fireEvent.click(await screen.findByRole('button', { name: /join video estimate/i }));
    expect(api.joinLiveEstimate).toHaveBeenCalledWith('tok', 'Jane');
    const frame = await screen.findByTitle('Live video estimate');
    expect(frame).toHaveAttribute('src', 'https://acme.daily.co/vq-abc?t=tok');
    expect(frame.getAttribute('allow')).toMatch(/camera/);
  });

  it('shows a friendly message when joining fails', async () => {
    api.fetchPublicQuoteVideos.mockResolvedValue({ videos: [], live: true, quoteStatus: 'sent' });
    api.joinLiveEstimate.mockRejectedValue(new Error('The live session has ended.'));
    render(<QuoteVideoSection token="t" quoteOpen />);

    fireEvent.click(await screen.findByRole('button', { name: /join video estimate/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The live session has ended.');
  });
});
