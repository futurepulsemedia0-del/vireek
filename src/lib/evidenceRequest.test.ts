import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_EVIDENCE_FORM,
  EVIDENCE_FORM_ENDPOINT,
  isHoneypotTripped,
  localISODate,
  submitEvidenceRequest,
  validateEvidenceRequest,
  type EvidenceFormState,
} from '@/lib/evidenceRequest';

const valid: EvidenceFormState = {
  ...EMPTY_EVIDENCE_FORM,
  fullName: ' Jane Doe ',
  email: 'jane@acme.com',
  companyName: 'Acme HVAC',
  requestTypes: ['dpa', 'questionnaire'],
  frameworks: ['soc2'],
};

describe('validateEvidenceRequest', () => {
  it('builds a trimmed payload with readable labels', () => {
    const { errors, payload } = validateEvidenceRequest(valid, '2026-10-08');
    expect(errors).toEqual({});
    expect(payload).toMatchObject({
      source: 'compliance-evidence-request',
      fullName: 'Jane Doe',
      requestTypes: 'Security questionnaire or vendor assessment; Data Processing Agreement (DPA)',
      frameworks: 'SOC 2',
    });
  });

  it('requires name, email, company and at least one request type', () => {
    const { errors, payload } = validateEvidenceRequest(EMPTY_EVIDENCE_FORM, '2026-10-08');
    expect(payload).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['companyName', 'email', 'fullName', 'requestTypes']);
  });

  it('rejects malformed email, past dates and far-future dates', () => {
    expect(validateEvidenceRequest({ ...valid, email: 'nope' }, '2026-10-08').errors.email).toBeTruthy();
    expect(validateEvidenceRequest({ ...valid, neededBy: '2026-10-07' }, '2026-10-08').errors.neededBy).toBeTruthy();
    expect(validateEvidenceRequest({ ...valid, neededBy: '2026-10-08' }, '2026-10-08').errors.neededBy).toBeUndefined();
    expect(validateEvidenceRequest({ ...valid, neededBy: '2030-01-01' }, '2026-10-08').errors.neededBy).toBeTruthy();
    expect(validateEvidenceRequest({ ...valid, neededBy: 'soon' }, '2026-10-08').errors.neededBy).toBeTruthy();
  });

  it('caps the message length and ignores unknown option ids', () => {
    expect(validateEvidenceRequest({ ...valid, message: 'x'.repeat(1501) }, '2026-10-08').errors.message).toBeTruthy();
    const forged = { ...valid, requestTypes: ['hack' as never] };
    expect(validateEvidenceRequest(forged, '2026-10-08').errors.requestTypes).toBeTruthy();
  });

  it('formats local dates and detects the honeypot', () => {
    expect(localISODate(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(isHoneypotTripped('  ')).toBe(false);
    expect(isHoneypotTripped('http://spam')).toBe(true);
  });
});

describe('submitEvidenceRequest', () => {
  const payload = validateEvidenceRequest(valid, '2026-10-08').payload!;

  it('posts JSON to the shared form endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    await expect(submitEvidenceRequest(payload, fetchMock as unknown as typeof fetch)).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(EVIDENCE_FORM_ENDPOINT);
    expect(JSON.parse(init.body).email).toBe('jane@acme.com');
  });

  it('classifies server and network failures', async () => {
    const server = vi.fn().mockResolvedValue({ ok: false });
    const network = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(submitEvidenceRequest(payload, server as unknown as typeof fetch)).resolves.toEqual({ ok: false, reason: 'server' });
    await expect(submitEvidenceRequest(payload, network as unknown as typeof fetch)).resolves.toEqual({ ok: false, reason: 'network' });
  });
});
