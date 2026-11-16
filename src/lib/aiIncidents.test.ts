import { describe, expect, it } from 'vitest';
import {
  AI_INCIDENT_OWNER_ROLES, AI_INCIDENT_SEVERITIES, AI_INCIDENT_TYPES, LIMITS, TYPE_DEFAULTS,
  awaitsNotificationDecision, closeBlockedReason, emptyDraft, filterIncidents, hasErrors, sortIncidents, summariseIncidents,
  toIncident, toInsertRow, toUpdateRow, validateDraft, type AiIncident, type AiIncidentDraft,
} from '@/lib/aiIncidents';

const NOW = new Date('2029-03-04T09:00:00'); // local time, same as datetime-local parsing

const draft = (over: Partial<AiIncidentDraft> = {}): AiIncidentDraft => ({
  ...emptyDraft(), title: 'Agent quoted a wrong price', summary: 'The agent quoted $99 instead of $199 on one call.', ...over,
});

const inc = (over: Partial<AiIncident> = {}): AiIncident => toIncident({
  id: 'i1', ref: 'AI-2029-00001', incident_type: 'wrong_diagnosis', severity: 'medium', status: 'open', title: 'T title', summary: 'S summary text',
  source: 'staff_review', owner_role: 'ai_safety_lead', call_id: null, customer_notification: 'not_assessed', regulator_notification: 'not_assessed',
  postmortem_ref: null, detected_at: '2029-03-04T08:00:00Z', contained_at: null, resolved_at: null, created_at: '2029-03-04T08:00:00Z', updated_at: '2029-03-04T08:00:00Z',
  ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), v])),
});

describe('validateDraft', () => {
  it('accepts a complete draft', () => {
    expect(validateDraft(draft(), NOW)).toEqual({});
  });
  it('requires title and summary, and enforces the same minimums as the database', () => {
    expect(validateDraft(draft({ title: '  ', summary: '' }), NOW)).toEqual({ title: 'required', summary: 'required' });
    expect(validateDraft(draft({ title: 'ab', summary: 'too short' }), NOW)).toEqual({ title: 'tooShort', summary: 'tooShort' });
  });
  it('enforces maximum lengths', () => {
    const e = validateDraft(draft({ title: 'x'.repeat(LIMITS.titleMax + 1), summary: 'y'.repeat(LIMITS.summaryMax + 1), callId: 'c'.repeat(LIMITS.callIdMax + 1) }), NOW);
    expect(e).toEqual({ title: 'tooLong', summary: 'tooLong', callId: 'tooLong' });
  });
  it('rejects e-mail addresses in free text (defence in depth, mirrors the DB trigger)', () => {
    expect(validateDraft(draft({ summary: 'Caller jane.doe+x@example.com heard another customer address.' }), NOW).summary).toBe('email');
    expect(validateDraft(draft({ title: 'Leak to bob@corp.io' }), NOW).title).toBe('email');
  });
  it('rejects a detection time in the future but allows small clock skew', () => {
    expect(validateDraft(draft({ detectedAt: '2029-03-04T10:00' }), NOW).detectedAt).toBe('future');
    expect(validateDraft(draft({ detectedAt: '2029-03-04T09:03' }), NOW).detectedAt).toBeUndefined();
    expect(validateDraft(draft({ detectedAt: '2029-03-03T09:00' }), NOW).detectedAt).toBeUndefined();
    expect(validateDraft(draft({ detectedAt: 'not-a-date' }), NOW).detectedAt).toBe('invalid');
  });
  it('hasErrors reflects the result', () => {
    expect(hasErrors({})).toBe(false);
    expect(hasErrors({ title: 'required' })).toBe(true);
  });
});

describe('payload builders', () => {
  it('toInsertRow trims, nulls an empty call id and never sends server-controlled columns', () => {
    const row = toInsertRow(draft({ title: '  Wrong price  ', callId: '  ' }));
    expect(row.title).toBe('Wrong price');
    expect(row.call_id).toBeNull();
    expect(row).not.toHaveProperty('detected_at'); // empty => database default (now)
    for (const k of ['ref', 'id', 'reported_by', 'created_at', 'updated_at', 'contained_at', 'resolved_at', 'status']) expect(row).not.toHaveProperty(k);
  });
  it('toInsertRow sends an ISO timestamp when a detection time was entered', () => {
    const row = toInsertRow(draft({ detectedAt: '2029-03-03T09:00' }));
    expect(typeof row.detected_at).toBe('string');
    expect(Number.isNaN(Date.parse(row.detected_at as string))).toBe(false);
  });
  it('toUpdateRow only includes fields that were provided and normalises the postmortem reference', () => {
    expect(toUpdateRow({ status: 'closed' })).toEqual({ status: 'closed' });
    expect(toUpdateRow({ postmortemRef: '  docs/pm/AI-1.md ' })).toEqual({ postmortem_ref: 'docs/pm/AI-1.md' });
    expect(toUpdateRow({ postmortemRef: '   ' })).toEqual({ postmortem_ref: null });
    expect(toUpdateRow({})).toEqual({});
  });
});

