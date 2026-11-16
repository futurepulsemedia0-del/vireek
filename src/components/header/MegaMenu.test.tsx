import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { reactI18nextMock } from '@/test/i18nMock';
import { DesktopMegaNav } from '@/components/header/MegaMenu';
import { MobileNav } from '@/components/header/MobileNav';

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

// The i18n mock returns the key itself, so labels are 'nav.features', 'nav.pricing', …
const renderNav = () =>
  render(
    <MemoryRouter>
      <DesktopMegaNav />
    </MemoryRouter>,
  );

describe('DesktopMegaNav', () => {
  it('renders collapsed triggers and a plain Pricing link', () => {
    renderNav();
    expect(screen.getByRole('button', { name: 'nav.features' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('link', { name: 'nav.pricing' })).toHaveAttribute('href', '/pricing');
    expect(screen.queryByRole('group', { name: 'nav.features' })).not.toBeInTheDocument();
  });

  it('opens on click, shows real links, and closes on a second click', () => {
    renderNav();
    const trigger = screen.getByRole('button', { name: 'nav.features' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'nav.features' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Lead Qualification/ })).toHaveAttribute('href', '/features/lead-qualification');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('shows only one panel at a time and renders every industry', () => {
    renderNav();
    fireEvent.click(screen.getByRole('button', { name: 'nav.features' }));
    fireEvent.click(screen.getByRole('button', { name: 'nav.industries' }));
    expect(screen.queryByRole('group', { name: 'nav.features' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'nav.industries' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'HVAC' })).toHaveAttribute('href', '/industries/hvac');
  });

  it('Escape closes the panel and returns focus to its trigger', () => {
    renderNav();
    const trigger = screen.getByRole('button', { name: 'nav.features' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('link', { name: /Lead Qualification/ }), { key: 'Escape' });
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('ArrowDown opens the panel and moves focus to its first link', () => {
    renderNav();
    fireEvent.keyDown(screen.getByRole('button', { name: 'nav.features' }), { key: 'ArrowDown' });
    expect(screen.getByRole('link', { name: /Lead Qualification/ })).toHaveFocus();
  });

  it('ArrowRight / ArrowLeft move focus between top-level items', () => {
    renderNav();
    const first = screen.getByRole('button', { name: 'nav.features' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: 'nav.platform' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: 'nav.platform' }), { key: 'ArrowLeft' });
    expect(first).toHaveFocus();
  });

  it('closes on a press outside the menu', () => {
    renderNav();
    fireEvent.click(screen.getByRole('button', { name: 'nav.features' }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });
});

describe('MobileNav', () => {
  it('expands a section accordion-style and reports navigation', () => {
    const onNavigate = vi.fn();
    render(
      <MemoryRouter>
        <MobileNav onNavigate={onNavigate} />
      </MemoryRouter>,
    );
    const row = screen.getByRole('button', { name: 'nav.features' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('link', { name: 'SMS Text-Back' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands the section that contains the current route', () => {
    render(
      <MemoryRouter initialEntries={['/industries/hvac']}>
        <MobileNav onNavigate={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'nav.industries' })).toHaveAttribute('aria-expanded', 'true');
  });
});
