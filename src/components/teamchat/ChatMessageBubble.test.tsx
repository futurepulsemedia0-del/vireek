import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatMessageBubble } from '@/components/teamchat/ChatMessageBubble';
import type { ChatMessage } from '@/lib/teamChat';

afterEach(cleanup);

const base: ChatMessage = {
  id: 'm1', channel_id: 'c1', sender_id: 'me', kind: 'text', body: 'On my way', attachment_path: null, attachment_mime: null,
  attachment_bytes: null, voice_duration_ms: null, client_id: 'cid', edited_at: null, deleted_at: null, created_at: new Date().toISOString(),
};

const props = (over: Partial<Parameters<typeof ChatMessageBubble>[0]> = {}) => ({
  message: base, own: true, senderName: 'Me', showSender: true, endsGroup: true, mediaUrl: null,
  receipt: { state: 'sent' as const, readBy: [] }, isDirect: false, names: new Map<string, string>(),
  onOpenImage: vi.fn(), onRetry: vi.fn(), onDiscard: vi.fn(), onEdit: vi.fn(async () => null), onDelete: vi.fn(), ...over,
});

describe('ChatMessageBubble', () => {
  it('renders text with an accessible read receipt', () => {
    render(<ChatMessageBubble {...props({ receipt: { state: 'read', readBy: ['u2'] }, names: new Map([['u2', 'Tom']]) })} />);
    expect(screen.getByText('On my way')).toBeInTheDocument();
    expect(screen.getByText('Read by Tom')).toBeInTheDocument();
  });

  it('shows the sender name for others but not for own messages', () => {
    const { rerender } = render(<ChatMessageBubble {...props({ own: false, senderName: 'Tom', receipt: null })} />);
    expect(screen.getByText('Tom')).toBeInTheDocument();
    rerender(<ChatMessageBubble {...props({ own: true, senderName: 'Tom' })} />);
    expect(screen.queryByText('Tom')).not.toBeInTheDocument();
  });

  it('offers retry/discard for a failed message', () => {
    const p = props({ message: { ...base, status: 'failed' }, receipt: { state: 'failed', readBy: [] } });
    render(<ChatMessageBubble {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(p.onRetry).toHaveBeenCalledWith('cid');
    expect(p.onDiscard).toHaveBeenCalledWith('cid');
  });

  it('shows a tombstone for deleted messages and hides actions', () => {
    render(<ChatMessageBubble {...props({ message: { ...base, body: null, deleted_at: new Date().toISOString() } })} />);
    expect(screen.getByText('This message was deleted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /message actions/i })).not.toBeInTheDocument();
  });

  it('opens the photo viewer and falls back when the image fails', () => {
    const p = props({ message: { ...base, kind: 'image', body: null, attachment_path: 'a/b/c.jpg' }, mediaUrl: 'https://s/x.jpg' });
    render(<ChatMessageBubble {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /open photo/i }));
    expect(p.onOpenImage).toHaveBeenCalledWith('https://s/x.jpg');
    fireEvent.error(screen.getByAltText('Shared photo'));
    expect(screen.getByText('Photo unavailable')).toBeInTheDocument();
  });

  it('lets the sender edit then saves through onEdit', async () => {
    const p = props();
    render(<ChatMessageBubble {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /message actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /edit/i }));
    fireEvent.change(screen.getByLabelText('Edit message'), { target: { value: 'Running late' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(p.onEdit).toHaveBeenCalledWith('m1', 'Running late');
  });
});
