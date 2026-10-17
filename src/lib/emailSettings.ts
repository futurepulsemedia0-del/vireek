// Client API + pure helpers for /dashboard/settings/email.
// Backend: supabase/functions/email-settings (all reads/writes go through it so
// the permission gate, accountOwnerId scoping and provider calls stay server-side).
// Schema: supabase/migrations/20270402000000_email_settings.sql.

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { UserPermissions } from '@/contexts/AuthContext';

export type DomainStatus = 'not_started' | 'pending' | 'verified' | 'failed';

export interface DnsRecord {
  kind: string;
  type: string;
  name: string;
  value: string;
  ttl: string;
  priority: number | null;
  status: DomainStatus;
}

export interface EmailSettingsRow {
  user_id: string;
  reply_to_email: string | null;
  signature: string | null;
  sender_name: string | null;
  sender_local_part: string;
  sender_domain: string | null;
  resend_domain_id: string | null;
  domain_status: DomainStatus;
  spf_status: DomainStatus;
  dkim_status: DomainStatus;
  dns_records: DnsRecord[];
  domain_checked_at: string | null;
  inbound_enabled: boolean;
  updated_at: string;
}

export interface EmailSettingsState {
  settings: EmailSettingsRow | null;
  inboundAddress: string | null;
  platform: { emailConfigured: boolean; inboundConfigured: boolean };
}

export interface EmailSettingsInput {
  replyTo: string;
  signature: string;
  senderName: string;
  senderLocalPart: string;
  inboundEnabled: boolean;
}

export const SIGNATURE_MAX = 1000;
export const SENDER_NAME_MAX = 80;

const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i;
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Same rule as the dashboard nav + the edge function: owner, or can_edit_business_profile. */
export function canManageEmailSettings(isOwner: boolean, permissions: UserPermissions): boolean {
  return isOwner || permissions.can_edit_business_profile === true;
}

/** Returns an error message, or null when valid. Empty reply-to is valid (falls back to the inbox alias). */
export function validateReplyTo(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  return EMAIL_RE.test(v) ? null : 'Enter a valid email address.';
}

export function validateLocalPart(value: string): string | null {
  return LOCAL_PART_RE.test(value.trim()) ? null : 'Use letters, numbers, dots, dashes or underscores.';
}

export function validateDomain(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^.*@/, '').split(/[/?#:]/)[0].replace(/\.$/, '');
  return DOMAIN_RE.test(v) ? null : 'Enter a domain you own, like mail.yourcompany.com.';
}

export function validateSignature(value: string): string | null {
  return value.length > SIGNATURE_MAX ? `Signature is limited to ${SIGNATURE_MAX} characters.` : null;
}

export const STATUS_LABEL: Record<DomainStatus, string> = {
  not_started: 'Not started',
  pending: 'Pending DNS',
  verified: 'Verified',
  failed: 'Failed',
};

/** The From address that email-send will actually use right now (mirrors buildFromAddress). */
export function previewFromAddress(row: EmailSettingsRow | null, companyName: string | null): string {
  const name = (row?.sender_name || companyName || 'Vireek').replace(/[<>",]/g, '').trim();
  if (row?.sender_domain && row.domain_status === 'verified') return `${name} <${row.sender_local_part}@${row.sender_domain}>`;
  return `${name} <via Vireek shared address>`;
}

export function dnsRecordToText(r: DnsRecord): string {
  return `${r.type}\t${r.name}\t${r.value}${r.priority != null ? `\tpriority ${r.priority}` : ''}`;
}

async function errorMessage(error: unknown, fallback: string): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = (await error.context.json().catch(() => null)) as { detail?: string; error?: string } | null;
    if (body?.detail) return body.detail;
    if (body?.error) return body.error;
  }
  return fallback;
}

async function call(body: Record<string, unknown>): Promise<EmailSettingsState> {
  const { data, error } = await supabase.functions.invoke('email-settings', { body });
  if (error) throw new Error(await errorMessage(error, 'Could not reach the email settings service. Check your connection and try again.'));
  if (data?.error) throw new Error(String(data.detail ?? data.error));
  return data as EmailSettingsState;
}

export const fetchEmailSettings = () => call({ action: 'get' });
export const saveEmailSettings = (input: EmailSettingsInput) => call({ action: 'save', ...input });
export const addSenderDomain = (domain: string) => call({ action: 'domain_add', domain: domain.trim() });
export const verifySenderDomain = () => call({ action: 'domain_verify' });
export const removeSenderDomain = () => call({ action: 'domain_remove' });
export const rotateInboundAddress = () => call({ action: 'rotate_inbound' });
