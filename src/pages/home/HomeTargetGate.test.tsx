import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/native/platform', () => ({ isNative: () => native.value }));

import { HomeTargetGate } from './HomeTargetGate';

function renderRoot() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomeTargetGate><p>landing</p></HomeTargetGate>} />
        <Route path="/dashboard" element={<p>dashboard</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockStandalone() {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: q.includes('standalone'),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  native.value = false;
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('HomeTargetGate', () => {
  it('shows the marketing landing page in a normal browser', () => {
    renderRoot();
    expect(screen.getByText('landing')).toBeInTheDocument();
  });

  it('skips the landing page in an installed PWA', () => {
    mockStandalone();
    renderRoot();
    expect(screen.getByText('dashboard')).toBeInTheDocument();
    expect(screen.queryByText('landing')).toBeNull();
  });

  it('skips the landing page inside the native app', () => {
    native.value = true;
    renderRoot();
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });
});
