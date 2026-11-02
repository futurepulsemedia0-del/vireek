import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string; name?: string }) => (o?.defaultValue ?? _k).replace('{{name}}', o?.name ?? '') }),
}));
const dir = vi.hoisted(() => ({ isRtl: false }));
vi.mock('@/hooks/useDirection', () => ({ useDirection: () => ({ dir: dir.isRtl ? 'rtl' : 'ltr', isRtl: dir.isRtl }) }));

import { ResizableTh } from './ResizableTh';

const setup = (width = 200) => {
  const onResize = vi.fn();
  render(
    <table>
      <thead>
        <tr>
          <ResizableTh width={width} label="Contact" onResize={onResize}>
            Contact
          </ResizableTh>
        </tr>
      </thead>
    </table>,
  );
  return { onResize, handle: screen.getByRole('separator', { name: 'Resize column Contact' }) };
};

afterEach(() => {
  cleanup();
  dir.isRtl = false;
});

describe('ResizableTh keyboard resizing', () => {
  it('exposes value range and current width', () => {
    const { handle } = setup(200);
    expect(handle).toHaveAttribute('aria-valuemin', '48');
    expect(handle).toHaveAttribute('aria-valuemax', '800');
    expect(handle).toHaveAttribute('aria-valuenow', '200');
  });
  it('ArrowRight grows by 16, Shift+ArrowLeft shrinks by 64, Home resets', () => {
    const { handle, onResize } = setup(200);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(216);
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith(136);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(onResize).toHaveBeenLastCalledWith(160);
  });
  it('clamps to the allowed range', () => {
    const { handle, onResize } = setup(50);
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith(48);
  });
  it('mirrors the arrows in RTL', () => {
    dir.isRtl = true;
    const { handle, onResize } = setup(200);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(216);
  });
});
