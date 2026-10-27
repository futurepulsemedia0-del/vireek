// Client API for Listing Sync (/dashboard/listings).
// Backend: supabase/functions/listings (authenticated, scoped to the account
// owner), listings-sync (cron) and listings-oauth-callback. Provider calls live
// behind supabase/functions/_shared/listings/providers.ts. Pure rules
// (canonical record, validation, drift, sync planning) live in the shared engine
// so client and server can never disagree. Schema: 20271210000000_listing_sync.sql.
// Required keys: docs/listings-integrations.md.

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { UserPermissions } from '@/contexts/AuthContext';
import {
  DRIFT_FIELD_LABEL,
  LISTING_PLATFORMS,
  LISTING_PLATFORM_LABEL,
  MODE_LABEL,
  STATE_LABEL,
  canManageListings as serverCanManage,
  copyRecord,
  listingHealth,
  singleLineAddress,
  type Canonical,
  type DriftField,
  type HealthSummary,
  type LinkMode,
  type LinkState,
  type ListingIssue,
  type ListingPlatform,
} from '../../supabase/functions/_shared/listings/engine';

export { DRIFT_FIELD_LABEL, LISTING_PLATFORMS, LISTING_PLATFORM_LABEL, MODE_LABEL, STATE_LABEL, copyRecord, listingHealth, singleLineAddress };
export type { Canonical, DriftField, HealthSummary, LinkMode, LinkState, ListingIssue, ListingPlatform };

export interface ListingSettings {
  auto_sync: boolean;
  website_url: string | null;
  description: string | null;
}

export interface PlatformInfo {
  platform: ListingPlatform;
  configured: boolean;
  pushEnabled: boolean;
  mode: LinkMode;
  credentials: 'oauth' | 'location_id' | 'yelp_url';
  externalLabel: string;
  note: string;
}

export interface ListingLocation {
  id: string;
  name: string;
  status: string;
  is_primary: boolean;
  canonical: Canonical;
  hash: string;
  issues: ListingIssue[];
}

export interface ListingConnection {
  id: string;
  platform: ListingPlatform;
  external_id: string;
  display_name: string;
  status: 'active' | 'needs_reauth' | 'error';
  last_synced_at: string | null;
  last_error: string | null;
}

export interface ListingLink {
  id: string;
  location_id: string;
  connection_id: string | null;
  platform: ListingPlatform;
  external_location_id: string;
  mode: LinkMode;
  state: LinkState;
  last_pushed_hash: string | null;
  last_pushed_at: string | null;
  last_checked_at: string | null;
  drift_fields: DriftField[];
  blocked_reason: string | null;
  last_error: string | null;
}

export interface ListingEvent {
  id: string;
  location_id: string | null;
  platform: ListingPlatform;
  kind: 'push' | 'check' | 'manual_confirm' | 'link' | 'unlink';
  outcome: 'ok' | 'drift' | 'blocked' | 'error';
  fields: string[];
  detail: string | null;
  created_at: string;
}

export interface ListingsOverview {
  settings: ListingSettings;
  platforms: PlatformInfo[];
  locations: ListingLocation[];
  connections: ListingConnection[];
  links: ListingLink[];
  events: ListingEvent[];
}

export interface SyncOutcome {
  linkId: string;
  action: string;
  state: LinkState;
  fields: DriftField[];
  error: string | null;
}

export type SyncResponse = ListingsOverview & { sync?: SyncOutcome[]; remaining?: number };

/** Same rule as the dashboard nav, Reputation and the edge function: owner, or can_edit_business_profile. */
export function canManageListings(isOwner: boolean, permissions: UserPermissions): boolean {
  return serverCanManage({ role: isOwner ? 'owner' : 'member', teamPermissions: permissions as unknown as Record<string, unknown> });
}

export const STATE_CLASS: Record<LinkState, string> = {
  synced: 'bg-success/10 text-success',
  pending: 'bg-warning-500/10 text-warning-500',
  drift: 'bg-warning-500/10 text-warning-500',
  blocked: 'bg-bg-tertiary text-text-secondary',
  error: 'bg-danger/10 text-danger',
  needs_reauth: 'bg-danger/10 text-danger',
};

