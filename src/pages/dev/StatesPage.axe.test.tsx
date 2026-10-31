import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import { reactI18nextMock } from '@/test/i18nMock';

vi.mock('react-i18next', () => reactI18nextMock);
vi.mock('@/lib/native/haptics', () => ({ haptic: vi.fn() }));

import { ToastProvider } from '@/contexts/ToastContext';
import StatesPage from './StatesPage';

afterEach(cleanup);

describe('/dev/states accessibility (axe-core, jsdom)', () => {
  it('has no axe violations (color-contrast is checked in Playwright, jsdom cannot compute it)', async () => {
    const { container } = render(
      <ToastProvider>
        <StatesPage />
      </ToastProvider>,
    );
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    });
    const summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
    expect(summary).toEqual([]);
  });
});
