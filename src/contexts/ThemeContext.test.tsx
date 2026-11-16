import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';

function mockSystemDark(dark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: dark && q.includes('dark'),
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
const wrapper = ({ children }: { children: ReactNode }) => <ThemeProvider>{children}</ThemeProvider>;

describe('ThemeProvider defaults', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    mockSystemDark(true);
  });

  it('first visit with dark OS → light, nothing persisted', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.preference).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('vireek-theme')).toBeNull();
  });

  it('legacy auto-saved "system" (no marker) → light', () => {
    localStorage.setItem('vireek-theme', 'system');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.preference).toBe('light');
  });

  it('legacy explicit "dark" is preserved', () => {
    localStorage.setItem('vireek-theme', 'dark');
    renderHook(() => useTheme(), { wrapper });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('explicit system choice persists with marker', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setThemePreference('system'));
    expect(localStorage.getItem('vireek-theme')).toBe('system');
    expect(localStorage.getItem('vireek-theme-explicit')).toBe('1');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
