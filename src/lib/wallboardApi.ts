// src/lib/wallboardApi.ts
//
// Supabase access for the Dispatch Wallboard.
//  - fetchWallboardSnapshot: token-gated public RPC (what the TV calls)
//  - list/create/update/revoke: owner-only management (RLS + RPC enforced)

import { supabase } from '@/lib/supabase';
import { clampRotation, normalizePanels, num, parseSnapshot, type WallboardPanelKey, type WallboardSnapshot } from '@/lib/wallboard';

export class WallboardError extends Error {
  constructor(
    message: string,
    public readonly kind: 'network' | 'permission' | 'limit' | 'invalid' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'WallboardError';
  }
}

function mapError(error: { message?: string; code?: string }): WallboardError {
  const msg = error.message ?? '';
  if (error.code === '42501') return new WallboardError('Only the account owner can manage wallboards.', 'permission');
  if (error.code === '54000') return new WallboardError('Too many active wallboards. Revoke one first.', 'limit');
  if (error.code === '22023' || error.code === '23514') return new WallboardError('Those settings are not valid.', 'invalid');
  if (/fetch|network|failed to fetch/i.test(msg)) return new WallboardError('Network problem. Check the connection and try again.', 'network');
  return new WallboardError('Something went wrong. Please try again.', 'unknown');
}

/**
 * Resolves to a snapshot, or null when the token is unknown / revoked
 * (the two cases are intentionally indistinguishable). Throws WallboardError
 * for transient failures so the TV can keep showing its last good data.
 */
export async function fetchWallboardSnapshot(token: string): Promise<WallboardSnapshot | null> {
  const { data, error } = await supabase.rpc('get_wallboard_snapshot', { p_token: token });
  if (error) throw mapError(error);
  if (data === null || data === undefined) return null;
  const parsed = parseSnapshot(data);
  if (!parsed) throw new WallboardError('The server returned an unexpected response.', 'unknown');
  return parsed;
}

// ------------------------------------------------------------- management

export interface WallboardRow {
  id: string;
  name: string;
  rotationSeconds: number;
  panels: WallboardPanelKey[];
  revenueGoalOverride: number | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface WallboardInput {
  name: string;
  rotationSeconds: number;
  panels: WallboardPanelKey[];
  revenueGoalOverride: number | null;
}

export function validateWallboardInput(input: WallboardInput): string | null {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) return 'Give the display a name (up to 60 characters).';
  if (input.panels.length < 1) return 'Pick at least one panel.';
  if (input.revenueGoalOverride !== null && (!Number.isFinite(input.revenueGoalOverride) || input.revenueGoalOverride < 0)) {
    return 'The monthly revenue goal must be zero or more.';
  }
  return null;
}

export async function listWallboards(): Promise<WallboardRow[]> {
  const { data, error } = await supabase
    .from('wallboards')
    .select('id, name, rotation_seconds, panels, revenue_goal_override, last_seen_at, created_at')
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) throw mapError(error);
  return (data ?? []).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    rotationSeconds: clampRotation(r.rotation_seconds),
    panels: normalizePanels(r.panels),
    revenueGoalOverride: r.revenue_goal_override === null || r.revenue_goal_override === undefined ? null : num(r.revenue_goal_override, 0),
    lastSeenAt: typeof r.last_seen_at === 'string' ? r.last_seen_at : null,
    createdAt: String(r.created_at),
  }));
}

/** The raw token is returned exactly once; only its hash is stored server-side. */
export async function createWallboard(input: WallboardInput): Promise<{ id: string; token: string }> {
  const invalid = validateWallboardInput(input);
  if (invalid) throw new WallboardError(invalid, 'invalid');
  const { data, error } = await supabase.rpc('create_wallboard', {
    p_name: input.name.trim(),
    p_rotation_seconds: clampRotation(input.rotationSeconds),
    p_panels: input.panels,
    p_revenue_goal: input.revenueGoalOverride,
  });
  if (error) throw mapError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.token !== 'string' || typeof row.wallboard_id !== 'string') {
    throw new WallboardError('The server returned an unexpected response.', 'unknown');
  }
  return { id: row.wallboard_id, token: row.token };
}

export async function updateWallboard(id: string, input: WallboardInput): Promise<void> {
  const invalid = validateWallboardInput(input);
  if (invalid) throw new WallboardError(invalid, 'invalid');
  const { data, error } = await supabase.rpc('update_wallboard', {
    p_id: id,
    p_name: input.name.trim(),
    p_rotation_seconds: clampRotation(input.rotationSeconds),
    p_panels: input.panels,
    p_revenue_goal: input.revenueGoalOverride,
  });
  if (error) throw mapError(error);
  if (data !== true) throw new WallboardError('That display no longer exists.', 'invalid');
}

export async function revokeWallboard(id: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_wallboard', { p_id: id });
  if (error) throw mapError(error);
}
