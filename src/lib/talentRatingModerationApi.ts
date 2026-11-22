// Supabase access for rating reports and moderation. Every call goes through a SECURITY DEFINER RPC;
// the tables have no client grants. Staff checks happen in the database (is_vireek_staff) — the
// StaffRoute gate in the UI is a convenience, not the control.
import { supabase } from '@/lib/supabase';
import {
  classifyError, parseMyDisputes, parseStaffDetail, parseStaffList,
  type Decision, type ModerationErrorKind, type MyDispute, type StaffDisputeDetail, type StaffDisputeRow, type StaffScope,
} from '@/lib/talentRatingModeration';

export class RatingModerationError extends Error {
  readonly kind: ModerationErrorKind;
  constructor(kind: ModerationErrorKind) {
    super(kind);
    this.name = 'RatingModerationError';
    this.kind = kind;
  }
}

interface DbError { code?: string; message?: string }
function fail(error: DbError): never {
  throw new RatingModerationError(classifyError(error));
}

export async function openRatingDispute(engagementId: string, reason: string, details: string): Promise<string> {
  const { data, error } = await supabase.rpc('talent_open_rating_dispute', {
    p_engagement_id: engagementId, p_reason: reason, p_details: details.trim(),
  });
  if (error) fail(error);
  return String((data as { dispute_id: string }).dispute_id);
}

export async function withdrawRatingDispute(disputeId: string): Promise<void> {
  const { error } = await supabase.rpc('talent_withdraw_rating_dispute', { p_dispute_id: disputeId });
  if (error) fail(error);
}

export async function fetchMyRatingDisputes(): Promise<MyDispute[]> {
  const { data, error } = await supabase.rpc('talent_my_rating_disputes');
  if (error) fail(error);
  return parseMyDisputes(data);
}

export async function listStaffRatingDisputes(scope: StaffScope = 'active', limit = 50): Promise<StaffDisputeRow[]> {
  const { data, error } = await supabase.rpc('talent_staff_list_rating_disputes', { p_scope: scope, p_limit: limit });
  if (error) fail(error);
  return parseStaffList(data);
}

export async function getStaffRatingDispute(disputeId: string): Promise<StaffDisputeDetail> {
  const { data, error } = await supabase.rpc('talent_staff_get_rating_dispute', { p_dispute_id: disputeId });
  if (error) fail(error);
  const detail = parseStaffDetail(data);
  if (!detail) throw new RatingModerationError('generic');
  return detail;
}

export async function claimStaffRatingDispute(disputeId: string): Promise<void> {
  const { error } = await supabase.rpc('talent_staff_claim_rating_dispute', { p_dispute_id: disputeId });
  if (error) fail(error);
}

export async function resolveStaffRatingDispute(disputeId: string, decision: Decision, reasonCode: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('talent_staff_resolve_rating_dispute', {
    p_dispute_id: disputeId, p_decision: decision, p_reason_code: reasonCode, p_note: note.trim(),
  });
  if (error) fail(error);
}
