// src/lib/directMailAudience.ts
//
// Direct Mail: build a campaign audience from an existing marketing segment (Audiences page) and verify addresses.
// Server side: migration 20271231120000_direct_mail_audience_and_verification.sql + function direct-mail-verify.
// NOT LIVE-VERIFIED against Lob (mock-tested only).

import { supabase } from '@/lib/supabase';
import { fetchAllMembers, filterToRules, rulesToFilter, type AudienceEntity, type AudienceFilter } from '@/lib/audiences';
import { chunk, customersToRecipients, directMailErrorMessage, type ImportResult } from '@/lib/directMail';

export const MAX_CAMPAIGN_RECIPIENTS = 20000;
const ID_CHUNK = 150;

const fail = (error: { code?: string; message?: string }, fallback: string): never => {
  throw new Error(directMailErrorMessage(error, fallback));
};

// ------------------------------------------------------------------ segments
export interface SegmentOption {
  id: string;
  name: string;
  entity: AudienceEntity;
  filter: AudienceFilter;
  /** Only customers carry a mailing address; lead segments cannot be mailed. */
  mailable: boolean;
}

export async function listSegments(ownerId: string): Promise<SegmentOption[]> {
  const { data, error } = await supabase
    .from('marketing_segments').select('id,name,filter').eq('user_id', ownerId).order('name', { ascending: true }).limit(200);
  if (error) fail(error, 'Could not load your audiences.');
  return ((data ?? []) as { id: string; name: string; filter: Record<string, unknown> | null }[]).map((s) => {
    const { entity, rules } = filterToRules(s.filter);
    return { id: s.id, name: s.name, entity, filter: rulesToFilter(entity, rules), mailable: entity === 'customer' };
  });
}

export interface SegmentResolution extends ImportResult {
  /** customers matched by the segment rules */
  matched: number;
  /** matched customers with no address on file */
  noAddress: number;
  /** the safety cap stopped reading before every member was loaded */
  truncated: boolean;
}

/** Resolves a customer segment into mailable, de-duplicated addresses (same rules the Audiences page counts). */
export async function resolveSegmentRecipients(ownerId: string, filter: AudienceFilter): Promise<SegmentResolution> {
  if (filter.entity !== 'customer') return { recipients: [], errors: [], duplicates: 0, matched: 0, noAddress: 0, truncated: false };
  let members: Awaited<ReturnType<typeof fetchAllMembers>>;
  try {
    members = await fetchAllMembers(ownerId, filter);
  } catch (e) {
    throw new Error(e instanceof Error && e.message ? e.message : 'Could not load this audience.');
  }

  const rows: { name: string | null; address: string | null }[] = [];
  for (const ids of chunk(members.members.map((m) => m.id), ID_CHUNK)) {
    const { data, error } = await supabase.from('customers').select('name,address').eq('user_id', ownerId).in('id', ids);
    if (error) fail(error, 'Could not load customer addresses.');
    rows.push(...((data ?? []) as { name: string | null; address: string | null }[]));
  }

  const withAddress = rows.filter((r) => (r.address ?? '').trim() !== '');
  return { ...customersToRecipients(withAddress), matched: members.total, noAddress: rows.length - withAddress.length, truncated: members.truncated };
}

/** Best-effort bookkeeping after recipients were added (the campaign remembers where its audience came from). */
export async function linkSegment(campaignId: string, segmentId: string): Promise<void> {
  const { error } = await supabase.rpc('direct_mail_link_audience', { p_campaign_id: campaignId, p_segment_id: segmentId });
  if (error) fail(error, 'Could not record the audience on the campaign.');
}

// ------------------------------------------------------------------ address verification
export interface VerificationSummary {
  queued: number;
  unverified: number;
  deliverable: number;
  review: number;
  undeliverable: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

export async function fetchVerificationSummary(campaignId: string): Promise<VerificationSummary> {
  const { data, error } = await supabase.rpc('direct_mail_verification_summary', { p_campaign_id: campaignId });
  if (error) fail(error, 'Could not load the address check status.');
  const r = (data ?? {}) as Record<string, unknown>;
  return { queued: num(r.queued), unverified: num(r.unverified), deliverable: num(r.deliverable), review: num(r.review), undeliverable: num(r.undeliverable) };
}

export interface VerifyResult {
  processed: number;
  deliverable: number;
  review: number;
  undeliverable: number;
  errors: number;
  remaining: number;
  /** true in live mode: undeliverable addresses were removed from the send */
  blocking: boolean;
}

export async function verifyCampaignAddresses(campaignId: string): Promise<VerifyResult> {
  const { data, error } = await supabase.functions.invoke('direct-mail-verify', { body: { campaign_id: campaignId } });
  const code = (data as { error?: string } | null)?.error;
  if (error || code) throw new Error(directMailErrorMessage(code ?? error?.message, 'The address check failed. Nothing was lost — try again.'));
  const r = data as Record<string, unknown>;
  return {
    processed: num(r.processed), deliverable: num(r.deliverable), review: num(r.review), undeliverable: num(r.undeliverable),
    errors: num(r.errors), remaining: num(r.remaining), blocking: r.blocking === true,
  };
}

/** Runs the check until nothing is left, or a round makes no progress (provider trouble). Pure loop, unit tested. */
export async function verifyUntilDone(
  run: () => Promise<VerifyResult>,
  onProgress?: (total: VerifyResult) => void,
  shouldStop: () => boolean = () => false,
  maxRounds = 200,
): Promise<{ total: VerifyResult; stalled: boolean }> {
  const total: VerifyResult = { processed: 0, deliverable: 0, review: 0, undeliverable: 0, errors: 0, remaining: 0, blocking: false };
  for (let i = 0; i < maxRounds && !shouldStop(); i++) {
    const r = await run();
    const decided = r.deliverable + r.review + r.undeliverable;
    total.processed += r.processed; total.deliverable += r.deliverable; total.review += r.review;
    total.undeliverable += r.undeliverable; total.errors += r.errors; total.remaining = r.remaining; total.blocking = r.blocking;
    onProgress?.({ ...total });
    if (r.remaining === 0) return { total, stalled: false };
    if (decided === 0) return { total, stalled: true };
  }
  return { total, stalled: total.remaining > 0 };
}

export type VerificationTone = 'ok' | 'warn' | 'bad';

/** Small per-mailer label for the recipients table. Null = nothing to show. */
export function verificationLabel(p: { status: string; verification_status?: string | null; verification_note?: string | null }): { text: string; tone: VerificationTone } | null {
  if (p.status !== 'queued') return null;
  switch (p.verification_status) {
    case 'deliverable': return { text: 'Address verified', tone: 'ok' };
    case 'review': return { text: `Check address${p.verification_note ? `: ${p.verification_note}` : ''}`, tone: 'warn' };
    case 'undeliverable': return { text: 'Looks undeliverable (test result, not removed)', tone: 'bad' };
    default: return null;
  }
}
