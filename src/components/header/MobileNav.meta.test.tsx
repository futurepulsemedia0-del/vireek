import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { reactI18nextMock } from '@/test/i18nMock';
import { MobileNav } from '@/components/header/MobileNav';
import { NAV_ITEMS } from '@/lib/headerNav';
import { SARAH_PHONE } from '@/lib/site';

vi.mock('react-i18next', () => reactI18nextMock);
// Plain-element framer-motion stand-in: no animation timers, panels unmount instantly.
vi.mock('framer-motion', async () => {
  const React = await import('react');
  const strip = ({ initial, animate, exit, transition, layoutId, ...rest }: Record<string, unknown>) => {
    void initial; void animate; void exit; void transition; void layoutId;
    return rest;
  };
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        React.forwardRef((props: Record<string, unknown>, ref) => React.createElement(tag, { ...strip(props), ref })),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    useReducedMotion: () => true,
  };
});

const sarah = NAV_ITEMS.find((i) => i.id === 'sarah')!;
const smsLink = sarah.panel!.groups[0].links.find((l) => l.href === '/features/sms-text-back')!;

const renderNav = (path = '/', onNavigate: () => void = () => {}) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <MobileNav onNavigate={onNavigate} />
    </MemoryRouter>,
  );

describe('MobileNav icons and descriptions', () => {
  it('shows an icon on every top-level row', () => {
    renderNav();
    for (const item of NAV_ITEMS) {
      const row = screen.getByRole(item.panel ? 'button' : 'link', { name: item.labelKey });
      expect(row.querySelector('svg'), item.id).not.toBeNull();
    }
  });

  it('shows icon and description on panel links while the accessible name stays the label', () => {
    renderNav();
    fireEvent.click(screen.getByRole('button', { name: 'nav.features' }));
    const link = screen.getByRole('link', { name: smsLink.label });
    expect(link.querySelector('svg')).not.toBeNull();
    const describedBy = link.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(smsLink.description!);
  });

  it('keeps compact groups dense: icon, no description', () => {
    renderNav();
    fireEvent.click(screen.getByRole('button', { name: 'nav.industries' }));
    const link = screen.getByRole('link', { name: 'HVAC' });
    expect(link.querySelector('svg')).not.toBeNull();
    expect(link).not.toHaveAttribute('aria-describedby');
  });

  it('ends each panel with an overview link and the featured card', () => {
    const onNavigate = vi.fn();
    renderNav('/', onNavigate);
    fireEvent.click(screen.getByRole('button', { name: 'nav.features' }));
    expect(screen.getByRole('link', { name: sarah.panel!.overview.label })).toHaveAttribute('href', sarah.panel!.overview.href);
    const featured = screen.getByRole('link', { name: new RegExp(sarah.panel!.featured!.cta.label) });
    expect(featured).toHaveAttribute('href', SARAH_PHONE);
    fireEvent.click(featured);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('marks only the current page link with aria-current', () => {
    renderNav('/features/sms-text-back');
    expect(screen.getByRole('link', { name: smsLink.label })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Lead Qualification' })).not.toHaveAttribute('aria-current');
  });
});
