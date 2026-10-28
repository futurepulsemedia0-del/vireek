/**
 * Dashboard Builder — role layouts (pure model).
 *
 * No React, no Supabase: everything here is deterministic and unit-tested.
 * Which layout a person sees (first match wins):
 *   1. their own saved layout            (overview_layouts)
 *   2. the account's layout for their role (dashboard_role_layouts)
 *   3. the built-in preset for their role  (code)
 */
import {
  PRESET_IDS,
  PRESET_LABELS,
  WIDGETS,
  buildPresetLayout,
  layoutsEqual,
  sanitizeLayout,
  type OverviewLayout,
  type OverviewPresetId,
  type OverviewWidgetId,
  type PermissionKey,
} from '@/lib/overviewLayout';

export type RoleKey = OverviewPresetId;

export const ROLE_KEYS: readonly RoleKey[] = PRESET_IDS;

export const ROLE_DESCRIPTIONS: Record<RoleKey, string> = {
  owner: 'Owners and admins: the whole business at a glance.',
  dispatcher: 'Team members who can dispatch jobs.',
  csr: 'Office staff and customer service.',
  technician: 'Field technicians.',
};

export const WIDGET_DESCRIPTIONS: Record<OverviewWidgetId, string> = {
  since_yesterday: 'A recap of what changed since the last working day.',
  revenue_recovered: 'Revenue won back from calls that would have been missed.',
  kpi_calls: 'Calls handled this month.',
  kpi_emergency: 'Emergency calls this month.',
  kpi_jobs: 'Jobs completed this month.',
  kpi_revenue: 'Revenue booked this month.',
  metric_minutes: 'Assistant minutes used against the plan.',
  metric_sentiment: 'How callers felt about their conversations.',
  metric_conversion: 'Share of calls that became booked jobs.',
  metric_missed: 'Share of calls that went unanswered.',
  call_volume: 'Call volume over time.',
  needs_attention: 'Calls and jobs that need a human follow-up.',
  attribution: 'Which lead sources bring in calls and revenue.',
  ai_insights: 'Suggestions generated from recent activity.',
  quick_actions: 'Shortcuts to the pages used most.',
  recent_activity: 'The latest calls, jobs and updates.',
  kpi_renewal_rate: 'How many service agreements renew.',
  data_health: 'Checks that data and integrations are healthy.',
};

const PERMISSION_LABELS: Record<PermissionKey, string> = {
  can_view_billing: 'View billing',
  can_manage_numbers: 'Manage numbers',
  can_manage_team: 'Manage team',
  can_edit_business_profile: 'Edit business profile',
  can_view_all_jobs: 'View all jobs',
  can_view_audit_log: 'View audit log',
  can_manage_security: 'Manage security',
  can_issue_refunds: 'Issue refunds',
  can_export_data: 'Export data',
};

export function roleLabel(role: RoleKey): string {
  return PRESET_LABELS[role];
}

export const isRoleKey = (v: unknown): v is RoleKey =>
  typeof v === 'string' && (ROLE_KEYS as readonly string[]).includes(v);

/** Short note for widgets that only appear for people holding a permission. */
export function permissionNote(id: OverviewWidgetId): string | null {
  const permission = WIDGETS[id].permission;
  if (!permission) return null;
  return `Only shown to people with the "${PERMISSION_LABELS[permission]}" permission.`;
}

/**
 * The layout everyone in a role starts from: the account's saved layout when
 * there is one, otherwise the built-in preset. Anything unreadable falls back
 * to the preset, so a damaged row can never blank a dashboard.
 */
export function resolveBaseLayout(roleRaw: unknown, role: RoleKey): OverviewLayout {
  return roleRaw === null || roleRaw === undefined ? buildPresetLayout(role) : sanitizeLayout(roleRaw, role);
}

export function visibleWidgetCount(layout: OverviewLayout): number {
  return layout.items.filter((i) => !i.hidden).length;
}

/** A published layout must show something. Returns a message, or null when valid. */
export function validateRoleLayout(layout: OverviewLayout): string | null {
  return visibleWidgetCount(layout) === 0 ? 'Show at least one widget before saving.' : null;
}

/** Independent copy of a layout (used by "copy from another role"). */
export function copyLayout(source: OverviewLayout): OverviewLayout {
  return { version: source.version, preset: 'custom', items: source.items.map((i) => ({ ...i })) };
}

export type SavedRoleLayouts = Record<RoleKey, OverviewLayout | null>;
export type DraftRoleLayouts = Record<RoleKey, OverviewLayout>;
export interface RoleLayoutMaps {
  saved: SavedRoleLayouts;
  drafts: DraftRoleLayouts;
}

/** Turns the rows read from the database into the builder's working state. */
export function buildRoleMaps(rows: ReadonlyArray<{ roleKey: RoleKey; layout: unknown }>): RoleLayoutMaps {
  const saved = {} as SavedRoleLayouts;
  const drafts = {} as DraftRoleLayouts;
  for (const role of ROLE_KEYS) {
    const row = rows.find((r) => r.roleKey === role);
    const layout = row ? sanitizeLayout(row.layout, role) : null;
    saved[role] = layout;
    drafts[role] = layout ?? buildPresetLayout(role);
  }
  return { saved, drafts };
}

/** What a role currently shows to people: the saved layout, else the preset. */
export function publishedLayout(saved: OverviewLayout | null, role: RoleKey): OverviewLayout {
  return saved ?? buildPresetLayout(role);
}

/** True when the draft differs from what is currently published for the role. */
export function isRoleDirty(draft: OverviewLayout, saved: OverviewLayout | null, role: RoleKey): boolean {
  return !layoutsEqual(draft, publishedLayout(saved, role));
}
