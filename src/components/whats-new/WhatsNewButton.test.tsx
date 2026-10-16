import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WhatsNewButton } from './WhatsNewButton';

const ctx = vi.hoisted(() => ({ unreadCount: 0 }));
vi.mock('@/contexts/WhatsNewContext', () => ({ useWhatsNew: () => ({ unreadCount: ctx.unreadCount }) }));

function renderButton() {
  return render(
    <MemoryRouter>
      <WhatsNewButton />
    </MemoryRouter>,
  );
}

describe('WhatsNewButton', () => {
  beforeEach(() => {
    ctx.unreadCount = 0;
  });

  it('links to the feed and shows no badge when everything is read', () => {
    renderButton();
    expect(screen.getByRole('link', { name: /what.s new$/i })).toHaveAttribute('href', '/dashboard/whats-new');
    expect(screen.queryByTestId('whats-new-badge')).not.toBeInTheDocument();
  });

  it('shows the unread count in the badge and the accessible name', () => {
    ctx.unreadCount = 3;
    renderButton();
    expect(screen.getByTestId('whats-new-badge')).toHaveTextContent('3');
    expect(screen.getByRole('link', { name: /3 unread/i })).toBeInTheDocument();
  });

  it('caps large counts at 9+', () => {
    ctx.unreadCount = 12;
    renderButton();
    expect(screen.getByTestId('whats-new-badge')).toHaveTextContent('9+');
  });
});
