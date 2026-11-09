import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, o?: Record<string, unknown> & { defaultValue?: string }) =>
      (o?.defaultValue ?? _k).replace(/\{\{(\w+)\}\}/g, (_m, n: string) => String(o?.[n] ?? '')),
  }),
}));

vi.mock('@/components/EmptyState', () => ({
  EmptyState: (p: { title: string; description?: string; action?: { label: string; onClick: () => void }; secondaryAction?: { label: string; onClick: () => void } }) => (
    <div>
      <h2>{p.title}</h2>
      <p>{p.description}</p>
      {p.action && <button onClick={p.action.onClick}>{p.action.label}</button>}
      {p.secondaryAction && <button onClick={p.secondaryAction.onClick}>{p.secondaryAction.label}</button>}
    </div>
  ),
}));

const ent = vi.hoisted(() => ({ value: {} as Record<string, unknown>, refresh: vi.fn() }));
vi.mock('@/hooks/useEntitlement', () => ({ useEntitlement: () => ent.value, refreshEntitlements: ent.refresh }));
const flags = vi.hoisted(() => ({ value: { ready: true, isEnabled: () => true } as { ready: boolean; isEnabled: (k: string) => boolean } }));
vi.mock('@/hooks/useFeatureFlag', () => ({ useFeatureFlags: () => flags.value }));

import { ModuleGate } from './ModuleGate';

const base = { allowed: false, status: 'ready', state: 'off', source: null, expiresAt: null, daysLeft: null, expired: false };

const renderGate = (props: { module?: string; flag?: string } = {}) =>
  render(
    <MemoryRouter initialEntries={['/dashboard/pay']}>
      <Routes>
        <Route path="/dashboard/pay" element={<ModuleGate module={props.module ?? 'pay'} flag={props.flag}><div>SECRET MODULE UI</div></ModuleGate>} />
        <Route path="/dashboard" element={<div>DASHBOARD HOME</div>} />
        <Route path="/dashboard/support" element={<div>SUPPORT PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  flags.value = { ready: true, isEnabled: () => true };
});

describe('ModuleGate', () => {
  it('renders the module when entitled', () => {
    ent.value = { ...base, allowed: true, state: 'on' };
    renderGate();
    expect(screen.getByText('SECRET MODULE UI')).toBeTruthy();
  });

  it('shows a busy status (and never the module) while loading', () => {
    ent.value = { ...base, status: 'loading' };
    renderGate();
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('SECRET MODULE UI')).toBeNull();
  });

  it('shows the not-available state, in place, when not entitled', () => {
    ent.value = { ...base };
    renderGate();
    expect(screen.getByTestId('module-not-available')).toBeTruthy();
    expect(screen.getByText('Pay is not available on your account')).toBeTruthy();
    expect(screen.queryByText('SECRET MODULE UI')).toBeNull();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, nofollow');
  });

  it('says "expired" for an expired grant', () => {
    ent.value = { ...base, expired: true };
    renderGate({ module: 'ai' });
    expect(screen.getByText('AI has expired on your account')).toBeTruthy();
  });

  it('offers a way out: support and back to the dashboard', () => {
    ent.value = { ...base };
    renderGate();
    fireEvent.click(screen.getByText('Back to dashboard'));
    expect(screen.getByText('DASHBOARD HOME')).toBeTruthy();
    cleanup();
    renderGate();
    fireEvent.click(screen.getByText('Contact support'));
    expect(screen.getByText('SUPPORT PAGE')).toBeTruthy();
  });

  it('shows an error with a working retry (and never the module) when the check failed', () => {
    ent.value = { ...base, status: 'error' };
    renderGate();
    expect(screen.queryByText('SECRET MODULE UI')).toBeNull();
    fireEvent.click(screen.getByText('Try again'));
    expect(ent.refresh).toHaveBeenCalledTimes(1);
  });

  it('also requires the platform flag when one is given', () => {
    ent.value = { ...base, allowed: true, state: 'on' };
    flags.value = { ready: true, isEnabled: () => false };
    renderGate({ flag: 'module_pay' });
    expect(screen.getByTestId('module-not-available')).toBeTruthy();
    expect(screen.queryByText('SECRET MODULE UI')).toBeNull();
  });

  it('waits for flags before revealing a flagged module', () => {
    ent.value = { ...base, allowed: true, state: 'on' };
    flags.value = { ready: false, isEnabled: () => false };
    renderGate({ flag: 'module_pay' });
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByText('SECRET MODULE UI')).toBeNull();
  });
});
