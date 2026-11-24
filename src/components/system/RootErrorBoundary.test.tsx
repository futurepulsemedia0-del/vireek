import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RootErrorBoundary } from './RootErrorBoundary';

vi.mock('@/lib/incidentReporting', () => ({ captureIncident: vi.fn(() => ({ eventId: null })) }));

function Boom(): never {
  throw new Error('provider exploded');
}

describe('RootErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    document.documentElement.className = '';
  });

  it('renders children untouched when nothing throws', () => {
    render(
      <RootErrorBoundary>
        <p>app</p>
      </RootErrorBoundary>,
    );
    expect(screen.getByText('app')).toBeInTheDocument();
  });

  it('shows a self-contained recovery screen with Reload and a reference when a child throws', () => {
    render(
      <RootErrorBoundary>
        <Boom />
      </RootErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByText(/provider exploded/)).toBeInTheDocument();
  });

  it('removes the static boot loader so it cannot cover the recovery screen', () => {
    const boot = document.createElement('div');
    boot.id = 'vrk-boot';
    document.body.appendChild(boot);
    render(
      <RootErrorBoundary>
        <Boom />
      </RootErrorBoundary>,
    );
    expect(document.getElementById('vrk-boot')).toBeNull();
  });

  it('uses the dark palette on the native app (vrk-native) so there is no white flash', () => {
    document.documentElement.classList.add('vrk-native');
    render(
      <RootErrorBoundary>
        <Boom />
      </RootErrorBoundary>,
    );
    expect(screen.getByRole('alert').style.background).toMatch(/rgb\(20, 20, 19\)|#141413/i);
  });
});
