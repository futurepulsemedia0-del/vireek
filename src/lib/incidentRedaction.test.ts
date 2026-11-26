import { describe, expect, it } from 'vitest';
import { AUTOMATED_REDACTION_RULES, MANUAL_REDACTION_RULES, findRedactionIssues, firstRedactionRule, redactionPreview } from '@/lib/incidentRedaction';

describe('incident redaction lint', () => {
  it.each([
    ['Contact jane.doe@example.com for details', 'email'],
    ['See https://example.com/call/123', 'url'],
    ['Visit www.example.com', 'url'],
    ['Call id 3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab', 'uuid'],
    ['Server 10.0.0.1 failed', 'ip_address'],
    ['Caller number 555 123 4567', 'phone_or_long_number'],
    ['Account 123456789', 'phone_or_long_number'],
    ['Call +49 (911) 1234567', 'phone_or_long_number'],
  ])('flags %s as %s', (text, rule) => {
    expect(firstRedactionRule(text)).toBe(rule);
  });

  it('does not flag clean text, ISO dates, versions or small numbers', () => {
    expect(findRedactionIssues('On 2026-03-14 the assistant quoted a price 3 times in 12 minutes.')).toEqual([]);
    expect(findRedactionIssues('Prompt version 4.2 was rolled back.')).toEqual([]);
  });

  it('reports every match, not only the first', () => {
    const issues = findRedactionIssues('a@b.io and c@d.io');
    expect(issues.map((i) => i.rule)).toEqual(['email', 'email']);
  });

  it('builds a preview that hides matches but keeps ISO dates', () => {
    const p = redactionPreview('On 2026-03-14 mail a@b.io or call 555 123 4567');
    expect(p).toContain('2026-03-14');
    expect(p).toContain('[email]');
    expect(p).toContain('[phone_or_long_number]');
    expect(p).not.toContain('a@b.io');
  });

  it('exposes the rule lists the UI renders', () => {
    expect(AUTOMATED_REDACTION_RULES).toEqual(['email', 'url', 'uuid', 'ip_address', 'phone_or_long_number']);
    expect(MANUAL_REDACTION_RULES.length).toBeGreaterThan(0);
  });
});
