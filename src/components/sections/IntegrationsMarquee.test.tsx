import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationsMarquee, MARQUEE_ITEMS } from '@/components/sections/IntegrationsMarquee';
import { INTEGRATION_EVIDENCE } from '@/components/sections/integrationsMarquee.evidence';

function setReducedMotion(reduced: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

function renderSection() {
  return render(
    <MemoryRouter>
      <IntegrationsMarquee />
    </MemoryRouter>,
  );
}

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  vi.unstubAllGlobals();
});

describe('IntegrationsMarquee (animated)', () => {
  it('is a labelled region with the honest heading and trademark footnote', () => {
    renderSection();
    expect(
      screen.getByRole('region', { name: /works with the tools you already use/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/logos are trademarks of their respective owners/i)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/trusted by|our partners|official partner/i);
  });

  it('exposes exactly one real list per row; the full list has every integration once', () => {
    renderSection();
    const lists = screen.getAllByRole('list');
    expect(lists.map((l) => l.getAttribute('aria-label'))).toEqual([
      'Supported integrations',
      'Field service, CRM and accounting integrations',
      'Calendar, messaging and payments integrations',
    ]);
    const full = screen.getByRole('list', { name: 'Supported integrations' });
    const names = within(full)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(names).toEqual(MARQUEE_ITEMS.map((i) => i.name));
  });

  it('hides the duplicated track from AT and removes its links from the tab order', () => {
    const { container } = renderSection();
    const hiddenLinks = container.querySelectorAll('[aria-hidden="true"] a');
    expect(hiddenLinks.length).toBeGreaterThan(0);
    hiddenLinks.forEach((a) => expect(a).toHaveAttribute('tabindex', '-1'));
  });

  it('forces LTR so the translate loop stays seamless on RTL pages (fa/ar)', () => {
    const { container } = renderSection();
    container.querySelectorAll('.logo-marquee').forEach((r) => expect(r).toHaveAttribute('dir', 'ltr'));
  });

  it('pause/play control toggles every marquee (WCAG 2.2.2)', () => {
    const { container } = renderSection();
    const roots = container.querySelectorAll('.logo-marquee');
    roots.forEach((r) => expect(r).toHaveAttribute('data-paused', 'false'));
    fireEvent.click(screen.getByRole('button', { name: /pause logo scroll/i }));
    roots.forEach((r) => expect(r).toHaveAttribute('data-paused', 'true'));
    expect(screen.getByRole('button', { name: /play logo scroll/i })).toBeInTheDocument();
  });

  describe('entrance + off-screen stop', () => {
    const callbacks: IntersectionObserverCallback[] = [];
    beforeEach(() => {
      callbacks.length = 0;
      class FakeIO {
        constructor(cb: IntersectionObserverCallback) {
          callbacks.push(cb);
        }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
        takeRecords = () => [];
        root = null;
        rootMargin = '';
        thresholds = [];
      }
      vi.stubGlobal('IntersectionObserver', FakeIO);
    });

    it('starts hidden, enters once, and stops animating when scrolled away', () => {
      const { container } = renderSection();
      const roots = Array.from(container.querySelectorAll('.logo-marquee'));
      roots.forEach((r) => expect(r).toHaveAttribute('data-entered', 'false'));

      const fire = (isIntersecting: boolean) =>
        act(() =>
          callbacks.forEach((cb) =>
            cb([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver),
          ),
        );

      fire(true);
      roots.forEach((r) => {
        expect(r).toHaveAttribute('data-entered', 'true');
        expect(r).toHaveAttribute('data-visible', 'true');
      });
      fire(false);
      roots.forEach((r) => {
        expect(r).toHaveAttribute('data-entered', 'true'); // entrance is one-shot
        expect(r).toHaveAttribute('data-visible', 'false'); // CSS pauses the track
      });
    });
  });
});

describe('IntegrationsMarquee (prefers-reduced-motion)', () => {
  it('renders a static wrapped list: no track, no duplicates, no pause button', () => {
    setReducedMotion(true);
    const { container } = renderSection();
    expect(container.querySelector('.logo-marquee__track')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"] a')).toBeNull();
    expect(screen.queryByRole('button', { name: /logo scroll/i })).toBeNull();
    const list = screen.getByRole('list', { name: 'Supported integrations' });
    expect(within(list).getAllByRole('link')).toHaveLength(MARQUEE_ITEMS.length);
  });
});

describe('integration evidence (truthfulness guard)', () => {
  it('every marquee brand has evidence and every evidence file exists', () => {
    expect(Object.keys(INTEGRATION_EVIDENCE).sort()).toEqual(MARQUEE_ITEMS.map((i) => i.id).sort());
    for (const [id, files] of Object.entries(INTEGRATION_EVIDENCE)) {
      expect(files.length, `${id} needs evidence`).toBeGreaterThan(0);
      for (const f of files) {
        expect(existsSync(join(process.cwd(), f)), `${id}: missing ${f}`).toBe(true);
      }
    }
  });
});
