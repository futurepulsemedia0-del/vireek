/**
 * Customizable Overview — pure layout model.
 *
 * No React, no Supabase: everything here is deterministic and unit-tested.
 * The layout is an ORDERED list of widgets (array order = display order) on a
 * 12-column grid. Each item has a column span `w`, an optional fixed height in
 * row units `h` (0 = auto height) and a `hidden` flag.
 *
 * Stored per user in `overview_layouts`; role presets live here in code, so
 * widgets shipped later reach users who never customized, and reset-to-default
 * is simply "delete my row".
 */
import type { UserPermissions } from '@/contexts/AuthContext';

export const GRID_COLUMNS = 12;
export const ROW_UNIT_PX = 80;
export const MAX_ROW_UNITS = 12;
export const LAYOUT_SCHEMA_VERSION = 1;

export const WIDGET_IDS = [
  'since_yesterday',
  'revenue_recovered',
  'kpi_calls',
  'kpi_emergency',
  'kpi_jobs',
  'kpi_revenue',
  'metric_minutes',
  'metric_sentiment',
  'metric_conversion',
  'metric_missed',
  'call_volume',
  'needs_attention',
  'attribution',
  'ai_insights',
  'quick_actions',
  'recent_activity',
] as const;

export type OverviewWidgetId = (typeof WIDGET_IDS)[number];
export type OverviewPresetId = 'owner' | 'dispatcher' | 'csr' | 'technician';
export type OverviewPreset = OverviewPresetId | 'custom';
export type PermissionKey = keyof UserPermissions;

export interface WidgetDef {
  id: OverviewWidgetId;
  title: string;
  minW: number;
  /** Hidden for team members lacking this permission (never stored). */
  permission?: PermissionKey;
}

export interface LayoutItem {
  id: OverviewWidgetId;
  w: number;
  h: number;
  hidden: boolean;
}

export interface OverviewLayout {
  version: typeof LAYOUT_SCHEMA_VERSION;
  preset: OverviewPreset;
  items: LayoutItem[];
}

export const WIDGETS: Record<OverviewWidgetId, WidgetDef> = {
  since_yesterday: { id: 'since_yesterday', title: 'Since yesterday', minW: 4 },
  revenue_recovered: { id: 'revenue_recovered', title: 'Revenue recovered', minW: 4, permission: 'can_view_billing' },
  kpi_calls: { id: 'kpi_calls', title: 'Calls this month', minW: 3 },
  kpi_emergency: { id: 'kpi_emergency', title: 'Emergency calls', minW: 3 },
  kpi_jobs: { id: 'kpi_jobs', title: 'Jobs completed', minW: 3 },
  kpi_revenue: { id: 'kpi_revenue', title: 'Revenue this month', minW: 3, permission: 'can_view_billing' },
  metric_minutes: { id: 'metric_minutes', title: 'Minutes used', minW: 3 },
  metric_sentiment: { id: 'metric_sentiment', title: 'Response sentiment', minW: 3 },
  metric_conversion: { id: 'metric_conversion', title: 'Conversion rate', minW: 3 },
  metric_missed: { id: 'metric_missed', title: 'Missed call rate', minW: 3 },
  call_volume: { id: 'call_volume', title: 'Call volume', minW: 4 },
  needs_attention: { id: 'needs_attention', title: 'Needs attention', minW: 4 },
  attribution: { id: 'attribution', title: 'Lead source attribution', minW: 4 },
  ai_insights: { id: 'ai_insights', title: 'AI insights', minW: 4 },
  quick_actions: { id: 'quick_actions', title: 'Quick actions', minW: 4 },
  recent_activity: { id: 'recent_activity', title: 'Recent activity', minW: 4 },
};

export const PRESET_LABELS: Record<OverviewPreset, string> = {
  owner: 'Owner',
  dispatcher: 'Dispatcher',
  csr: 'Customer service (CSR)',
  technician: 'Technician',
  custom: 'Custom',
};

export const PRESET_IDS: OverviewPresetId[] = ['owner', 'dispatcher', 'csr', 'technician'];

