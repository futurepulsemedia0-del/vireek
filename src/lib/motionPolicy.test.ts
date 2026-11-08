import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cssSource from '../styles/motion.css?raw';
import {
  ALLOWED_REDUCED_ANIMATIONS,
  CLASS_REDUCE,
  CLASS_STOP,
  MOTION_DECISION_TABLE,
  installMotionRuntime,
  readMotionMode,
  scrollBehavior,
  syncMotionAttribute,
} from './motionPolicy';

const root = document.documentElement;
const mm = (matches: boolean) => ({ matchMedia: () => ({ matches }) as MediaQueryList });

beforeEach(() => {
  root.className = '';
  root.removeAttribute('data-motion');
  root.removeAttribute('data-tab-hidden');
});
afterEach(() => vi.unstubAllGlobals());

describe('readMotionMode — either source triggers the same behaviour', () => {
  it('full when nothing asks for reduced motion', () => expect(readMotionMode(document, mm(false))).toBe('full'));
  it('reduce from the OS alone', () => expect(readMotionMode(document, mm(true))).toBe('reduce'));
  it('reduce from the Accessibility Center alone', () => {
    root.classList.add(CLASS_REDUCE);
    expect(readMotionMode(document, mm(false))).toBe('reduce');
  });
  it('stop beats reduce', () => {
    root.classList.add(CLASS_REDUCE, CLASS_STOP);
    expect(readMotionMode(document, mm(true))).toBe('stop');
  });
  it('no matchMedia (jsdom/SSR) => full', () => expect(readMotionMode(document, undefined)).toBe('full'));
  it('throwing matchMedia is treated as no preference', () => {
    expect(readMotionMode(document, { matchMedia: () => { throw new Error('x'); } })).toBe('full');
  });
});

describe('syncMotionAttribute / runtime', () => {
  it('writes data-motion', () => {
    expect(syncMotionAttribute(document, mm(true))).toBe('reduce');
    expect(root.getAttribute('data-motion')).toBe('reduce');
  });
  it('follows class changes and tab visibility; cleanup detaches', async () => {
    const off = installMotionRuntime(document);
    expect(root.getAttribute('data-motion')).toBe('full');
    root.classList.add(CLASS_STOP);
    await new Promise((r) => setTimeout(r, 0));
    expect(root.getAttribute('data-motion')).toBe('stop');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(root.hasAttribute('data-tab-hidden')).toBe(true);
    off();
    root.classList.remove(CLASS_STOP);
    await new Promise((r) => setTimeout(r, 0));
    expect(root.getAttribute('data-motion')).toBe('stop'); // no longer synced
  });
});

describe('scrollBehavior', () => {
  it('smooth by default, auto when reduced', () => {
    expect(scrollBehavior()).toBe('smooth');
    root.classList.add(CLASS_REDUCE);
    expect(scrollBehavior()).toBe('auto');
  });
});

describe('decision table', () => {
  it('has unique ids and every row defines both behaviours', () => {
    const ids = MOTION_DECISION_TABLE.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of MOTION_DECISION_TABLE) {
      expect(r.reduce.length).toBeGreaterThan(0);
      expect(r.stop.length).toBeGreaterThan(0);
    }
  });
  it('every essential row keeps a visible cue (never "removed")', () => {
    for (const r of MOTION_DECISION_TABLE.filter((x) => x.category === 'essential')) expect(r.reduce).not.toMatch(/removed|none/i);
  });
});

describe('motion.css contract', () => {
  it('is driven only by data-motion (no class duplication of the rules)', () => {
    expect(cssSource).toContain("[data-motion='reduce']");
    expect(cssSource).not.toMatch(/\.a11y-reduce-motion/);
  });
  it('does not use a blanket `animation: none` outside stop mode', () => {
    const blanket = cssSource.match(/html:is\([^)]*\) \*[^{]*\{[^}]*animation:\s*none/g);
    expect(blanket).toBeNull();
  });
  it('defines every allowed reduced animation that it owns', () => {
    expect(cssSource).toContain('@keyframes vk-essential-fade');
    expect(ALLOWED_REDUCED_ANIMATIONS).toContain('vk-essential-fade');
  });
  it('spinners get a non-rotating alternative', () => {
    expect(cssSource).toMatch(/\.animate-spin[^{]*\{\s*animation:\s*vk-essential-fade/);
  });
  it('contains no hex or rgb() colour literals (design tokens only)', () => {
    expect(cssSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
