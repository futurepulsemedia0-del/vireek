import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThankYouContent } from './ThankYouContent';
import { trackEvent } from '@/lib/analytics';
import { SARAH_PHONE } from '@/lib/site';

vi.mock('@/lib/analytics', () => ({
  trackEvent: vi.fn(),
  hasAnalyticsConsent: vi.fn(() => true),
  onAnalyticsConsent: vi.fn(() => () => {}),
}));

function renderContent(props: { source: 'signup' | 'demo' | null; demoStart?: Date | null }) {
  return render(
    <MemoryRouter>
      <ThankYouContent source={props.source} demoStart={props.demoStart ?? null} />
    </MemoryRouter>,
  );
}

const trackedNames = () => vi.mocked(trackEvent).mock.calls.map((c) => c[0]);

describe('ThankYouContent', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.mocked(trackEvent).mockClear();
  });

  it('shows the signup confirmation, next steps, and a working call link', () => {
    renderContent({ source: 'signup' });
    expect(screen.getByRole('heading', { level: 1, name: /got your details/i })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('link', { name: /call sarah now/i })).toHaveAttribute('href', SARAH_PHONE);
    expect(trackedNames()).toEqual(['sign_up', 'generate_lead']);
  });

  it('reports the conversion only once per session', () => {
    const first = renderContent({ source: 'signup' });
    first.unmount();
    renderContent({ source: 'signup' });
    expect(trackedNames()).toEqual(['sign_up', 'generate_lead']);
  });

  it('shows the booked time and an add-to-calendar button for a demo', () => {
    renderContent({ source: 'demo', demoStart: new Date(Date.now() + 2 * 86_400_000) });
    expect(screen.getByRole('heading', { level: 1, name: /you.re booked/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add to calendar/i })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(trackedNames()).toEqual(['demo_booked', 'generate_lead']);
  });

  it('drops the calendar step when the demo time is unknown', () => {
    renderContent({ source: 'demo', demoStart: null });
    expect(screen.queryByRole('button', { name: /add to calendar/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders a neutral page and reports nothing when the source is missing', () => {
    renderContent({ source: null });
    expect(screen.getByRole('heading', { level: 1, name: /thank you/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to home/i })).toHaveAttribute('href', '/');
    expect(trackEvent).not.toHaveBeenCalled();
  });
});
