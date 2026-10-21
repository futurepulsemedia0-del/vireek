import { describe, expect, it } from 'vitest';
import { PRESET_IDS, WIDGETS, buildPresetLayout, sanitizeLayout, visibleItems } from './overviewLayout';

describe('kpi_renewal_rate widget', () => {
  it('is registered, billing-gated and visible by default for owners only', () => {
    expect(WIDGETS.kpi_renewal_rate).toMatchObject({ id: 'kpi_renewal_rate', permission: 'can_view_billing' });
    const owner = buildPresetLayout('owner').items.find((i) => i.id === 'kpi_renewal_rate');
    expect(owner?.hidden).toBe(false);
    for (const p of PRESET_IDS.filter((p) => p !== 'owner')) {
      expect(buildPresetLayout(p).items.find((i) => i.id === 'kpi_renewal_rate')?.hidden).toBe(true);
    }
  });

  it('team members without billing access never see it', () => {
    const layout = buildPresetLayout('owner');
    const can = (p: string) => p !== 'can_view_billing';
    expect(visibleItems(layout, can as never).some((i) => i.id === 'kpi_renewal_rate')).toBe(false);
  });

  it('shows up for owners who saved a layout before the widget existed', () => {
    const old = buildPresetLayout('owner');
    const saved = { ...old, items: old.items.filter((i) => i.id !== 'kpi_renewal_rate') };
    const out = sanitizeLayout(saved, 'owner');
    expect(out.items.find((i) => i.id === 'kpi_renewal_rate')?.hidden).toBe(false);
  });
});
