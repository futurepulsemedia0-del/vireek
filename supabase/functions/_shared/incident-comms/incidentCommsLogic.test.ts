import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PHASES,
  SEVERITIES,
  SEVERITY_MATRIX,
  TEMPLATE_IDS,
  allowedAudiences,
  audienceProblem,
  componentName,
  generateDraft,
  hasBlockingIssue,
  isStale,
  lintDraft,
  nextUpdateAt,
  paragraphsHtml,
  type Audience,
  type Phase,
  type Severity,
} from './incidentCommsLogic';

const NOW = new Date('2029-05-01T14:00:00.000Z');
const incident = (over = {}) => ({ title: 'Voice AI degraded', impact: 'major' as const, componentId: 'voice', region: null as string | null, startedAt: '2029-05-01T13:50:00.000Z', ...over });
const draft = (phase: Phase, severity: Severity = 'sev1', audience: Audience = 'status_page_and_subscribers', over = {}) =>
  generateDraft({ incident: incident(over), phase, severity, audience, now: NOW });

describe('severity matrix', () => {
  it('matches the policy: only SEV1/SEV2 email, SEV4 has no public message, cadence 30/60', () => {
    expect(allowedAudiences('sev1')).toEqual(['status_page', 'status_page_and_subscribers']);
    expect(allowedAudiences('sev2')).toEqual(['status_page', 'status_page_and_subscribers']);
    expect(allowedAudiences('sev3')).toEqual(['status_page']);
    expect(allowedAudiences('sev4')).toEqual([]);
    expect(SEVERITY_MATRIX.sev1.updateEveryMinutes).toBe(30);
    expect(SEVERITY_MATRIX.sev2.updateEveryMinutes).toBe(60);
    expect(audienceProblem('sev3', 'status_page_and_subscribers')).toBe('email_not_allowed');
    expect(audienceProblem('sev4', 'status_page')).toBe('no_public_message');
    expect(audienceProblem('sev1', 'status_page_and_subscribers')).toBeNull();
  });
  it('promises the next update only for open phases of cadenced severities', () => {
    expect(nextUpdateAt('sev1', 'investigating', NOW)?.toISOString()).toBe('2029-05-01T14:30:00.000Z');
    expect(nextUpdateAt('sev2', 'monitoring', NOW)?.toISOString()).toBe('2029-05-01T15:00:00.000Z');
    expect(nextUpdateAt('sev1', 'resolved', NOW)).toBeNull();
    expect(nextUpdateAt('sev3', 'investigating', NOW)).toBeNull();
  });
});

describe('generateDraft', () => {
  it('produces a status post and an email for every phase, and every draft passes its own lint', () => {
    for (const phase of PHASES) {
      for (const impact of ['minor', 'major'] as const) {
        for (const severity of ['sev1', 'sev2'] as const) {
          const d = draft(phase, severity, 'status_page_and_subscribers', { impact });
          expect(d.statusPostText.length).toBeGreaterThan(10);
          expect(d.emailSubject).toBeTruthy();
          const issues = lintDraft({ statusPost: d.statusPostText, emailSubject: d.emailSubject, emailBody: d.emailBody }, phase);
          expect(issues.filter((i) => i.level === 'block'), `${phase}.${impact}`).toEqual([]);
          expect(issues.filter((i) => i.code === 'no_next_update')).toEqual([]);
        }
      }
    }
  });
  it('status-page-only drafts carry no email', () => {
    const d = draft('investigating', 'sev3', 'status_page');
    expect(d.emailSubject).toBeNull();
    expect(d.emailBody).toBeNull();
    expect(d.nextUpdateAt).toBeNull();
  });
  it('uses friendly component names and never leaks the raw id or a provider', () => {
    expect(componentName('voice')).toBe('the AI receptionist');
    expect(componentName('twilio-edge-7')).toBe('part of the Vireek service');
    const d = draft('investigating', 'sev1', 'status_page_and_subscribers', { componentId: 'twilio-edge-7' });
    expect(d.statusPostText).not.toMatch(/twilio/i);
  });
  it('states the promised update time in UTC and mentions the region when present', () => {
    const d = draft('investigating', 'sev1', 'status_page', { region: 'Texas' });
    expect(d.statusPostText).toContain('14:30 UTC');
    expect(d.statusPostText).toContain('in Texas');
  });
  it('minor and major wording differ; resolved says nothing is needed unless an action is given', () => {
    expect(draft('investigating', 'sev2', 'status_page', { impact: 'minor' }).statusPostText).toContain('slower or less reliably');
    expect(draft('investigating', 'sev1', 'status_page', { impact: 'major' }).statusPostText).toContain('unavailable or badly degraded');
    expect(draft('resolved', 'sev1').statusPostText).toContain('You do not need to do anything');
    const withAction = generateDraft({ incident: incident(), phase: 'resolved', severity: 'sev1', audience: 'status_page', now: NOW, customerAction: 'Refresh the dashboard.' });
    expect(withAction.statusPostText).toContain('What you can do: Refresh the dashboard.');
  });
  it('subjects follow the phase', () => {
    expect(draft('resolved').emailSubject).toBe('Resolved: Voice AI degraded');
    expect(draft('monitoring').emailSubject).toBe('Fix applied: Voice AI degraded');
    expect(draft('investigating').emailSubject).toBe('Voice AI degraded');
  });
  it('fits the database length limits', () => {
    const d = draft('investigating', 'sev1', 'status_page_and_subscribers', { title: 'x'.repeat(400) });
    expect(d.statusPostText.length).toBeLessThanOrEqual(600);
    expect((d.emailSubject ?? '').length).toBeLessThanOrEqual(150);
  });
});

