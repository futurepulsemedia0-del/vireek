import { describe, expect, it, vi } from 'vitest';
import {
  buildFromAddress,
  buildInboundAddress,
  canManageEmailSettings as serverCanManage,
  composeOutboundText,
  normalizeDomain,
  resolveReplyTo,
  sanitizeSenderName,
  sanitizeSignature,
  summarizeDomain,
} from '../../supabase/functions/_shared/messaging/emailSettings';
import {
  canManageEmailSettings,
  previewFromAddress,
  validateDomain,
  validateLocalPart,
  validateReplyTo,
  validateSignature,
  type EmailSettingsRow,
} from './emailSettings';
import type { UserPermissions } from '@/contexts/AuthContext';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const NO_PERMS: UserPermissions = {
  can_view_billing: false,
  can_manage_numbers: false,
  can_manage_team: false,
  can_edit_business_profile: false,
  can_view_all_jobs: false,
  can_view_audit_log: false,
  can_manage_security: false,
};

describe('permission gate', () => {
  it('client: owner or can_edit_business_profile only', () => {
    expect(canManageEmailSettings(true, NO_PERMS)).toBe(true);
    expect(canManageEmailSettings(false, NO_PERMS)).toBe(false);
    expect(canManageEmailSettings(false, { ...NO_PERMS, can_edit_business_profile: true })).toBe(true);
  });

  it('server: custom role overrides the team member flag', () => {
    expect(serverCanManage({ role: 'owner' })).toBe(true);
    expect(serverCanManage({ role: 'member', teamPermissions: { can_edit_business_profile: true } })).toBe(true);
    expect(
      serverCanManage({
        role: 'member',
        teamPermissions: { can_edit_business_profile: true },
        customRolePermissions: { can_edit_business_profile: false },
      }),
    ).toBe(false);
    expect(serverCanManage({ role: 'member' })).toBe(false);
  });
});

describe('validation', () => {
  it('reply-to: empty is allowed, malformed is not', () => {
    expect(validateReplyTo('')).toBeNull();
    expect(validateReplyTo('support@acme.com')).toBeNull();
    expect(validateReplyTo('not-an-email')).not.toBeNull();
    expect(validateReplyTo('a@b')).not.toBeNull();
  });

  it('local part and signature limits', () => {
    expect(validateLocalPart('hello')).toBeNull();
    expect(validateLocalPart('team.support')).toBeNull();
    expect(validateLocalPart('bad space')).not.toBeNull();
    expect(validateLocalPart('')).not.toBeNull();
    expect(validateSignature('x'.repeat(1000))).toBeNull();
    expect(validateSignature('x'.repeat(1001))).not.toBeNull();
  });

  it('domain: accepts urls/subdomains, rejects junk', () => {
    expect(validateDomain('mail.acme.com')).toBeNull();
    expect(validateDomain('https://Mail.Acme.com/path')).toBeNull();
    expect(validateDomain('localhost')).not.toBeNull();
    expect(validateDomain('')).not.toBeNull();
  });

  it('normalizeDomain lowercases, strips scheme/path and blocks free-mail + platform domains', () => {
    expect(normalizeDomain('https://Mail.Acme.com/x?y=1')).toBe('mail.acme.com');
    expect(normalizeDomain('me@acme.com')).toBe('acme.com');
    expect(normalizeDomain('gmail.com')).toBeNull();
    expect(normalizeDomain('vireek.com')).toBeNull();
    expect(normalizeDomain('not a domain')).toBeNull();
  });
});

describe('sanitizers (header-injection safety)', () => {
  it('sender name drops control chars, angle brackets and quotes', () => {
    expect(sanitizeSenderName('Acme\r\nBcc: x@evil.com <hack>')).toBe('Acme Bcc: x@evil.com hack');
    expect(sanitizeSenderName('   ')).toBeNull();
    expect(sanitizeSenderName('x'.repeat(200))?.length).toBe(80);
  });

  it('signature normalizes newlines, collapses blank runs, caps length', () => {
    expect(sanitizeSignature('Hi\r\n\r\n\r\n\r\nBye')).toBe('Hi\n\nBye');
    expect(sanitizeSignature('')).toBeNull();
    expect(sanitizeSignature('a'.repeat(2000))?.length).toBe(1000);
  });

  it('composeOutboundText appends the signature after a standard delimiter', () => {
    expect(composeOutboundText('  Hello  ', null)).toBe('Hello');
    expect(composeOutboundText('Hello', 'Thanks,\nAcme')).toBe('Hello\n\n-- \nThanks,\nAcme');
  });
});

