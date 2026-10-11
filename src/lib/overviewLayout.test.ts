import { describe, it, expect } from 'vitest';
import {
  GRID_COLUMNS,
  MAX_ROW_UNITS,
  PRESET_IDS,
  WIDGETS,
  WIDGET_IDS,
  buildPresetLayout,
  hiddenItems,
  moveWidget,
  moveWidgetBy,
  resizeWidget,
  resolveRolePreset,
  sanitizeLayout,
  setWidgetHidden,
  visibleItems,
} from './overviewLayout';

const allowAll = () => true;
const ids = (l: { items: { id: string }[] }) => l.items.map((i) => i.id);

describe('presets', () => {
  it.each(PRESET_IDS)('%s contains every widget exactly once with valid sizes', (preset) => {
    const layout = buildPresetLayout(preset);
    expect([...ids(layout)].sort()).toEqual([...WIDGET_IDS].sort());
    for (const item of layout.items) {
      expect(item.w).toBeGreaterThanOrEqual(WIDGETS[item.id].minW);
      expect(item.w).toBeLessThanOrEqual(GRID_COLUMNS);
    }
    expect(layout.preset).toBe(preset);
  });

  it('technician hides financial widgets by default; owner shows them', () => {
    const hidden = (p: 'owner' | 'technician') =>
      buildPresetLayout(p).items.filter((i) => i.hidden).map((i) => i.id);
    expect(hidden('technician')).toEqual(expect.arrayContaining(['kpi_revenue', 'revenue_recovered']));
    expect(hidden('owner')).toEqual([]);
  });
});

describe('resolveRolePreset', () => {
  it('maps roles to presets', () => {
    expect(resolveRolePreset({ isOwner: true })).toBe('owner');
    expect(resolveRolePreset({ isOwner: false, teamRole: 'admin' })).toBe('owner');
    expect(resolveRolePreset({ isOwner: false, teamRole: 'technician' })).toBe('technician');
    expect(resolveRolePreset({ isOwner: false, teamRole: 'member', dispatchEnabled: true })).toBe('dispatcher');
    expect(resolveRolePreset({ isOwner: false, teamRole: 'member', dispatchEnabled: false })).toBe('csr');
    expect(resolveRolePreset({ isOwner: false })).toBe('csr');
  });
});

describe('sanitizeLayout', () => {
  it('falls back to the preset for garbage input', () => {
    for (const raw of [null, undefined, 'x', 42, [], {}, { version: 2, items: [] }, { version: 1, items: 'no' }, { version: 1, items: [] }]) {
      expect(sanitizeLayout(raw, 'dispatcher')).toEqual(buildPresetLayout('dispatcher'));
    }
  });

  it('drops unknown and duplicate widgets, clamps sizes, appends widgets added later', () => {
    const out = sanitizeLayout(
      {
        version: 1,
        preset: 'custom',
        items: [
          { id: 'kpi_calls', w: 99, h: 99, hidden: false },
          { id: 'kpi_calls', w: 3, h: 0, hidden: true },
          { id: 'not_a_widget', w: 3, h: 0, hidden: false },
          { id: 'call_volume', w: 1, h: -4, hidden: true },
          { id: 'needs_attention', w: 'x', h: 'y' },
        ],
      },
      'owner',
    );
    expect(out.items[0]).toEqual({ id: 'kpi_calls', w: GRID_COLUMNS, h: MAX_ROW_UNITS, hidden: false });
    expect(out.items[1]).toEqual({ id: 'call_volume', w: WIDGETS.call_volume.minW, h: 0, hidden: true });
    expect(out.items[2]).toMatchObject({ id: 'needs_attention', w: 6, h: 0, hidden: false });
    expect(new Set(ids(out)).size).toBe(out.items.length);
    expect([...ids(out)].sort()).toEqual([...WIDGET_IDS].sort());
  });

  it('keeps an unknown preset name as custom', () => {
    const base = buildPresetLayout('owner');
    expect(sanitizeLayout({ ...base, preset: 'hacker' }, 'owner').preset).toBe('custom');
  });
});

describe('editing operations', () => {
  const base = buildPresetLayout('owner');

  it('moveWidget reorders and marks the layout custom', () => {
    const out = moveWidget(base, 'recent_activity', 'since_yesterday');
    expect(out.items[0].id).toBe('recent_activity');
    expect(out.preset).toBe('custom');
    expect(ids(out).length).toBe(ids(base).length);
  });

  it('moveWidget is a no-op for same or unknown ids', () => {
    expect(moveWidget(base, 'kpi_calls', 'kpi_calls')).toBe(base);
    expect(moveWidget(base, 'kpi_calls', 'nope' as never)).toBe(base);
  });

  it('moveWidgetBy skips hidden widgets and stops at the edges', () => {
    const hid = setWidgetHidden(base, 'revenue_recovered', true);
    const moved = moveWidgetBy(hid, 'since_yesterday', 1, allowAll);
    expect(ids(moved).indexOf('since_yesterday')).toBeGreaterThan(ids(moved).indexOf('kpi_calls'));
    expect(moveWidgetBy(base, 'since_yesterday', -1, allowAll)).toBe(base);
  });

  it('resizeWidget clamps and returns the same object when nothing changes', () => {
    const out = resizeWidget(base, 'kpi_calls', { w: 1, h: 50 });
    const item = out.items.find((i) => i.id === 'kpi_calls')!;
    expect(item.w).toBe(WIDGETS.kpi_calls.minW);
    expect(item.h).toBe(MAX_ROW_UNITS);
    expect(resizeWidget(base, 'kpi_calls', { w: 3 })).toBe(base);
    expect(resizeWidget(out, 'kpi_calls', { h: 0 }).items.find((i) => i.id === 'kpi_calls')!.h).toBe(0);
  });

  it('hide and show round-trip; a re-shown widget goes last', () => {
    const hid = setWidgetHidden(base, 'kpi_calls', true);
    expect(hid.items.find((i) => i.id === 'kpi_calls')!.hidden).toBe(true);
    const shown = setWidgetHidden(hid, 'kpi_calls', false);
    expect(shown.items[shown.items.length - 1].id).toBe('kpi_calls');
    expect(setWidgetHidden(base, 'kpi_calls', false)).toBe(base);
  });
});

describe('permission filtering', () => {
  it('hides widgets that need can_view_billing without that permission', () => {
    const layout = buildPresetLayout('owner');
    const can = (p: string) => p !== 'can_view_billing';
    const visible = visibleItems(layout, can as never).map((i) => i.id);
    expect(visible).not.toContain('kpi_revenue');
    expect(visible).not.toContain('revenue_recovered');
    expect(visible).toContain('kpi_calls');
    const hid = setWidgetHidden(layout, 'kpi_revenue', true);
    expect(hiddenItems(hid, can as never).map((i) => i.id)).not.toContain('kpi_revenue');
  });
});
