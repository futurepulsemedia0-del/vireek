// src/lib/trustBadge/api.ts - thin client for the trust-badge RPCs / edge functions.
import { supabase } from '@/lib/supabase';
import type { BadgeMetric } from './core';

export interface BadgeSettings {
  account_owner_id: string;
  public_slug: string;
  display_name: string;
  enabled: boolean;
  stat_metric: BadgeMetric;
  approve_active_since: boolean;
  approve_plan_category: boolean;
  approve_answer_stats: boolean;
  show_powered_by: boolean;
  link_rel: string[];
  card_phone: string | null;
  card_booking_enabled: boolean;
  first_enabled_at: string | null;
  last_seen_at: string | null;
  last_seen_host: string | null;
}
export interface BadgeDomain {
  id: string;
  domain: string;
  verification_token: string;
  status: 'pending' | 'verified' | 'failed';
  verified_at: string | null;
  last_error: string | null;
}
export interface LiveStats {
  callCount: number; latestCallAt: string | null; timedCount: number; latestTimedAt: string | null; avgAnswerMs: number | null;
}
export interface BadgeState {
  settings: BadgeSettings;
  domains: BadgeDomain[];
  inheritedDomains: string[];
  whiteLabel: boolean;
  partnerApproved: boolean;
  partnerCode: string | null;
  bookingSlug: string | null;
  liveStats: LiveStats;
  profileStatus: string;
  subscriptionStatus: string;
}

/** Friendly text for the errors the RPCs raise. */
export function friendlyBadgeError(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  const msg = err?.message ?? '';
  if (err?.code === '23505') return 'That address is already taken. Try another one.';
  if (err?.code === '23514') {
    if (/locked/i.test(msg)) return 'The badge address is locked once the badge has been enabled, because installed badges use it.';
    if (/tbs_slug|slug/i.test(msg)) return 'Use 3-40 lowercase letters, numbers or hyphens (not a reserved word).';
    if (/tbs_phone|phone/i.test(msg)) return 'Enter the phone number in international format, e.g. +15125550123.';
    if (/tbd_format/i.test(msg)) return 'Enter a domain like example.com.';
    return 'One of the values is not allowed.';
  }
  if (err?.code === '54000') return msg || 'Limit reached.';
  if (err?.code === '42501') return 'You need the “Edit business profile” permission for this.';
  if (err?.code === 'P0001') return msg;
  return 'Something went wrong. Please try again.';
}

export async function getBadgeState(): Promise<BadgeState> {
  const { data, error } = await supabase.rpc('trust_badge_get');
  if (error) throw error;
  return data as BadgeState;
}
export async function saveBadgeSettings(patch: Partial<Omit<BadgeSettings, 'account_owner_id' | 'first_enabled_at' | 'last_seen_at' | 'last_seen_host'>>): Promise<BadgeState> {
  const { data, error } = await supabase.rpc('trust_badge_save', { p: patch });
  if (error) throw error;
  return data as BadgeState;
}
export async function addBadgeDomain(domain: string): Promise<BadgeDomain> {
  const { data, error } = await supabase.rpc('trust_badge_add_domain', { p_domain: domain });
  if (error) throw error;
  return data as BadgeDomain;
}
export async function removeBadgeDomain(id: string): Promise<void> {
  const { error } = await supabase.rpc('trust_badge_remove_domain', { p_id: id });
  if (error) throw error;
}
export async function verifyBadgeDomain(id: string): Promise<{ status: BadgeDomain['status']; txt_found: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('trust-badge-admin', { body: { action: 'verify_domain', domain_id: id } });
  if (error) {
    // 4xx bodies carry our message (throttle, forbidden); surface it when present.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const body = (await ctx.json().catch(() => null)) as { error?: string; status?: BadgeDomain['status'] } | null;
      if (body?.error) return { status: body.status ?? 'pending', txt_found: false, error: body.error };
    }
    throw error;
  }
  return data as { status: BadgeDomain['status']; txt_found: boolean; error?: string };
}

export interface PublicVerification {
  found: boolean;
  active?: boolean;
  accountInGoodStanding?: boolean;
  displayName?: string;
  facts?: {
    activeSince?: string; planCategory?: 'business' | 'standard';
    windowDays?: number; minSample?: number; freshDays?: number;
    callsAnswered?: { count: number; asOf: string } | null;
    avgAnswerMs?: { value: number; asOf: string } | null;
  };
  domains?: string[];
  token?: { valid: true; host: string; issuedAt: string; hostVerified: boolean } | { valid: false; reason: string } | null;
}

/** Public verification data. Goes through our own domain (CDN-cached rewrite); never needs a session. */
export async function fetchPublicVerification(slug: string, token: string | null, signal?: AbortSignal): Promise<PublicVerification> {
  const q = new URLSearchParams({ slug });
  if (token) q.set('t', token);
  const res = await fetch(`/badge-api/verify?${q}`, { signal, credentials: 'omit' });
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error('verification_unavailable');
  return (await res.json()) as PublicVerification;
}

/** SHA-384 SRI value of the deployed loader, computed from the real file so it can never drift. */
export async function fetchLoaderSri(): Promise<string | null> {
  try {
    const res = await fetch('/embed/badge.v1.js', { cache: 'no-cache' });
    if (!res.ok) return null;
    const digest = await crypto.subtle.digest('SHA-384', await res.arrayBuffer());
    let bin = '';
    for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
    return `sha384-${btoa(bin)}`;
  } catch {
    return null;
  }
}
