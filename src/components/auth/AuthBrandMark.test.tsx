import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AuthBrandMark } from './AuthBrandMark';

const mq = vi.hoisted(() => ({ desktop: false }));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => mq.desktop }));

afterEach(cleanup);
const count = (c: HTMLElement) => c.querySelectorAll('svg').length;

describe('AuthBrandMark', () => {
  it('mobile: renders the form placement only', () => {
    mq.desktop = false;
    expect(count(render(<AuthBrandMark placement="form" />).container)).toBe(1);
    cleanup();
    expect(count(render(<AuthBrandMark placement="panel" />).container)).toBe(0);
  });

  it('desktop: renders the panel placement only', () => {
    mq.desktop = true;
    expect(count(render(<AuthBrandMark placement="panel" />).container)).toBe(1);
    cleanup();
    expect(count(render(<AuthBrandMark placement="form" />).container)).toBe(0);
  });

  it('still motion renders the settled mark; animated does not', () => {
    mq.desktop = false;
    const still = render(<AuthBrandMark placement="form" motion="still" />).container.querySelector('svg')!;
    expect(still.hasAttribute('data-still')).toBe(true);
    cleanup();
    const anim = render(<AuthBrandMark placement="form" motion="animated" />).container.querySelector('svg')!;
    expect(anim.hasAttribute('data-still')).toBe(false);
  });
});