describe('policy defaults', () => {
  it('has a default for every incident type, using valid severities and owner roles', () => {
    for (const t of AI_INCIDENT_TYPES) {
      expect(AI_INCIDENT_SEVERITIES).toContain(TYPE_DEFAULTS[t].severity);
      expect(AI_INCIDENT_OWNER_ROLES).toContain(TYPE_DEFAULTS[t].ownerRole);
    }
  });
  it('treats a PII leak as critical, as the policy and voice runbook do', () => {
    expect(TYPE_DEFAULTS.pii_leak_on_call.severity).toBe('critical');
  });
});

describe('closeBlockedReason (mirrors the trigger)', () => {
  it('blocks closing high/critical without a postmortem', () => {
    expect(closeBlockedReason('critical', 'closed', null)).toBe('postmortem');
    expect(closeBlockedReason('high', 'closed', '   ')).toBe('postmortem');
  });
  it('allows closing with a postmortem, and low/medium without one, and non-closing statuses', () => {
    expect(closeBlockedReason('high', 'closed', 'docs/pm.md')).toBeNull();
    expect(closeBlockedReason('medium', 'closed', null)).toBeNull();
    expect(closeBlockedReason('critical', 'resolved', null)).toBeNull();
  });
});

describe('toIncident', () => {
  it('falls back to the cautious option instead of crashing on unexpected values', () => {
    const i = toIncident({ id: 'x', severity: 'catastrophic', status: 'weird', incident_type: 'nope', customer_notification: 'maybe' });
    expect(i.severity).toBe('high');
    expect(i.status).toBe('open');
    expect(i.incidentType).toBe('other');
    expect(i.customerNotification).toBe('not_assessed');
    expect(i.callId).toBeNull();
    expect(i.title).toBe('');
  });
});

describe('list helpers', () => {
  const rows = [
    inc({ id: 'a', severity: 'low', status: 'open', detectedAt: '2029-03-04T07:00:00Z' }),
    inc({ id: 'b', severity: 'critical', status: 'investigating', detectedAt: '2029-03-01T07:00:00Z' }),
    inc({ id: 'c', severity: 'critical', status: 'closed', detectedAt: '2029-03-04T08:00:00Z' }),
    inc({ id: 'd', severity: 'high', status: 'contained', detectedAt: '2029-03-04T06:00:00Z', customerNotification: 'sent', regulatorNotification: 'not_required' }),
    inc({ id: 'e', severity: 'high', status: 'open', detectedAt: '2029-03-02T06:00:00Z' }),
  ];
  it('does not mutate its input', () => {
    const before = rows.map((r) => r.id).join();
    sortIncidents(rows);
    expect(rows.map((r) => r.id).join()).toBe(before);
  });
  it('sorts active before closed, then by severity, then newest first', () => {
    // critical first; the two highs ordered by newer detection (d is newer than e)
    expect(sortIncidents(rows).map((r) => r.id)).toEqual(['b', 'd', 'e', 'a', 'c']);
  });
  it('filters by status (active hides closed) and severity', () => {
    expect(filterIncidents(rows, 'active', 'all').map((r) => r.id)).toEqual(['a', 'b', 'd', 'e']);
    expect(filterIncidents(rows, 'all', 'all')).toHaveLength(5);
    expect(filterIncidents(rows, 'closed', 'all').map((r) => r.id)).toEqual(['c']);
    expect(filterIncidents(rows, 'all', 'critical').map((r) => r.id)).toEqual(['b', 'c']);
    expect(filterIncidents(rows, 'active', 'critical').map((r) => r.id)).toEqual(['b']);
  });
  it('summarises active, critical-and-active, and awaiting-notification counts', () => {
    expect(summariseIncidents(rows)).toEqual({ active: 4, critical: 1, awaitingNotification: 2 });
  });
  it('awaiting notification: only active high/critical incidents with an undecided audience', () => {
    expect(awaitsNotificationDecision(rows[1])).toBe(true);   // critical, undecided
    expect(awaitsNotificationDecision(rows[2])).toBe(false);  // closed
    expect(awaitsNotificationDecision(rows[3])).toBe(false);  // both decided
    expect(awaitsNotificationDecision(rows[0])).toBe(false);  // low
  });
});