export function timeAgo(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'Never';
  const mins = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function describeEvent(e: Pick<ListingEvent, 'kind' | 'outcome' | 'fields' | 'detail'>): string {
  const fields = e.fields.map((f) => DRIFT_FIELD_LABEL[f as DriftField] ?? f).join(', ');
  if (e.outcome === 'error') return e.detail ? `Failed: ${e.detail}` : 'Failed';
  if (e.kind === 'push') return fields ? `Updated ${fields}` : 'Updated listing';
  if (e.kind === 'manual_confirm') return 'Marked as updated by hand';
  if (e.kind === 'link') return 'Linked';
  if (e.kind === 'unlink') return 'Unlinked';
  if (e.outcome === 'drift') return fields ? `Found mismatch: ${fields}` : 'Found a mismatch';
  if (e.outcome === 'blocked') return e.detail ?? 'Needs more business details';
  return e.detail ?? 'Checked — matches';
}

export interface LocationRowModel {
  location: ListingLocation;
  links: ListingLink[];
  blocking: ListingIssue[];
  warnings: ListingIssue[];
  health: HealthSummary;
}

/** Joins locations with their links, most-needy first (no links last), then by name. */
export function buildLocationRows(data: Pick<ListingsOverview, 'locations' | 'links'>): LocationRowModel[] {
  const rows = data.locations.map((location) => {
    const links = data.links.filter((l) => l.location_id === location.id);
    return {
      location,
      links,
      blocking: location.issues.filter((i) => i.blocking),
      warnings: location.issues.filter((i) => !i.blocking),
      health: listingHealth(links.map((l) => l.state)),
    };
  });
  const rank = (r: LocationRowModel) => (r.links.length === 0 ? 2 : r.health.attention > 0 ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || a.location.name.localeCompare(b.location.name));
}

export function overallHealth(data: Pick<ListingsOverview, 'links'>): HealthSummary {
  return listingHealth(data.links.map((l) => l.state));
}

// ---------------------------------------------------------------
// transport
// ---------------------------------------------------------------

async function errorMessage(error: unknown, fallback: string): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = (await error.context.json().catch(() => null)) as { detail?: string } | null;
    if (body?.detail) return body.detail;
  }
  return fallback;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('listings', { body });
  if (error) throw new Error(await errorMessage(error, 'Could not reach the listings service. Check your connection and try again.'));
  if (data?.error) throw new Error(String(data.detail ?? data.error));
  return data as T;
}

export const fetchListings = () => call<ListingsOverview>({ action: 'overview' });
export const saveListingSettings = (s: { autoSync: boolean; websiteUrl: string; description: string }) => call<ListingsOverview>({ action: 'save_settings', ...s });
export const startListingsOAuth = () => call<{ url: string }>({ action: 'oauth_start', platform: 'facebook' });
export const connectYelpListing = (businessId: string) => call<ListingsOverview>({ action: 'connect_yelp', businessId });
export const disconnectListingSource = (connectionId: string) => call<ListingsOverview>({ action: 'disconnect', connectionId });
export const linkLocation = (input: { locationId: string; platform: ListingPlatform; connectionId?: string; externalLocationId?: string }) =>
  call<SyncResponse>({ action: 'link_location', ...input });
export const unlinkLocation = (linkId: string) => call<ListingsOverview>({ action: 'unlink_location', linkId });
export const syncListings = (target?: { linkId?: string; locationId?: string }) => call<SyncResponse>({ action: 'sync', ...target });
export const confirmManualUpdate = (linkId: string) => call<ListingsOverview>({ action: 'confirm_manual', linkId });

/** One toast for a batch of sync outcomes: errors first, then mismatches, otherwise success. */
export function syncSummary(outcomes: Pick<SyncOutcome, 'state' | 'action' | 'error'>[]): { type: 'success' | 'error' | 'info'; message: string } {
  if (outcomes.length === 0) return { type: 'info', message: 'Nothing to sync.' };
  const failed = outcomes.filter((o) => o.error);
  if (failed.length > 0) return { type: 'error', message: `${failed.length} listing${failed.length === 1 ? '' : 's'} failed: ${failed[0].error}` };
  const drift = outcomes.filter((o) => o.state === 'drift').length;
  if (drift > 0) return { type: 'info', message: `${drift} listing${drift === 1 ? '' : 's'} no longer match${drift === 1 ? 'es' : ''} your details — see the Locations tab.` };
  const blocked = outcomes.filter((o) => o.state === 'blocked').length;
  if (blocked > 0) return { type: 'info', message: `${blocked} listing${blocked === 1 ? ' needs' : 's need'} more business details before syncing.` };
  const manual = outcomes.filter((o) => o.action === 'manual' && o.state === 'pending').length;
  if (manual > 0) return { type: 'info', message: `${manual} listing${manual === 1 ? ' is' : 's are'} ready — copy the record and update it on the directory.` };
  return { type: 'success', message: 'Sync complete.' };
}
