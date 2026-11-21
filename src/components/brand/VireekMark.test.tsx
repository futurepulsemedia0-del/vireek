import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { VireekMark } from './VireekMark';

function stubMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: reduce && q.includes('reduce'),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  stubMotion(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<VireekMark />', () => {
  it('exposes role=img and the accessible name "Vireek"', () => {
    const { getByRole } = render(<VireekMark />);
    expect(getByRole('img', { name: 'Vireek' }).tagName.toLowerCase()).toBe('svg');
  });

  it('is hidden from assistive tech when decorative', () => {
    const { container, queryByRole } = render(<VireekMark decorative />);
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(queryByRole('img')).toBeNull();
  });

  it('sets width and height so it cannot shift layout', () => {
    const svg = render(<VireekMark size={130} />).container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('130');
    expect(svg.getAttribute('height')).toBe(String(Math.round((130 * 240) / 260)));
    expect(svg.getAttribute('viewBox')).toBe('0 0 260 240');
  });

  it('renders the settled network when animation is off', () => {
    const svg = render(<VireekMark animated={false} size={96} />).container.querySelector('svg')!;
    expect(svg.hasAttribute('data-still')).toBe(true);
    expect(svg.querySelectorAll('.vk-spoke')).toHaveLength(4);
    expect(svg.querySelector('.vk-main')!.getAttribute('d')).toContain('C120 198 120 198 120 198');
  });

  it('falls back to the plain V (no network, no motion) under 32px', () => {
    const svg = render(<VireekMark size={24} />).container.querySelector('svg')!;
    expect(svg.hasAttribute('data-still')).toBe(true);
    expect(svg.querySelectorAll('.vk-link')).toHaveLength(0);
    expect(svg.querySelector('.vk-main')!.getAttribute('d')).toContain('C120 196 120 196 120 196');
  });

  it('respects prefers-reduced-motion', () => {
    stubMotion(true);
    const svg = render(<VireekMark size={160} interactive />).container.querySelector('svg')!;
    expect(svg.hasAttribute('data-still')).toBe(true);
    expect(svg.hasAttribute('data-interactive')).toBe(false);
    expect(svg.getAttribute('role')).toBe('img');
  });

  it('animated mode hides the line until the intro draws it, and cleans up on unmount', () => {
    const { container, unmount } = render(<VireekMark size={160} />);
    const svg = container.querySelector('svg')!;
    expect(svg.hasAttribute('data-still')).toBe(false);
    expect((svg.querySelector('.vk-main') as SVGPathElement).style.strokeDashoffset).toBe('1');
    expect(() => unmount()).not.toThrow();
  });

  it('intro="once" skips the intro after it was seen this session', () => {
    window.sessionStorage.setItem('vireek:mark-intro-seen', '1');
    const { container } = render(<VireekMark size={160} intro="once" />);
    const main = container.querySelector('.vk-main') as SVGPathElement;
    expect(main.style.strokeDashoffset).toBe('');
  });

  it('interactive mark is a keyboard-operable button', () => {
    const { getByRole } = render(<VireekMark size={160} interactive />);
    const btn = getByRole('button', { name: /Vireek/ });
    expect(btn.getAttribute('tabindex')).toBe('0');
    expect(() => fireEvent.keyDown(btn, { key: 'Enter' })).not.toThrow();
  });

  it('engine: intro completes, the network blooms, the loop sleeps and the session flag is written', () => {
    const cbs: FrameRequestCallback[] = [];
    let t = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => cbs.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    const { container } = render(<VireekMark size={160} intro="once" />);
    for (let i = 0; i < 400 && cbs.length; i++) {
      t += 16;
      cbs.shift()!(t);
    }
    const svg = container.querySelector('svg')!;
    const main = svg.querySelector('.vk-main') as SVGPathElement;
    expect(main.style.strokeDasharray).toBe('none');
    expect(svg.querySelector('g')!.hasAttribute('display')).toBe(false);
    const scale = Number(/scale\(([\d.]+)\)/.exec(svg.querySelector('g')!.getAttribute('transform') ?? '')?.[1]);
    expect(scale).toBeGreaterThan(0.99);
    expect(scale).toBeLessThan(1.01);
    expect(window.sessionStorage.getItem('vireek:mark-intro-seen')).toBe('1');
    expect(cbs.length).toBe(0); // settled → no more frames scheduled
    vi.restoreAllMocks();
  });
});
