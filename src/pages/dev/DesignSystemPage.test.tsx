import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { reactI18nextMock } from '@/test/i18nMock';
import DesignSystemPage, { RADIUS_ROLE_TABLE, RADIUS_SCALE } from './DesignSystemPage';
import { RADIUS_PX, RADIUS_ROLES } from '../../../scripts/design/radius-tokens.mjs';

vi.mock('react-i18next', () => reactI18nextMock);

afterEach(cleanup);

describe('/dev/design-system', () => {
  it('mirrors scripts/design/radius-tokens.mjs (no drift)', () => {
    for (const s of RADIUS_SCALE) expect(s.px).toBe(s.name === 'full' ? 'full' : (RADIUS_PX as Record<string, number>)[s.name]);
    for (const r of RADIUS_ROLE_TABLE) {
      if (r.alias === 'full') continue;
      expect((RADIUS_ROLES as Record<string, string>)[r.alias]).toBeDefined();
    }
    expect(Object.keys(RADIUS_ROLES).sort()).toEqual(RADIUS_ROLE_TABLE.filter((r) => r.alias !== 'full').map((r) => r.alias).sort());
  });

  it('scale on the page is strictly increasing', () => {
    const px = RADIUS_SCALE.filter((s) => s.px !== 'full').map((s) => s.px as number);
    for (let i = 1; i < px.length; i++) expect(px[i]).toBeGreaterThan(px[i - 1]);
  });

  it('renders every role with its real class and has no axe violations', async () => {
    const { container } = render(<DesignSystemPage />);
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    for (const r of RADIUS_ROLE_TABLE) expect(screen.getAllByText(r.className).length).toBeGreaterThan(0);
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } }); // jsdom has no layout/colour
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});
