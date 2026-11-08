import type { PermissionKey, SettingsEntry } from './registry';

export type PermissionMap = Partial<Record<PermissionKey, boolean>>;

export interface AccessContext {
  isOwner: boolean;
  permissions: PermissionMap;
}

export type AccessResult =
  | { state: 'allowed' }
  | { state: 'hidden' }
  | { state: 'locked'; reason: 'owner' | 'permission'; message: string };

/** Anyone holding at least one admin-type permission counts as staff-admin. */
const ADMIN_KEYS: readonly PermissionKey[] = [
  'can_edit_business_profile',
  'can_manage_team',
  'can_manage_security',
  'can_view_billing',
  'can_manage_numbers',
  'can_view_audit_log',
  'can_export_data',
];

export function isStaffAdmin(ctx: AccessContext): boolean {
  return ctx.isOwner || ADMIN_KEYS.some((k) => ctx.permissions[k] === true);
}

/**
 * allowed: user can open and change it.
 * hidden: organization-level setting for someone with no admin permission at all.
 * locked: visible with a one-line reason and next step.
 * UI-level only; server-side enforcement (RLS/edge functions) is separate.
 */
export function resolveAccess(entry: SettingsEntry, ctx: AccessContext): AccessResult {
  if (ctx.isOwner || entry.permission === 'any') return { state: 'allowed' };
  if (entry.scope === 'organization' && !isStaffAdmin(ctx)) return { state: 'hidden' };
  if (entry.permission === 'owner') {
    return { state: 'locked', reason: 'owner', message: 'Only Owners can change this.' };
  }
  if (ctx.permissions[entry.permission] === true) return { state: 'allowed' };
  return { state: 'locked', reason: 'permission', message: 'Ask an Owner to give you access to this.' };
}
