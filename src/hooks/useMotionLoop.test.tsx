import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { MotionPauseButton } from '@/components/ui/MotionPauseButton';
import { usePrefersReducedMotion } from '@/lib/usePrefersReducedMotion';
import { useMotionLoop } from './useMotionLoop';

const root = document.documentElement;
beforeEach(async () => {
  root.className = '';
  if (!i18n.isInitialized) await i18n.init({ lng: 'en', resources: { en: { translation: { motion: { pause: 'Pause moving content', play: 'Play moving content' } } } } });
  else i18n.addResourceBundle('en', 'translation', { motion: { pause: 'Pause moving content', play: 'Play moving content' } }, true, true);
});
afterEach(() => vi.restoreAllMocks());

describe('usePrefersReducedMotion (OS + Accessibility Center)', () => {
  it('turns true when the Accessibility Center class is added', async () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    await act(async () => { root.classList.add('a11y-reduce-motion'); await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current).toBe(true);
    await act(async () => { root.classList.remove('a11y-reduce-motion'); await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current).toBe(false);
  });
});

describe('useMotionLoop', () => {
  it('runs by default, stops when paused, resumes on toggle', () => {
    const { result } = renderHook(() => useMotionLoop());
    expect(result.current.running).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.running).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.running).toBe(true);
  });
  it('never runs when motion is reduced', () => {
    root.classList.add('a11y-stop-animations');
    const { result } = renderHook(() => useMotionLoop());
    expect(result.current.running).toBe(false);
    expect(result.current.reduced).toBe(true);
  });
  it('stops while the tab is hidden', () => {
    const { result } = renderHook(() => useMotionLoop());
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current.running).toBe(false);
  });
});

describe('MotionPauseButton', () => {
  it('toggles its accessible name', () => {
    const Harness = () => { const loop = useMotionLoop(); return <MotionPauseButton loop={loop} />; };
    render(<I18nextProvider i18n={i18n}><Harness /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Pause moving content' }));
    expect(screen.getByRole('button', { name: 'Play moving content' })).toBeInTheDocument();
  });
  it('renders nothing when motion is reduced', () => {
    root.classList.add('a11y-reduce-motion');
    const Harness = () => { const loop = useMotionLoop(); return <MotionPauseButton loop={loop} />; };
    const { container } = render(<I18nextProvider i18n={i18n}><Harness /></I18nextProvider>);
    expect(container).toBeEmptyDOMElement();
  });
});