const lint = (statusPost: string, phase: Phase = 'investigating', emailBody: string | null = null) => lintDraft({ statusPost, emailBody }, phase);
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

describe('lintDraft: blocks what must never be published', () => {
  it.each([
    ['an email address', 'Write to ali@vireek.com for help. Live status', 'email_address'],
    ['a phone number', 'Call +1 (555) 123-4567 if urgent. Live status', 'phone_number'],
    ['an internal id', 'Incident 3f8f1d3e-1c1a-4a54-9a40-6c0a8f6f2b11 is open. Live status', 'identifier'],
    ['an IP address', 'Traffic from 10.2.3.4 is affected. Live status', 'ip_address'],
    ['a foreign link', 'See https://example.com/x for details. Live status', 'external_url'],
    ['a provider name', 'Our telephony provider Twilio is slow. Live status', 'provider_name'],
    ['breach wording', 'There was a breach of customer records. Live status', 'data_incident_wording'],
    ['a data-safety claim', 'No customer data was accessed. Live status', 'data_incident_wording'],
  ])('%s', (_n, text, code) => {
    const i = lint(text);
    expect(codes(i)).toContain(code);
    expect(hasBlockingIssue(i)).toBe(true);
  });
  it('checks the email too, not just the status post', () => {
    expect(codes(lint('We are investigating. Next update by 14:30 UTC.', 'investigating', 'Contact me at a@b.co'))).toContain('email_address');
  });
  it('blocks empty and over-long text', () => {
    expect(codes(lint('   '))).toContain('empty_status_post');
    expect(codes(lint('x'.repeat(601)))).toContain('status_post_too_long');
  });
  it('allows the status page URL', () => {
    expect(codes(lint('Live status: https://vireek.com/status'))).not.toContain('external_url');
  });
  it('does not mistake a clock time or a date for a phone number', () => {
    expect(codes(lint('Started 13:50 UTC on 2029-05-01. Next update by 14:30 UTC.'))).not.toContain('phone_number');
  });
});

describe('lintDraft: warnings', () => {
  it('warns on causes before resolution but not after', () => {
    expect(codes(lint('Slow due to a faulty change. Next update by 14:30 UTC.'))).toContain('speculative_cause');
    expect(codes(lint('Resolved. The cause was a configuration change.', 'resolved'))).not.toContain('speculative_cause');
  });
  it('warns on absolute promises, metrics and a missing next-update time', () => {
    expect(codes(lint('This will never happen again. Next update by 14:30 UTC.'))).toContain('absolute_promise');
    expect(codes(lint('Error rate is 12%. Next update by 14:30 UTC.'))).toContain('metric_value');
    expect(codes(lint('We are looking into it.'))).toContain('no_next_update');
    expect(codes(lint('Resolved. All good.', 'resolved'))).not.toContain('no_next_update');
  });
  it('warnings alone never block', () => {
    expect(hasBlockingIssue(lint('This will never happen again.'))).toBe(false);
  });
});

describe('isStale', () => {
  it('is stale only for an open phase whose promised time has passed and that was not posted yet', () => {
    expect(isStale('investigating', '2029-05-01T13:59:00.000Z', NOW)).toBe(true);
    expect(isStale('investigating', '2029-05-01T14:30:00.000Z', NOW)).toBe(false);
    expect(isStale('resolved', '2029-05-01T13:00:00.000Z', NOW)).toBe(false);
    expect(isStale('investigating', null, NOW)).toBe(false);
    expect(isStale('investigating', '2029-05-01T13:00:00.000Z', NOW, true)).toBe(false);
  });
});

describe('paragraphsHtml', () => {
  it('splits on blank lines, keeps single newlines and escapes HTML', () => {
    const h = paragraphsHtml('One <b>\nline two\n\nSecond', (s) => s.replace(/</g, '&lt;'));
    expect(h.match(/<p /g)).toHaveLength(2);
    expect(h).toContain('One &lt;b><br>line two');
  });
});

describe('runbook stays in sync with the code', () => {
  const doc = readFileSync('docs/runbooks/incident-comms.md', 'utf8');
  it('lists every template id', () => {
    for (const id of TEMPLATE_IDS) expect(doc, id).toContain(`\`${id}\``);
  });
  it('lists every severity row with the same cadence', () => {
    for (const s of SEVERITIES) expect(doc).toContain(`| ${SEVERITY_MATRIX[s].label} |`);
    expect(doc).toMatch(/SEV1 \|[^|]*\|[^|]*\|[^|]*15 min[^|]*\|[^|]*30 min/);
    expect(doc).toMatch(/SEV2 \|[^|]*\|[^|]*\|[^|]*30 min[^|]*\|[^|]*60 min/);
  });
});