describe('routing', () => {
  it('reply-to: custom wins, otherwise the inbound alias', () => {
    expect(resolveReplyTo('support@acme.com', 'abc@in.vireek.test')).toBe('support@acme.com');
    expect(resolveReplyTo('', 'abc@in.vireek.test')).toBe('abc@in.vireek.test');
    expect(resolveReplyTo('garbage', 'abc@in.vireek.test')).toBe('abc@in.vireek.test');
    expect(resolveReplyTo(null, null)).toBeUndefined();
  });

  it('inbound address needs both token and domain', () => {
    expect(buildInboundAddress('abc123', 'In.Vireek.test')).toBe('abc123@in.vireek.test');
    expect(buildInboundAddress(null, 'in.vireek.test')).toBeNull();
    expect(buildInboundAddress('abc', '')).toBeNull();
  });

  it('From uses the custom domain ONLY when verified', () => {
    const base = { senderName: null, companyName: 'Acme HVAC', domain: 'mail.acme.com', localPart: 'service', platformFrom: 'Vireek <onboarding@resend.dev>' };
    expect(buildFromAddress({ ...base, domainStatus: 'verified' })).toBe('Acme HVAC <service@mail.acme.com>');
    expect(buildFromAddress({ ...base, domainStatus: 'pending' })).toBe('Acme HVAC <onboarding@resend.dev>');
    expect(buildFromAddress({ ...base, domain: null, domainStatus: null, companyName: null })).toBe('Vireek <onboarding@resend.dev>');
    expect(buildFromAddress({ ...base, domainStatus: 'verified', senderName: 'Sam at Acme' })).toBe('Sam at Acme <service@mail.acme.com>');
  });
});

describe('summarizeDomain (provider payload mapping)', () => {
  const payload = {
    status: 'pending',
    records: [
      { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', ttl: 'Auto', status: 'verified', priority: 10 },
      { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', ttl: 'Auto', status: 'verified' },
      { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGf...', ttl: 'Auto', status: 'pending' },
    ],
  };

  it('rolls records up into SPF and DKIM status', () => {
    const s = summarizeDomain(payload);
    expect(s.status).toBe('pending');
    expect(s.spf).toBe('verified');
    expect(s.dkim).toBe('pending');
    expect(s.records).toHaveLength(3);
    expect(s.records[0].priority).toBe(10);
  });

  it('any failed record fails the roll-up; temporary_failure counts as failed', () => {
    const s = summarizeDomain({ status: 'temporary_failure', records: [{ record: 'DKIM', status: 'temporary_failure' }, { record: 'DKIM', status: 'verified' }] });
    expect(s.status).toBe('failed');
    expect(s.dkim).toBe('failed');
  });

  it('is safe on empty or malformed payloads', () => {
    expect(summarizeDomain(null)).toEqual({ status: 'not_started', spf: 'not_started', dkim: 'not_started', records: [] });
    expect(summarizeDomain({ records: 'nope' }).records).toEqual([]);
  });
});

describe('previewFromAddress', () => {
  const row = (over: Partial<EmailSettingsRow>): EmailSettingsRow => ({
    user_id: 'u1',
    reply_to_email: null,
    signature: null,
    sender_name: null,
    sender_local_part: 'hello',
    sender_domain: null,
    resend_domain_id: null,
    domain_status: 'not_started',
    spf_status: 'not_started',
    dkim_status: 'not_started',
    dns_records: [],
    domain_checked_at: null,
    inbound_enabled: true,
    updated_at: '',
    ...over,
  });

  it('shows the custom address only once verified', () => {
    expect(previewFromAddress(row({ sender_domain: 'mail.acme.com', domain_status: 'verified' }), 'Acme')).toBe('Acme <hello@mail.acme.com>');
    expect(previewFromAddress(row({ sender_domain: 'mail.acme.com', domain_status: 'pending' }), 'Acme')).toContain('shared address');
    expect(previewFromAddress(null, null)).toContain('Vireek');
  });
});
