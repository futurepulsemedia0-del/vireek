import { describe, it, expect } from 'vitest';
import { WIDGET_IDS, buildPresetLayout, setWidgetHidden, type OverviewLayout } from '@/lib/overviewLayout';
import {
  ROLE_KEYS,
  WIDGET_DESCRIPTIONS,
  buildRoleMaps,
  copyLayout,
  isRoleDirty,
  isRoleKey,
  permissionNote,
  resolveBaseLayout,
  validateRoleLayout,
  visibleWidgetCount,
} from './dashboardRoleLayouts';

const hideAll = (layout: OverviewLayout) => WIDGET_IDS.reduce((l, id) => setWidgetHidden(l, id, true), layout);

describe('role keys', () => {
  it('are exactly the built-in presets, in order', () => {
    expect([...ROLE_KEYS]).toEqual(['owner', 'dispatcher', 'csr', 'technician']);
  });

  it('accepts roles and nothing else', () => {
    expect(isRoleKey('csr')).toBe(true);
    expect(isRoleKey('custom')).toBe(false);
    expect(isRoleKey('admin')).toBe(false);
    expect(isRoleKey(42)).toBe(false);
    expect(isRoleKey(null)).toBe(false);
  });
});

describe('widget copy', () => {
  it('describes every widget', () => {
    for (const id of WIDGET_IDS) expect(WIDGET_DESCRIPTIONS[id].length).toBeGreaterThan(0);
  });

  it('notes the permission a widget needs, and nothing for open widgets', () => {
    expect(permissionNote('kpi_revenue')).toContain('View billing');
    expect(permissionNote('since_yesterday')).toBeNull();
  });
});

describe('resolveBaseLayout', () => {
  it('uses the built-in preset when the account saved nothing', () => {
    expect(resolveBaseLayout(null, 'csr')).toEqual(buildPresetLayout('csr'));
    expect(resolveBaseLayout(undefined, 'csr')).toEqual(buildPresetLayout('csr'));
  });

  it('uses the account layout when there is one', () => {
    const saved = setWidgetHidden(buildPresetLayout('technician'), 'kpi_jobs', true);
    const base = resolveBaseLayout(saved, 'technician');
    expect(base.preset).toBe('custom');
    expect(base.items.find((i) => i.id === 'kpi_jobs')?.hidden).toBe(true);
  });

  it('falls back to the preset for unreadable data', () => {
    expect(resolveBaseLayout('nope', 'dispatcher')).toEqual(buildPresetLayout('dispatcher'));
    expect(resolveBaseLayout({ version: 99, items: [] }, 'dispatcher')).toEqual(buildPresetLayout('dispatcher'));
  });

  it('appends widgets shipped after the layout was saved', () => {
    const raw = { version: 1, preset: 'custom', items: [{ id: 'kpi_calls', w: 6, h: 0, hidden: false }] };
    const base = resolveBaseLayout(raw, 'owner');
    expect(base.items).toHaveLength(WIDGET_IDS.length);
    expect(base.items[0].id).toBe('kpi_calls');
  });
});

describe('validateRoleLayout', () => {
  it('accepts a layout that shows something', () => {
    expect(validateRoleLayout(buildPresetLayout('owner'))).toBeNull();
  });

  it('rejects a layout with every widget hidden', () => {
    const empty = hideAll(buildPresetLayout('owner'));
    expect(visibleWidgetCount(empty)).toBe(0);
    expect(validateRoleLayout(empty)).toMatch(/at least one widget/i);
  });
});

describe('copyLayout', () => {
  it('copies independently and marks the copy as custom', () => {
    const source = buildPresetLayout('technician');
    const copy = copyLayout(source);
    expect(copy.preset).toBe('custom');
    expect(copy.items).toEqual(source.items);
    expect(copy.items[0]).not.toBe(source.items[0]);
  });
});

describe('buildRoleMaps', () => {
  it('marks only roles with a saved row as saved, and drafts start at what is published', () => {
    const dispatcher = setWidgetHidden(buildPresetLayout('dispatcher'), 'quick_actions', true);
    const { saved, drafts } = buildRoleMaps([{ roleKey: 'dispatcher', layout: dispatcher }]);
    expect(saved.dispatcher).not.toBeNull();
    expect(saved.owner).toBeNull();
    expect(saved.csr).toBeNull();
    expect(saved.technician).toBeNull();
    expect(drafts.dispatcher).toBe(saved.dispatcher);
    expect(drafts.owner).toEqual(buildPresetLayout('owner'));
  });

  it('does not start any role as dirty', () => {
    const { saved, drafts } = buildRoleMaps([{ roleKey: 'csr', layout: setWidgetHidden(buildPresetLayout('csr'), 'kpi_calls', true) }]);
    for (const role of ROLE_KEYS) expect(isRoleDirty(drafts[role], saved[role], role)).toBe(false);
  });
});

describe('isRoleDirty', () => {
  it('is false for an untouched default and true after an edit', () => {
    const draft = buildPresetLayout('owner');
    expect(isRoleDirty(draft, null, 'owner')).toBe(false);
    expect(isRoleDirty(setWidgetHidden(draft, 'attribution', true), null, 'owner')).toBe(true);
  });

  it('compares against the saved layout when there is one', () => {
    const saved = setWidgetHidden(buildPresetLayout('owner'), 'attribution', true);
    expect(isRoleDirty(saved, saved, 'owner')).toBe(false);
    expect(isRoleDirty(buildPresetLayout('owner'), saved, 'owner')).toBe(true);
  });
});