type PresetEntry = readonly [OverviewWidgetId, number];

/** Visible widgets in display order. Everything else starts hidden. */
const PRESET_ENTRIES: Record<OverviewPresetId, readonly PresetEntry[]> = {
  owner: [
    ['since_yesterday', 12], ['revenue_recovered', 12],
    ['kpi_calls', 3], ['kpi_emergency', 3], ['kpi_jobs', 3], ['kpi_revenue', 3],
    ['metric_minutes', 3], ['metric_sentiment', 3], ['metric_conversion', 3], ['metric_missed', 3],
    ['call_volume', 6], ['needs_attention', 6],
    ['attribution', 12], ['ai_insights', 12], ['quick_actions', 12], ['recent_activity', 12],
  ],
  dispatcher: [
    ['kpi_emergency', 3], ['kpi_jobs', 3], ['kpi_calls', 3], ['metric_missed', 3],
    ['needs_attention', 6], ['recent_activity', 6],
    ['since_yesterday', 12], ['call_volume', 12], ['quick_actions', 12],
  ],
  csr: [
    ['kpi_calls', 3], ['kpi_emergency', 3], ['metric_missed', 3], ['metric_sentiment', 3],
    ['recent_activity', 6], ['needs_attention', 6],
    ['metric_conversion', 4], ['call_volume', 8], ['quick_actions', 12],
  ],
  technician: [
    ['kpi_jobs', 4], ['kpi_emergency', 4], ['kpi_calls', 4],
    ['needs_attention', 6], ['recent_activity', 6],
    ['quick_actions', 12],
  ],
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function buildPresetLayout(preset: OverviewPresetId): OverviewLayout {
  const visible = PRESET_ENTRIES[preset];
  const seen = new Set<OverviewWidgetId>(visible.map(([id]) => id));
  const items: LayoutItem[] = visible.map(([id, w]) => ({ id, w, h: 0, hidden: false }));
  for (const id of WIDGET_IDS) {
    if (!seen.has(id)) items.push({ id, w: Math.max(WIDGETS[id].minW, 6), h: 0, hidden: true });
  }
  return { version: LAYOUT_SCHEMA_VERSION, preset, items };
}

/** Which preset a signed-in user starts with. Admins manage the business → owner view. */
export function resolveRolePreset(input: {
  isOwner: boolean;
  teamRole?: string | null;
  dispatchEnabled?: boolean | null;
}): OverviewPresetId {
  if (input.isOwner || input.teamRole === 'owner' || input.teamRole === 'admin') return 'owner';
  if (input.teamRole === 'technician') return 'technician';
  return input.dispatchEnabled ? 'dispatcher' : 'csr';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isWidgetId = (v: unknown): v is OverviewWidgetId => typeof v === 'string' && (WIDGET_IDS as readonly string[]).includes(v);
const isPresetId = (v: unknown): v is OverviewPreset =>
  v === 'custom' || (typeof v === 'string' && (PRESET_IDS as string[]).includes(v));

/**
 * Turns anything read from the database into a valid layout. Drops unknown or
 * duplicate widgets, clamps sizes, and appends widgets shipped after the user
 * last saved (placed hidden/visible exactly like `fallbackPreset` does).
 */
export function sanitizeLayout(raw: unknown, fallbackPreset: OverviewPresetId): OverviewLayout {
  if (!isRecord(raw) || raw.version !== LAYOUT_SCHEMA_VERSION || !Array.isArray(raw.items)) {
    return buildPresetLayout(fallbackPreset);
  }
  const seen = new Set<OverviewWidgetId>();
  const items: LayoutItem[] = [];
  for (const entry of raw.items) {
    if (!isRecord(entry) || !isWidgetId(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const w = typeof entry.w === 'number' && Number.isFinite(entry.w) ? Math.round(entry.w) : 6;
    const h = typeof entry.h === 'number' && Number.isFinite(entry.h) ? Math.round(entry.h) : 0;
    items.push({
      id: entry.id,
      w: clamp(w, WIDGETS[entry.id].minW, GRID_COLUMNS),
      h: h <= 0 ? 0 : clamp(h, 1, MAX_ROW_UNITS),
      hidden: entry.hidden === true,
    });
  }
  if (items.length === 0) return buildPresetLayout(fallbackPreset);
  const defaults = buildPresetLayout(fallbackPreset).items;
  for (const d of defaults) if (!seen.has(d.id)) items.push(d);
  return { version: LAYOUT_SCHEMA_VERSION, preset: isPresetId(raw.preset) ? raw.preset : 'custom', items };
}

/** Items to render: not hidden and allowed by the user's permissions. */
export function visibleItems(layout: OverviewLayout, can: (p: PermissionKey) => boolean): LayoutItem[] {
  return layout.items.filter((i) => !i.hidden && (!WIDGETS[i.id].permission || can(WIDGETS[i.id].permission!)));
}

/** Widgets the user hid (and may re-add), limited to ones they are allowed to see. */
export function hiddenItems(layout: OverviewLayout, can: (p: PermissionKey) => boolean): LayoutItem[] {
  return layout.items.filter((i) => i.hidden && (!WIDGETS[i.id].permission || can(WIDGETS[i.id].permission!)));
}

const touch = (layout: OverviewLayout, items: LayoutItem[]): OverviewLayout => ({ ...layout, preset: 'custom', items });

/** Moves `id` to the position currently held by `targetId`. */
export function moveWidget(layout: OverviewLayout, id: OverviewWidgetId, targetId: OverviewWidgetId): OverviewLayout {
  if (id === targetId) return layout;
  const from = layout.items.findIndex((i) => i.id === id);
  const to = layout.items.findIndex((i) => i.id === targetId);
  if (from < 0 || to < 0) return layout;
  const items = layout.items.slice();
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  return touch(layout, items);
}

/** Keyboard move: swaps with the previous/next VISIBLE widget. */
export function moveWidgetBy(
  layout: OverviewLayout,
  id: OverviewWidgetId,
  delta: -1 | 1,
  can: (p: PermissionKey) => boolean,
): OverviewLayout {
  const visible = visibleItems(layout, can);
  const idx = visible.findIndex((i) => i.id === id);
  const target = visible[idx + delta];
  return idx < 0 || !target ? layout : moveWidget(layout, id, target.id);
}

export function resizeWidget(
  layout: OverviewLayout,
  id: OverviewWidgetId,
  size: { w?: number; h?: number },
): OverviewLayout {
  let changed = false;
  const items = layout.items.map((i) => {
    if (i.id !== id) return i;
    const w = size.w === undefined ? i.w : clamp(Math.round(size.w), WIDGETS[id].minW, GRID_COLUMNS);
    const h = size.h === undefined ? i.h : size.h <= 0 ? 0 : clamp(Math.round(size.h), 1, MAX_ROW_UNITS);
    if (w === i.w && h === i.h) return i;
    changed = true;
    return { ...i, w, h };
  });
  return changed ? touch(layout, items) : layout;
}

export function setWidgetHidden(layout: OverviewLayout, id: OverviewWidgetId, hidden: boolean): OverviewLayout {
  let changed = false;
  let items = layout.items.map((i) => {
    if (i.id !== id || i.hidden === hidden) return i;
    changed = true;
    return { ...i, hidden };
  });
  if (!changed) return layout;
  if (!hidden) {
    // A re-added widget goes to the end of the visible list so it is easy to find.
    const idx = items.findIndex((i) => i.id === id);
    const [item] = items.splice(idx, 1);
    items = [...items, item];
  }
  return touch(layout, items);
}

/** Applying a preset replaces the layout; it is stored as that preset, not 'custom'. */
export function applyPresetLayout(preset: OverviewPresetId): OverviewLayout {
  return buildPresetLayout(preset);
}

export function layoutsEqual(a: OverviewLayout, b: OverviewLayout): boolean {
  return a.preset === b.preset && JSON.stringify(a.items) === JSON.stringify(b.items);
}
