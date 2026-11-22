import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LoaderInsetProvider, LoaderStage } from './LoaderStage';

afterEach(cleanup);

describe('LoaderStage', () => {
  it('outside the dashboard it covers the whole viewport and respects the safe areas', () => {
    const { container } = render(<LoaderStage>x</LoaderStage>);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveAttribute('data-loader-stage', 'viewport');
    expect(el).toHaveClass('fixed', 'inset-0', 'flex', 'items-center', 'justify-center', 'z-20');
    expect(el.className).toContain('env(safe-area-inset-top');
    expect(el.className).toContain('env(safe-area-inset-bottom');
  });

  it('inside the dashboard chrome it leaves the header, sidebar and bottom nav uncovered', () => {
    const { container } = render(
      <LoaderInsetProvider>
        <LoaderStage>x</LoaderStage>
      </LoaderInsetProvider>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveAttribute('data-loader-stage', 'shell');
    expect(el).not.toHaveClass('inset-0');
    expect(el).toHaveClass('inset-x-0', 'lg:left-60', 'lg:top-0');
    expect(el.className).toContain('top-[calc(3.5rem+1px)]');
    expect(el.className).toContain('var(--vk-bottom-nav-h,0px)');
    expect(el.className).toContain('var(--vk-bottom-bar-h,0px)');
  });

  it('stays below the chrome (z-20 < sidebar z-30 / header z-40) and forwards role/aria props', () => {
    const { getByRole } = render(
      <LoaderStage role="status" aria-busy="true">
        x
      </LoaderStage>,
    );
    const el = getByRole('status');
    expect(el).toHaveAttribute('aria-busy', 'true');
    expect(el).toHaveClass('z-20');
  });
});
